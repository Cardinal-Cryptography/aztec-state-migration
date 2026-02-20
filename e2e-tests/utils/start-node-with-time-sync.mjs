// Starts an Aztec node with TestDateProvider that syncs to L1 time.
// This is equivalent to `aztec start --node --sequencer` but with L1 time sync
// enabled, which is needed when Anvil's time has been advanced (e.g. during
// governance flows).
//
// IMPORTANT: This uses a read-only time sync (polls L1, adjusts dateProvider
// offset) instead of AnvilTestWatcher. AnvilTestWatcher WARPS L1 time, which
// conflicts with Node 1's own watcher when both share the same Anvil instance.
//
// Must be mounted into the Docker container at /usr/src/ so that
// @aztec/* package resolution works via the yarn workspace.

import { getConfigEnvVars as getNodeConfigEnvVars } from "@aztec/aztec-node";
import { AztecNodeService } from "@aztec/aztec-node";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import { getSponsoredFPCAddress } from "@aztec/cli/cli-utils";
import {
  TestWallet,
  deployFundedSchnorrAccounts,
} from "@aztec/test-wallet/server";
import { getL1Config } from "@aztec/cli/config";
import { SecretValue } from "@aztec/foundation/config";
import { Fr } from "@aztec/foundation/curves/bn254";
import { createLogger, createConsoleLogger } from "@aztec/foundation/log";
import { TestDateProvider } from "@aztec/foundation/timer";
import { RunningPromise } from "@aztec/foundation/running-promise";
import {
  createNamespacedSafeJsonRpcServer,
  startHttpRpcServer,
} from "@aztec/foundation/json-rpc/server";
import { AztecNodeApiSchema } from "@aztec/stdlib/interfaces/client";
import { P2PApiSchema } from "@aztec/stdlib/interfaces/server";
import {
  getConfigEnvVars as getTelemetryClientConfig,
  initTelemetryClient,
} from "@aztec/telemetry-client";
import { getGenesisValues } from "@aztec/world-state/testing";
import { RollupCheatCodes } from "@aztec/ethereum/test";

const logger = createLogger("node-with-time-sync");
const userLog = createConsoleLogger();

async function main() {
  userLog(
    "Starting Aztec Node with read-only L1 time sync (TestDateProvider)...",
  );

  // Read all config from environment variables (same as start_node.js)
  const nodeConfig = getNodeConfigEnvVars();

  // Get funded accounts for genesis computation
  const testAccountsData = nodeConfig.testAccounts
    ? await getInitialTestAccountsData()
    : [];
  const testAccounts = testAccountsData.map((a) => a.address);
  const sponsoredFPCAccounts = nodeConfig.sponsoredFPC
    ? [await getSponsoredFPCAddress()]
    : [];
  const initialFundedAccounts = testAccounts.concat(sponsoredFPCAccounts);

  userLog(
    `Initial funded accounts: ${initialFundedAccounts.map((a) => a.toString()).join(", ")}`,
  );

  const { genesisArchiveRoot, prefilledPublicData } = await getGenesisValues(
    initialFundedAccounts,
  );
  userLog(`Genesis archive root: ${genesisArchiveRoot.toString()}`);

  // Get L1 config from registry
  if (
    !nodeConfig.l1Contracts.registryAddress ||
    nodeConfig.l1Contracts.registryAddress.isZero()
  ) {
    throw new Error(
      "L1 registry address is required (set REGISTRY_CONTRACT_ADDRESS)",
    );
  }

  const { addresses, config } = await getL1Config(
    nodeConfig.l1Contracts.registryAddress,
    nodeConfig.l1RpcUrls,
    nodeConfig.l1ChainId,
    nodeConfig.rollupVersion,
  );

  process.env.ROLLUP_CONTRACT_ADDRESS ??= addresses.rollupAddress.toString();

  // Verify genesis archive root matches the deployed rollup
  if (
    !Fr.fromHexString(config.genesisArchiveTreeRoot).equals(genesisArchiveRoot)
  ) {
    throw new Error(
      `Computed genesis archive root ${genesisArchiveRoot} does not match ` +
        `expected ${config.genesisArchiveTreeRoot} for rollup at ${addresses.rollupAddress}`,
    );
  }

  // Merge L1 addresses and config into node config
  nodeConfig.l1Contracts = {
    ...addresses,
    slashFactoryAddress: nodeConfig.l1Contracts.slashFactoryAddress,
  };
  Object.assign(nodeConfig, config);

  // Sequencer setup: use validator key as publisher key if not set
  if (
    (!nodeConfig.publisherPrivateKeys ||
      !nodeConfig.publisherPrivateKeys.length) &&
    nodeConfig.validatorPrivateKeys?.getValue().length
  ) {
    nodeConfig.publisherPrivateKeys = [
      new SecretValue(nodeConfig.validatorPrivateKeys.getValue()[0]),
    ];
  }

  // Bootstrap nodes config
  if (
    nodeConfig.p2pEnabled &&
    nodeConfig.bootstrapNodes &&
    typeof nodeConfig.bootstrapNodes === "string"
  ) {
    nodeConfig.bootstrapNodes = nodeConfig.bootstrapNodes.split(",");
  }

  // === Read-only time sync: poll L1 timestamp, adjust dateProvider offset ===
  // We do NOT use AnvilTestWatcher here because it warps L1 time, which conflicts
  // with Node 1's watcher when both nodes share the same Anvil instance.
  const l1RpcUrl = nodeConfig.l1RpcUrls[0];
  const dateProvider = new TestDateProvider();

  async function syncDateProviderToL1() {
    try {
      const resp = await fetch(l1RpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_getBlockByNumber",
          params: ["latest", false],
          id: 1,
        }),
      });
      const data = await resp.json();
      const l1TimeMs = parseInt(data.result.timestamp, 16) * 1000;
      const wallTime = dateProvider.now();
      if (l1TimeMs > wallTime) {
        dateProvider.setTime(l1TimeMs);
      }
    } catch {
      // Ignore errors during initial connection
    }
  }

  // Initial sync before node starts
  await syncDateProviderToL1();
  // Poll every 200ms (same interval as AnvilTestWatcher)
  const timeSyncLoop = new RunningPromise(syncDateProviderToL1, logger, 200);
  timeSyncLoop.start();
  logger.info(`Read-only L1 time sync started (no L1 warping)`);

  // Initialize telemetry
  const telemetry = await initTelemetryClient(getTelemetryClientConfig());

  // Create the Aztec node with dateProvider injected
  const node = await AztecNodeService.createAndSync(
    nodeConfig,
    { telemetry, dateProvider },
    { prefilledPublicData },
  );

  logger.info("Aztec Node started successfully with time sync enabled");

  // Deploy funded test accounts (same as --local-network does)
  if (testAccountsData.length) {
    const wallet = await TestWallet.create(node);
    userLog("Deploying funded test accounts...");
    await deployFundedSchnorrAccounts(wallet, node, testAccountsData);
    userLog("Test accounts deployed.");
    await wallet.stop();
  }

  // === Auto-prove blocks: mark pending checkpoints as proven ===
  // Without a prover component, blocks are proposed but never proven.
  // This loop periodically marks the latest pending checkpoint as proven
  // by writing directly to the rollup contract's storage on Anvil.
  const rollupCheatCodes = RollupCheatCodes.create(
    nodeConfig.l1RpcUrls,
    { rollupAddress: addresses.rollupAddress },
    dateProvider,
  );

  const autoProveLoop = new RunningPromise(
    async () => {
      try {
        await rollupCheatCodes.markAsProven();
        // Mine an L1 block so the archiver picks up L1 events (including L1->L2 messages).
        // Without periodic mining, the archiver stalls on Anvil since no new blocks appear.
        await fetch(l1RpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "anvil_mine",
            params: ["0x1"],
            id: 1,
          }),
        });
      } catch {
        /* ignore */
      }
    },
    logger,
    500,
  );
  autoProveLoop.start();

  // Set up HTTP RPC server (same as aztec_start_action.js)
  const services = {
    node: [node, AztecNodeApiSchema],
    p2p: [node.getP2P(), P2PApiSchema],
  };

  const rpcServer = createNamespacedSafeJsonRpcServer(services, {
    http200OnError: false,
    log: logger,
  });

  const port = parseInt(process.env.AZTEC_PORT || process.env.PORT || "8080");
  await startHttpRpcServer(rpcServer, { port });
  logger.info(`Aztec Server listening on port ${port}`);

  // Handle shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    await node.stop();
    await timeSyncLoop.stop();
    await autoProveLoop.stop();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error(`Fatal error: ${err}\n${err.stack}`);
  process.exit(1);
});
