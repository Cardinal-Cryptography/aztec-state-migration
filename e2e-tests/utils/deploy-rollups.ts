// Deploys L1 contracts for both rollups on an already-running Anvil instance.
// Usage: npx tsx e2e-tests/utils/deploy-rollups.ts
//
// Expects Anvil to be running on L1_RPC_URL (default http://localhost:8545).
// Outputs: writes dual-rollups-deployment.json with all addresses.

import {
  deployAztecL1Contracts,
  deployRollupForUpgrade,
} from "@aztec/ethereum/deploy-aztec-l1-contracts";
import { getL1ContractsConfigEnvVars } from "@aztec/ethereum/config";
import { getVKTreeRoot } from "@aztec/noir-protocol-circuits-types/vk-tree";
import { protocolContractsHash } from "@aztec/protocol-contracts";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import { getSponsoredFPCAddress } from "@aztec/cli/cli-utils";
import { getGenesisValues } from "@aztec/world-state/testing";
import { EthAddress } from "@aztec/foundation/eth-address";
import { createLogger, createConsoleLogger } from "@aztec/foundation/log";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  type Address,
} from "viem";
import { foundry } from "viem/chains";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { RegistryAbi, GSEAbi } from "@aztec/l1-artifacts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = createLogger("deploy-rollups");
const userLog = createConsoleLogger();

// Anvil default accounts
const PRIVATE_KEY_0: Hex =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PRIVATE_KEY_1: Hex =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const L1_RPC_URL = process.env.L1_RPC_URL || "http://localhost:8545";
const L1_CHAIN_ID = parseInt(process.env.L1_CHAIN_ID || "31337");

const DEPLOYMENT_FILE = join(__dirname, "dual-rollups-deployment.json");

async function main() {
  userLog("=== Deploying L1 contracts for both rollups ===");

  // --- 1. Compute genesis values ---
  userLog("Computing genesis values...");
  const testAccountsData = await getInitialTestAccountsData();
  const testAccounts = testAccountsData.map((a) => a.address);
  const sponsoredFPC = await getSponsoredFPCAddress();
  const fundedAddresses = [...testAccounts, sponsoredFPC];
  const { genesisArchiveRoot, fundingNeeded } =
    await getGenesisValues(fundedAddresses);

  userLog(`Genesis archive root: ${genesisArchiveRoot.toString()}`);
  userLog(`Funded accounts: ${fundedAddresses.length}`);

  // --- 2. Deploy full L1 infrastructure + Rollup 1 ---
  userLog("\n=== Deploying L1 contracts + Rollup 1 ===");

  const l1ContractsConfig = getL1ContractsConfigEnvVars();

  const rollup1Result = await deployAztecL1Contracts(
    L1_RPC_URL,
    PRIVATE_KEY_0,
    L1_CHAIN_ID,
    {
      ...l1ContractsConfig,
      vkTreeRoot: getVKTreeRoot(),
      protocolContractsHash,
      genesisArchiveRoot,
      feeJuicePortalInitialBalance: fundingNeeded,
      aztecTargetCommitteeSize: 0,
      slasherFlavor: "none",
      realVerifier: false,
    },
  );

  const addresses = rollup1Result.l1ContractAddresses;
  const rollup1Version = rollup1Result.rollupVersion;

  userLog(`Rollup 1 deployed:`);
  userLog(`  Address:    ${addresses.rollupAddress.toString()}`);
  userLog(`  Version:    ${rollup1Version}`);
  userLog(`  Registry:   ${addresses.registryAddress.toString()}`);
  userLog(`  Governance: ${addresses.governanceAddress.toString()}`);

  // --- 3. Deploy Rollup 2 ---
  userLog("\n=== Deploying Rollup 2 ===");

  // Use a DIFFERENT deployer key (account #1) to avoid CREATE nonce collisions
  // with contracts deployed by account #0 during Rollup 1 deployment.
  // Use different aztecEpochDuration so Rollup 2 gets a distinct version hash
  // (version = uint32(keccak256(config, genesisState))).
  const rollup2Result = await deployRollupForUpgrade(
    PRIVATE_KEY_1,
    L1_RPC_URL,
    L1_CHAIN_ID,
    addresses.registryAddress,
    {
      ...l1ContractsConfig,
      vkTreeRoot: getVKTreeRoot(),
      protocolContractsHash,
      genesisArchiveRoot,
      feeJuicePortalInitialBalance: fundingNeeded,
      aztecTargetCommitteeSize: 0,
      aztecEpochDuration: l1ContractsConfig.aztecEpochDuration + 1,
      slasherFlavor: "none",
      realVerifier: false,
    },
  );

  const rollup2Address = rollup2Result.rollup.address;
  const rollup2Version = await rollup2Result.rollup.getVersion();

  userLog(`Rollup 2 deployed:`);
  userLog(`  Address: ${rollup2Address.toString()}`);
  userLog(`  Version: ${rollup2Version}`);

  // --- 4. Register Rollup 2 in Registry + GSE via Anvil impersonation ---
  userLog("\n=== Registering Rollup 2 ===");

  const publicClient = createPublicClient({
    chain: foundry,
    transport: http(L1_RPC_URL),
  });
  const walletClient = createWalletClient({
    chain: foundry,
    transport: http(L1_RPC_URL),
  });

  // Read Registry owner (should be Governance)
  const registryOwner = (await publicClient.readContract({
    address: addresses.registryAddress.toString() as Address,
    abi: RegistryAbi,
    functionName: "owner",
  })) as Address;
  userLog(`Registry owner: ${registryOwner}`);

  // Impersonate the owner and call addRollup
  await walletClient.request({
    method: "anvil_setBalance" as any,
    params: [registryOwner, "0x56BC75E2D63100000" as Hex],
  });
  await walletClient.request({
    method: "anvil_impersonateAccount" as any,
    params: [registryOwner],
  });

  const addRollupHash = await walletClient.writeContract({
    address: addresses.registryAddress.toString() as Address,
    abi: RegistryAbi,
    functionName: "addRollup",
    args: [rollup2Address.toString() as Address],
    account: registryOwner,
    chain: foundry,
  });
  const addRollupReceipt = await publicClient.waitForTransactionReceipt({
    hash: addRollupHash,
  });
  if (addRollupReceipt.status !== "success") {
    throw new Error(`Registry.addRollup() reverted (tx: ${addRollupHash})`);
  }
  userLog(`Registry.addRollup() succeeded (tx: ${addRollupHash})`);

  // Register with GSE if available
  if (addresses.gseAddress && !addresses.gseAddress.isZero()) {
    const gseOwner = (await publicClient.readContract({
      address: addresses.gseAddress.toString() as Address,
      abi: GSEAbi,
      functionName: "owner",
    })) as Address;

    if (gseOwner !== registryOwner) {
      // Different owner — impersonate separately
      await walletClient.request({
        method: "anvil_stopImpersonatingAccount" as any,
        params: [registryOwner],
      });
      await walletClient.request({
        method: "anvil_setBalance" as any,
        params: [gseOwner, "0x56BC75E2D63100000" as Hex],
      });
      await walletClient.request({
        method: "anvil_impersonateAccount" as any,
        params: [gseOwner],
      });
    }

    const gseAddRollupHash = await walletClient.writeContract({
      address: addresses.gseAddress.toString() as Address,
      abi: GSEAbi,
      functionName: "addRollup",
      args: [rollup2Address.toString() as Address],
      account: gseOwner,
      chain: foundry,
    });
    const gseReceipt = await publicClient.waitForTransactionReceipt({
      hash: gseAddRollupHash,
    });
    if (gseReceipt.status !== "success") {
      throw new Error(`GSE.addRollup() reverted (tx: ${gseAddRollupHash})`);
    }
    userLog(`GSE.addRollup() succeeded (tx: ${gseAddRollupHash})`);

    await walletClient.request({
      method: "anvil_stopImpersonatingAccount" as any,
      params: [gseOwner !== registryOwner ? gseOwner : registryOwner],
    });
  } else {
    await walletClient.request({
      method: "anvil_stopImpersonatingAccount" as any,
      params: [registryOwner],
    });
  }

  // --- 5. Verify registration ---
  userLog("\n=== Verifying registration ===");

  const numVersions = (await publicClient.readContract({
    address: addresses.registryAddress.toString() as Address,
    abi: RegistryAbi,
    functionName: "numberOfVersions",
  })) as bigint;

  const canonicalRollup = (await publicClient.readContract({
    address: addresses.registryAddress.toString() as Address,
    abi: RegistryAbi,
    functionName: "getCanonicalRollup",
  })) as Address;

  userLog(`Number of versions: ${numVersions}`);
  userLog(`Canonical rollup:   ${canonicalRollup}`);

  if (numVersions < 2n) {
    throw new Error(`Expected at least 2 rollup versions, got ${numVersions}`);
  }

  // --- 6. Write deployment info ---
  const deployment = {
    l1RpcUrl: L1_RPC_URL,
    l1ChainId: L1_CHAIN_ID,
    registryAddress: addresses.registryAddress.toString(),
    governanceAddress: addresses.governanceAddress.toString(),
    gseAddress: addresses.gseAddress?.toString() ?? "",
    feeJuiceAddress: addresses.feeJuiceAddress.toString(),
    stakingAssetAddress: addresses.stakingAssetAddress.toString(),
    feeJuicePortalAddress: addresses.feeJuicePortalAddress.toString(),
    feeAssetHandlerAddress: addresses.feeAssetHandlerAddress?.toString() ?? "",
    rewardDistributorAddress: addresses.rewardDistributorAddress.toString(),
    rollup1: {
      address: addresses.rollupAddress.toString(),
      version: rollup1Version,
    },
    rollup2: {
      address: rollup2Address.toString(),
      version: Number(rollup2Version),
      slashFactoryAddress: rollup2Result.slashFactoryAddress,
    },
    node1Port: 8080,
    node2Port: 8081,
  };

  writeFileSync(DEPLOYMENT_FILE, JSON.stringify(deployment, null, 2));
  userLog(`\nDeployment info saved to ${DEPLOYMENT_FILE}`);

  userLog("\n=== All L1 contracts deployed successfully ===");
}

main().catch((err) => {
  logger.error(`Fatal error: ${err}\n${err.stack}`);
  process.exit(1);
});
