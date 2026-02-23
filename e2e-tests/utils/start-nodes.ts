// Starts both Aztec nodes for the dual-rollup setup.
// Reads deployment info from dual-rollups-deployment.json (written by deploy-rollups.ts).
// Both nodes share a single TestDateProvider that syncs to L1 time.
//
// Usage: npx tsx e2e-tests/utils/start-nodes.ts

import {
  AztecNodeService,
  getConfigEnvVars as getNodeConfigEnvVars,
} from "@aztec/aztec-node";
import { type AztecNodeConfig } from "@aztec/aztec-node/config";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import { getSponsoredFPCAddress } from "@aztec/cli/cli-utils";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { getL1Config } from "@aztec/cli/config";
import { Fr } from "@aztec/foundation/curves/bn254";
import { EthAddress } from "@aztec/foundation/eth-address";
import { createLogger, createConsoleLogger } from "@aztec/foundation/log";
import { TestDateProvider } from "@aztec/foundation/timer";
import { RunningPromise } from "@aztec/foundation/running-promise";
import {
  type ApiHandler,
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
import { deployFundedSchnorrAccounts } from "@aztec/wallets/testing";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = createLogger("start-nodes");
const userLog = createConsoleLogger();

// Anvil default accounts (deployer keys for sequencer/validator)
const SEQ_KEY_NODE1 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SEQ_KEY_NODE2 =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

interface DeploymentInfo {
  l1RpcUrl: string;
  l1ChainId: number;
  registryAddress: string;
  governanceAddress: string;
  gseAddress: string;
  feeJuiceAddress: string;
  stakingAssetAddress: string;
  feeJuicePortalAddress: string;
  feeAssetHandlerAddress: string;
  rewardDistributorAddress: string;
  rollup1: { address: string; version: number };
  rollup2: { address: string; version: number; slashFactoryAddress: string };
  node1Port: number;
  node2Port: number;
}

async function main() {
  userLog("=== Starting both Aztec nodes ===");

  // --- Read deployment info ---
  const deploymentFile = join(__dirname, "dual-rollups-deployment.json");
  const deployment: DeploymentInfo = JSON.parse(
    readFileSync(deploymentFile, "utf-8"),
  );
  userLog(`Loaded deployment info from ${deploymentFile}`);
  userLog(
    `  Rollup 1: ${deployment.rollup1.address} (v${deployment.rollup1.version})`,
  );
  userLog(
    `  Rollup 2: ${deployment.rollup2.address} (v${deployment.rollup2.version})`,
  );

  const l1RpcUrl = deployment.l1RpcUrl;

  // --- Compute genesis values (same accounts for both nodes) ---
  const testAccountsData = await getInitialTestAccountsData();
  const testAccounts = testAccountsData.map((a) => a.address);
  const sponsoredFPC = await getSponsoredFPCAddress();
  const fundedAddresses = [...testAccounts, sponsoredFPC];
  const { genesisArchiveRoot, prefilledPublicData } =
    await getGenesisValues(fundedAddresses);
  userLog(`Genesis archive root: ${genesisArchiveRoot.toString()}`);

  // --- Shared TestDateProvider (syncs to L1 time) ---
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
      const data = (await resp.json()) as any;
      const l1TimeMs = parseInt(data.result.timestamp, 16) * 1000;
      if (l1TimeMs > dateProvider.now()) {
        dateProvider.setTime(l1TimeMs);
      }
    } catch {
      // Ignore errors during initial connection
    }
  }

  await syncDateProviderToL1();
  const timeSyncLoop = new RunningPromise(syncDateProviderToL1, logger, 200);
  timeSyncLoop.start();
  userLog("L1 time sync started");

  // --- Initialize telemetry ---
  const telemetry = await initTelemetryClient(getTelemetryClientConfig());

  // --- Helper: create and start a node ---
  async function startNode(
    rollupVersion: number,
    rollupAddress: string,
    port: number,
    seqKey: string,
    label: string,
  ): Promise<{
    node: AztecNodeService;
    autoProveLoop: RunningPromise;
  }> {
    userLog(
      `\n--- Starting ${label} (port ${port}, rollup v${rollupVersion}) ---`,
    );

    // Get L1 config from registry for this specific rollup version
    const { addresses, config } = await getL1Config(
      EthAddress.fromString(deployment.registryAddress),
      [l1RpcUrl],
      deployment.l1ChainId,
      rollupVersion,
    );

    // Verify genesis archive root matches
    if (
      !Fr.fromHexString(config.genesisArchiveTreeRoot).equals(
        genesisArchiveRoot,
      )
    ) {
      throw new Error(
        `Genesis archive root mismatch for ${label}: ` +
          `computed ${genesisArchiveRoot}, expected ${config.genesisArchiveTreeRoot}`,
      );
    }

    // Set sequencer/validator keys BEFORE getNodeConfigEnvVars() so the
    // config picks them up (SecretValue fields are read from env vars).
    process.env.SEQ_PUBLISHER_PRIVATE_KEY = seqKey;
    process.env.VALIDATOR_PRIVATE_KEY = seqKey;

    // Build node config
    // Spread `config` first, then override with our explicit values
    const nodeConfig: AztecNodeConfig = {
      ...getNodeConfigEnvVars(),
      ...config,
      l1RpcUrls: [l1RpcUrl],
      l1ChainId: deployment.l1ChainId,
      l1Contracts: {
        ...addresses,
        slashFactoryAddress: EthAddress.ZERO,
        feeAssetHandlerAddress: deployment.feeAssetHandlerAddress
          ? EthAddress.fromString(deployment.feeAssetHandlerAddress)
          : undefined,
      },
      rollupVersion,
      p2pEnabled: false,
      realProofs: false,
      testAccounts: true,
      sponsoredFPC: true,
    };

    const node = await AztecNodeService.createAndSync(
      nodeConfig,
      { telemetry, dateProvider },
      { prefilledPublicData },
    );
    userLog(`${label} synced`);

    // Start auto-prove loop BEFORE deploying test accounts so that L1 blocks
    // keep being mined (advancing time) while account deployment txs are
    // processed. Without this, the sequencer can stall waiting for the next
    // valid slot timestamp.
    const rollupCheatCodes = RollupCheatCodes.create(
      [l1RpcUrl],
      { rollupAddress: EthAddress.fromString(rollupAddress) },
      dateProvider,
    );

    const autoProveLoop = new RunningPromise(
      async () => {
        try {
          await rollupCheatCodes.markAsProven();
          // Mine an L1 block so the archiver picks up events
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

    // Deploy test accounts (auto-prove loop is already running, keeping L1
    // time advancing so the sequencer can find valid slots for new blocks)
    if (testAccountsData.length) {
      const wallet = await EmbeddedWallet.create(node, { ephemeral: true });
      userLog(`Deploying test accounts for ${label}...`);
      await deployFundedSchnorrAccounts(wallet, testAccountsData);
      userLog(`Test accounts deployed for ${label}`);
      await wallet.stop();
    }

    // Start RPC server
    const services: Record<string, ApiHandler> = {
      node: [node, AztecNodeApiSchema],
      p2p: [node.getP2P(), P2PApiSchema],
    };

    const rpcServer = createNamespacedSafeJsonRpcServer(services, {
      http200OnError: false,
      log: logger,
    });

    await startHttpRpcServer(rpcServer, { port });
    userLog(`${label} listening on port ${port}`);

    return { node, autoProveLoop };
  }

  // --- Start Node 1 ---
  const node1 = await startNode(
    deployment.rollup1.version,
    deployment.rollup1.address,
    deployment.node1Port,
    SEQ_KEY_NODE1,
    "Node 1",
  );

  // --- Start Node 2 ---
  const node2 = await startNode(
    deployment.rollup2.version,
    deployment.rollup2.address,
    deployment.node2Port,
    SEQ_KEY_NODE2,
    "Node 2",
  );

  userLog("\n=== Both nodes started successfully ===");
  userLog(
    `Node 1: http://localhost:${deployment.node1Port} (Rollup v${deployment.rollup1.version})`,
  );
  userLog(
    `Node 2: http://localhost:${deployment.node2Port} (Rollup v${deployment.rollup2.version})`,
  );

  // --- Graceful shutdown ---
  const shutdown = async () => {
    userLog("\nShutting down...");
    await node1.autoProveLoop.stop();
    await node2.autoProveLoop.stop();
    await node1.node.stop();
    await node2.node.stop();
    await timeSyncLoop.stop();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error(`Fatal error: ${err}\n${err.stack}`);
  process.exit(1);
});
