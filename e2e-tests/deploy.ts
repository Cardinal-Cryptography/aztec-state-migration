import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  publicActions,
  parseAbi,
  Hex,
  encodeAbiParameters,
} from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getPXEConfig } from "@aztec/pxe/server";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import type { DeploymentResult } from "./deploy-types.js";
import { NodeMigrationEmbeddedWallet } from "aztec-state-migration/wallet";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Configuration
// ============================================================
const AZTEC_OLD_URL = process.env.AZTEC_OLD_URL ?? "http://localhost:8080";
const AZTEC_NEW_URL = process.env.AZTEC_NEW_URL ?? "http://localhost:8081";
const ETHEREUM_RPC_URL =
  process.env.ETHEREUM_RPC_URL ?? "http://localhost:8545";
const ANVIL_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// ============================================================
// L1 ABIs (exported for event parsing in tests)
// ============================================================
export const L1MigratorAbi = parseAbi([
  "constructor(address _registry, address _poseidon2)",
  "function migrateArchiveRoot(uint256 oldVersion, (bytes32 actor, uint256 version) l2Migrator) external returns (bytes32 leaf, uint256 leafIndex)",
  "function getArchiveInfo(uint256 version) external view returns (bytes32 archiveRoot, uint256 provenCheckpointNumber)",
  "function REGISTRY() external view returns (address)",
  "function POSEIDON2() external view returns (address)",
  "function SECRET_HASH_FOR_ZERO() external view returns (bytes32)",
  "event ArchiveRootMigrated(uint256 indexed oldVersion, uint256 indexed newVersion, bytes32 indexed l2Migrator, bytes32 archiveRoot, uint256 provenCheckpointNumber, bytes32 messageLeaf, uint256 messageLeafIndex)",
]);

export const InboxAbi = parseAbi([
  "event MessageSent(uint256 indexed checkpointNumber, uint256 index, bytes32 indexed hash, bytes16 rollingHash)",
]);

// ============================================================
// Bytecode loaders
// ============================================================
function loadL1MigratorBytecode(): Hex {
  const artifactPath = join(
    __dirname,
    "../solidity/target/Migrator.sol/Migrator.json",
  );
  const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
  return artifact.bytecode.object as Hex;
}

function loadPoseidon2Bytecode(): Hex {
  const artifactPath = join(
    __dirname,
    "../solidity/target/Poseidon2Yul.sol/Poseidon2Yul_BN254.json",
  );
  const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
  return artifact.bytecode.object as Hex;
}

// ============================================================
// Deploy shared infrastructure (L1 contracts, wallets, accounts)
// ============================================================
export async function deploy(): Promise<DeploymentResult> {
  console.log("=== Deploying Migration Infrastructure ===\n");

  // ---- Step 1: Setup clients ----
  console.log("1. Setting up clients...");
  const aztecOldNode = createAztecNodeClient(AZTEC_OLD_URL);
  const aztecNewNode = createAztecNodeClient(AZTEC_NEW_URL);
  const l1Contracts = await aztecNewNode.getL1ContractAddresses();
  const registryAddress = l1Contracts.registryAddress;
  const newInboxAddress = l1Contracts.inboxAddress;
  const oldRollupVersion = await aztecOldNode.getVersion();
  const newRollupVersion = await aztecNewNode.getVersion();
  const l1ChainId = getPXEConfig().l1ChainId;

  console.log(`   Chain ID: ${l1ChainId}`);
  console.log(`   Old Rollup Version: ${oldRollupVersion}`);
  console.log(`   New Rollup Version: ${newRollupVersion}`);
  console.log(`   Registry: ${registryAddress}`);

  // Setup wallets
  const oldDeployerWallet = await EmbeddedWallet.create(aztecOldNode, {
    ephemeral: true,
  });
  const newDeployerWallet = await EmbeddedWallet.create(aztecNewNode, {
    ephemeral: true,
  });

  // Register test accounts
  console.log("   Registering test accounts...");
  const testAccountsData = await getInitialTestAccountsData();

  const oldDeployerManager = await oldDeployerWallet.createSchnorrAccount(
    testAccountsData[0].secret,
    testAccountsData[0].salt,
    testAccountsData[0].signingKey,
  );

  const newDeployerManager = await newDeployerWallet.createSchnorrAccount(
    testAccountsData[0].secret,
    testAccountsData[0].salt,
    testAccountsData[0].signingKey,
  );

  console.log(`   Old Deployer: ${oldDeployerManager.address}`);
  console.log(`   New Deployer: ${newDeployerManager.address}`);

  // Setup Ethereum client
  const ethAccount = privateKeyToAccount(ANVIL_PRIVATE_KEY);
  const publicClient = createPublicClient({
    chain: foundry,
    transport: http(ETHEREUM_RPC_URL),
  });
  const l1WalletClient = createWalletClient({
    account: ethAccount,
    chain: foundry,
    transport: http(ETHEREUM_RPC_URL),
  });
  // Extended client for L1FeeJuicePortalManager (cast needed due to duplicate viem types)
  const l1ExtendedClient = createWalletClient({
    account: ethAccount,
    chain: foundry,
    transport: fallback([http(ETHEREUM_RPC_URL)]),
  }).extend(publicActions) as any;
  console.log(`   Ethereum account: ${ethAccount.address}\n`);

  // ---- Step 2: Deploy Poseidon2 on L1 ----
  console.log("2. Deploying Poseidon2 on L1...");
  const poseidon2Bytecode = loadPoseidon2Bytecode();
  const poseidon2DeployTxHash = await l1WalletClient.sendTransaction({
    data: poseidon2Bytecode,
  });
  const poseidon2Receipt = await publicClient.waitForTransactionReceipt({
    hash: poseidon2DeployTxHash,
  });
  if (
    poseidon2Receipt.status === "reverted" ||
    !poseidon2Receipt.contractAddress
  ) {
    throw new Error("Poseidon2 deployment failed");
  }
  const poseidon2Address = poseidon2Receipt.contractAddress;
  console.log(`   Poseidon2: ${poseidon2Address}\n`);

  // ---- Step 3: Deploy L1 Migrator ----
  console.log("3. Deploying L1 Migrator...");
  const l1MigratorBytecode = loadL1MigratorBytecode();
  const constructorArgs = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }],
    [registryAddress.toString() as Hex, poseidon2Address],
  );
  const l1MigratorDeployTxHash = await l1WalletClient.sendTransaction({
    data: (l1MigratorBytecode + constructorArgs.slice(2)) as Hex,
  });
  const l1MigratorReceipt = await publicClient.waitForTransactionReceipt({
    hash: l1MigratorDeployTxHash,
  });
  if (
    l1MigratorReceipt.status === "reverted" ||
    !l1MigratorReceipt.contractAddress
  ) {
    throw new Error("L1 Migrator deployment failed");
  }
  const l1MigratorAddress = l1MigratorReceipt.contractAddress;
  console.log(`   L1 Migrator: ${l1MigratorAddress}\n`);

  console.log("=== Infrastructure Deployment Complete ===\n");

  let oldMigrationWallet = await NodeMigrationEmbeddedWallet.create(
    aztecOldNode,
    { ephemeral: true },
  );
  let newMigrationWallet = await NodeMigrationEmbeddedWallet.create(
    aztecNewNode,
    { ephemeral: true },
  );

  return {
    [oldRollupVersion]: {
      aztecNode: aztecOldNode,
      deployerWallet: oldDeployerWallet,
      deployerManager: oldDeployerManager,
      migrationWallet: oldMigrationWallet,
      inboxAddress: (
        await aztecOldNode.getL1ContractAddresses()
      ).inboxAddress.toString(),
    },
    [newRollupVersion]: {
      aztecNode: aztecNewNode,
      deployerWallet: newDeployerWallet,
      deployerManager: newDeployerManager,
      migrationWallet: newMigrationWallet,
      inboxAddress: newInboxAddress.toString(),
    },
    poseidon2Address,
    l1MigratorAddress,
    oldRollupVersion,
    newRollupVersion,
    publicClient,
    l1WalletClient,
    l1ExtendedClient,
  };
}

// Allow running standalone: npx tsx e2e-tests/deploy.ts
const isMain = process.argv[1]?.includes("deploy.ts");
if (isMain) {
  deploy()
    .then((result) => {
      console.log("Deployment result:");
      console.log(`  L1 Migrator: ${result.l1MigratorAddress}`);
    })
    .catch((e) => {
      console.error("Deploy failed:", e);
      process.exit(1);
    });
}
