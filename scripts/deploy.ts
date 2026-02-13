import { TestWallet } from "@aztec/test-wallet/server";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  Hex,
  encodeAbiParameters,
} from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ExampleMigrationAppContract } from "../noir/target/artifacts/ExampleMigrationApp.js";
import { MigratorModeAContract } from "../noir/target/artifacts/MigratorModeA.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { EthAddress } from "@aztec/foundation/eth-address";
import { getPXEConfig } from "@aztec/pxe/server";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import type { DeploymentResult } from "./deploy-types.js";

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
// Deploy all contracts (phases 1-5)
// ============================================================
export async function deploy(): Promise<DeploymentResult> {
  console.log("=== Deploying Migration Contracts ===\n");

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
  const oldRollupWallet = await TestWallet.create(aztecOldNode);
  const newRollupWallet = await TestWallet.create(aztecNewNode);

  // Register test accounts
  console.log("   Registering test accounts...");
  const testAccountsData = await getInitialTestAccountsData();

  const oldDeployerManager = await oldRollupWallet.createSchnorrAccount(
    testAccountsData[0].secret,
    testAccountsData[0].salt,
    testAccountsData[0].signingKey,
  );
  const oldUserManager = await oldRollupWallet.createSchnorrAccount(
    testAccountsData[1].secret,
    testAccountsData[1].salt,
    testAccountsData[1].signingKey,
  );
  const oldDeployer = oldDeployerManager.address;
  const oldRollupUser = oldUserManager.address;
  const oldDeployerWallet = oldRollupWallet;

  const newDeployerManager = await newRollupWallet.createSchnorrAccount(
    testAccountsData[0].secret,
    testAccountsData[0].salt,
    testAccountsData[0].signingKey,
  );
  const _newUserManager = await newRollupWallet.createSchnorrAccount(
    testAccountsData[1].secret,
    testAccountsData[1].salt,
    testAccountsData[1].signingKey,
  );
  const newDeployer = newDeployerManager.address;
  const newRollupUser = _newUserManager.address;
  const newDeployerWallet = newRollupWallet;

  console.log(`   Old Deployer: ${oldDeployer}`);
  console.log(`   Old User: ${oldRollupUser}`);
  console.log(`   New Deployer: ${newDeployer}`);
  console.log(`   New User: ${newRollupUser}`);

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

  // ---- Step 4: Deploy OLD rollup L2 contracts ----
  console.log("4. Deploying OLD rollup L2 contracts...");

  const oldApp = await ExampleMigrationAppContract.deploy(oldDeployerWallet, {
    _is_some: false,
    _value: AztecAddress.ZERO,
  })
    .send({ from: oldDeployer })
    .deployed();
  console.log(`   old_example_app: ${oldApp.address}\n`);

  // ---- Step 5: Deploy NEW rollup L2 contracts ----
  console.log("5. Deploying NEW rollup L2 contracts...");
  const newMigrator = await MigratorModeAContract.deploy(
    newDeployerWallet,
    EthAddress.fromString(l1MigratorAddress),
    oldRollupVersion,
  )
    .send({ from: newDeployer })
    .deployed();
  console.log(`   new_migrator: ${newMigrator.address}`);

  const newApp = await ExampleMigrationAppContract.deploy(newDeployerWallet, {
    _is_some: true,
    _value: oldApp.address,
  })
    .send({ from: newDeployer })
    .deployed();
  console.log(`   new_example_app: ${newApp.address}\n`);

  console.log("=== Deployment Complete ===\n");

  return {
    poseidon2Address,
    l1MigratorAddress,
    oldApp,
    newMigrator,
    newApp,
    oldRollupVersion,
    newRollupVersion,
    aztecOldNode,
    aztecNewNode,
    oldRollupWallet,
    newRollupWallet,
    oldDeployer,
    oldRollupUser,
    newDeployer,
    newRollupUser,
    publicClient,
    l1WalletClient,
    newInboxAddress: newInboxAddress.toString(),
  };
}

// Allow running standalone: npx tsx scripts/deploy.ts
const isMain = process.argv[1]?.includes("deploy.ts");
if (isMain) {
  deploy()
    .then((result) => {
      console.log("Deployment result:");
      console.log(`  L1 Migrator: ${result.l1MigratorAddress}`);
      console.log(`  Old App: ${result.oldApp.address}`);
      console.log(`  New Migrator: ${result.newMigrator.address}`);
      console.log(`  New App: ${result.newApp.address}`);
    })
    .catch((e) => {
      console.error("Deploy failed:", e);
      process.exit(1);
    });
}
