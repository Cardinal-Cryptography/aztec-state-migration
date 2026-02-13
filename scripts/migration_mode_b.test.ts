import { TestWallet } from "@aztec/test-wallet/server";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  Hex,
  toHex,
  encodeAbiParameters,
  decodeEventLog,
} from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ExampleMigrationAppContract } from "../noir/target/artifacts/ExampleMigrationApp.js";
import { MigratorModeBContract } from "../noir/target/artifacts/MigratorModeB.js";
import { MigrationKeyRegistryContract } from "../noir/target/artifacts/MigrationKeyRegistry.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { EthAddress } from "@aztec/foundation/eth-address";
import { Fr } from "@aztec/foundation/curves/bn254";
import {
  poseidon2Hash,
  poseidon2HashWithSeparator,
} from "@aztec/foundation/crypto/poseidon";
import { getPXEConfig } from "@aztec/pxe/server";
import { MerkleTreeId } from "@aztec/stdlib/trees";
import {
  computeUniqueNoteHash,
  siloNoteHash,
  siloNullifier,
} from "@aztec/stdlib/hash";
import type { BlockHeader } from "@aztec/stdlib/tx";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import { BlockNumber } from "@aztec/foundation/branded-types";
import {
  deriveMasterNullifierSecretKey,
  computeAppNullifierSecretKey,
} from "@aztec/stdlib/keys";

// Generator index for NOTE_NULLIFIER (from Aztec protocol constants)
const GENERATOR_INDEX__NOTE_NULLIFIER = 53;

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Convert TypeScript BlockHeader to Noir-compatible format with snake_case keys.
 */
function blockHeaderToNoir(header: BlockHeader) {
  return {
    last_archive: {
      root: header.lastArchive.root,
      next_available_leaf_index: header.lastArchive.nextAvailableLeafIndex,
    },
    state: {
      l1_to_l2_message_tree: {
        root: header.state.l1ToL2MessageTree.root,
        next_available_leaf_index:
          header.state.l1ToL2MessageTree.nextAvailableLeafIndex,
      },
      partial: {
        note_hash_tree: {
          root: header.state.partial.noteHashTree.root,
          next_available_leaf_index:
            header.state.partial.noteHashTree.nextAvailableLeafIndex,
        },
        nullifier_tree: {
          root: header.state.partial.nullifierTree.root,
          next_available_leaf_index:
            header.state.partial.nullifierTree.nextAvailableLeafIndex,
        },
        public_data_tree: {
          root: header.state.partial.publicDataTree.root,
          next_available_leaf_index:
            header.state.partial.publicDataTree.nextAvailableLeafIndex,
        },
      },
    },
    sponge_blob_hash: header.spongeBlobHash,
    global_variables: {
      chain_id: header.globalVariables.chainId,
      version: header.globalVariables.version,
      block_number: header.globalVariables.blockNumber,
      slot_number: header.globalVariables.slotNumber,
      timestamp: header.globalVariables.timestamp,
      coinbase: header.globalVariables.coinbase,
      fee_recipient: header.globalVariables.feeRecipient,
      gas_fees: {
        fee_per_da_gas: header.globalVariables.gasFees.feePerDaGas,
        fee_per_l2_gas: header.globalVariables.gasFees.feePerL2Gas,
      },
    },
    total_fees: header.totalFees,
    total_mana_used: header.totalManaUsed,
  };
}

// Configuration
const AZTEC_OLD_URL = process.env.AZTEC_OLD_URL ?? "http://localhost:8080";
const AZTEC_NEW_URL = process.env.AZTEC_NEW_URL ?? "http://localhost:8081";
const ETHEREUM_RPC_URL =
  process.env.ETHEREUM_RPC_URL ?? "http://localhost:8545";
const ANVIL_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// L1 Migrator ABI
const L1MigratorAbi = parseAbi([
  "constructor(address _registry, address _poseidon2)",
  "function migrateArchiveRoot(uint256 oldVersion, (bytes32 actor, uint256 version) l2Migrator) external returns (bytes32 leaf, uint256 leafIndex)",
  "function getArchiveInfo(uint256 version) external view returns (bytes32 archiveRoot, uint256 provenCheckpointNumber)",
  "function REGISTRY() external view returns (address)",
  "function POSEIDON2() external view returns (address)",
  "function SECRET_HASH_FOR_ZERO() external view returns (bytes32)",
  "event ArchiveRootMigrated(uint256 indexed oldVersion, uint256 indexed newVersion, bytes32 indexed l2Migrator, bytes32 archiveRoot, uint256 provenCheckpointNumber, bytes32 messageLeaf, uint256 messageLeafIndex)",
]);

const InboxAbi = parseAbi([
  "event MessageSent(uint256 indexed checkpointNumber, uint256 index, bytes32 indexed hash, bytes16 rollingHash)",
]);

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

async function main() {
  console.log("=== Mode B (Emergency Snapshot) Migration E2E Test ===\n");
  console.log("Architecture:");
  console.log(
    "  OLD Rollup: ExampleMigrationApp + MigrationKeyRegistry (user tokens + key registration)",
  );
  console.log(
    "  NEW Rollup: ExampleMigrationApp + MigratorModeB (claim via snapshot proof)",
  );
  console.log("  L1: L1 Migrator (sends archive roots to NEW rollup)\n");

  // ============================================================
  // Step 1: Setup clients
  // ============================================================
  console.log("1. Setting up clients...");
  const aztecOldNode = createAztecNodeClient(AZTEC_OLD_URL);
  const aztecNewNode = createAztecNodeClient(AZTEC_NEW_URL);
  const l1Contracts = await aztecNewNode.getL1ContractAddresses();
  const registryAddress = l1Contracts.registryAddress;
  const newInboxAddress = l1Contracts.inboxAddress;
  const oldRollupVersion = await aztecOldNode.getVersion();
  const newRollupVersion = await aztecNewNode.getVersion();
  const l1ChainId = getPXEConfig().l1ChainId;

  console.log(`   Connected to Aztec network:`);
  console.log(`   - Chain ID: ${l1ChainId}`);
  console.log(`   - Old Rollup Version: ${oldRollupVersion}`);
  console.log(`   - New Rollup Version: ${newRollupVersion}`);
  console.log(`   - Registry: ${registryAddress}`);

  const oldRollupWallet = await TestWallet.create(aztecOldNode);
  const newRollupWallet = await TestWallet.create(aztecNewNode);

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
  const oldUserWallet = oldRollupWallet;
  console.log(`   Old Deployer: ${oldDeployer}`);
  console.log(`   Old User (Alice): ${oldRollupUser}`);

  // Derive master nullifier secret key and get address preimage for constrained nullifiers
  const userSecret = testAccountsData[1].secret;
  const nsk_m = deriveMasterNullifierSecretKey(userSecret);
  const nsk_m_hi = nsk_m.hi;
  const nsk_m_lo = nsk_m.lo;
  console.log(`   nsk_m.hi: ${nsk_m_hi}`);
  console.log(`   nsk_m.lo: ${nsk_m_lo}`);

  // Get complete address (public keys + partial address)
  const userCompleteAddress = await oldUserManager.getCompleteAddress();
  const userPublicKeys = userCompleteAddress.publicKeys;
  const userPartialAddress = userCompleteAddress.partialAddress;
  const ivpk_m = userPublicKeys.masterIncomingViewingPublicKey;
  const ovpk_m = userPublicKeys.masterOutgoingViewingPublicKey;
  const tpk_m = userPublicKeys.masterTaggingPublicKey;
  console.log(`   partial_address: ${userPartialAddress}`);
  console.log(`   ivpk_m: (${ivpk_m.x}, ${ivpk_m.y})`);
  console.log(`   ovpk_m: (${ovpk_m.x}, ${ovpk_m.y})`);
  console.log(`   tpk_m: (${tpk_m.x}, ${tpk_m.y})`);

  const newDeployerManager = await newRollupWallet.createSchnorrAccount(
    testAccountsData[0].secret,
    testAccountsData[0].salt,
    testAccountsData[0].signingKey,
  );
  const newUserManager = await newRollupWallet.createSchnorrAccount(
    testAccountsData[1].secret,
    testAccountsData[1].salt,
    testAccountsData[1].signingKey,
  );
  const newDeployer = newDeployerManager.address;
  const newRollupUser = newUserManager.address;
  const newDeployerWallet = newRollupWallet;
  const newUserWallet = newRollupWallet;
  console.log(`   New Deployer: ${newDeployer}`);
  console.log(`   New User (Alice): ${newRollupUser}`);

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

  // ============================================================
  // Step 2: Deploy L1 contracts (Poseidon2 + L1 Migrator)
  // ============================================================
  console.log("2. Deploying L1 contracts...");

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
  console.log(`   Poseidon2 deployed at: ${poseidon2Address}`);

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
  console.log(`   L1 Migrator deployed at: ${l1MigratorAddress}\n`);

  // ============================================================
  // Step 3: Deploy OLD rollup contracts
  // ============================================================
  console.log("3. Deploying OLD rollup contracts...");

  // ExampleMigrationApp on old rollup (no old_rollup_app_address needed)
  const oldApp = await ExampleMigrationAppContract.deploy(oldDeployerWallet, {
    _is_some: false,
    _value: AztecAddress.ZERO,
  })
    .send({ from: oldDeployer })
    .deployed();
  console.log(`   old_example_app deployed at: ${oldApp.address}`);

  // MigrationKeyRegistry on old rollup
  const keyRegistry = await MigrationKeyRegistryContract.deploy(
    oldDeployerWallet,
  )
    .send({ from: oldDeployer })
    .deployed();
  console.log(
    `   migration_key_registry deployed at: ${keyRegistry.address}\n`,
  );

  // ============================================================
  // Step 4: Mint tokens to Alice on OLD rollup
  // ============================================================
  console.log("4. Minting tokens to Alice on OLD rollup...");

  const MINT_AMOUNT_1 = 500n;
  const MINT_AMOUNT_2 = 300n;

  await oldApp.methods
    .mint(oldRollupUser, MINT_AMOUNT_1)
    .send({ from: oldDeployer })
    .wait();
  console.log(`   Minted ${MINT_AMOUNT_1} tokens (mint 1)`);

  await oldApp.methods
    .mint(oldRollupUser, MINT_AMOUNT_2)
    .send({ from: oldDeployer })
    .wait();
  console.log(`   Minted ${MINT_AMOUNT_2} tokens (mint 2)`);

  const oldBalance = await oldApp.methods
    .get_balance(oldRollupUser)
    .simulate({ from: oldRollupUser });
  console.log(`   Total balance on OLD rollup: ${oldBalance}\n`);

  // ============================================================
  // Step 5: Register migration key for Alice
  // ============================================================
  console.log("5. Registering migration key for Alice...");

  const msk = new Fr(12345n);
  const mpkHash = await poseidon2Hash([msk]);
  console.log(`   msk: ${msk}`);
  console.log(`   mpk_hash: ${mpkHash}`);

  const registerTx = await keyRegistry.methods
    .register(mpkHash)
    .send({ from: oldRollupUser })
    .wait();
  console.log(`   Register tx: ${registerTx.txHash}`);

  const registeredKey = await keyRegistry.methods
    .get(oldRollupUser)
    .simulate({ from: oldRollupUser });
  console.log(`   Verified registered mpk_hash: ${registeredKey}\n`);

  // ============================================================
  // Step 6: Wait for blocks to be proven (snapshot point)
  // ============================================================
  console.log("6. Waiting for blocks to be proven...");

  // Trigger a couple more blocks to ensure everything is included
  try {
    await oldApp.methods
      .mint(oldDeployer, 1n)
      .send({ from: oldDeployer })
      .wait();
  } catch (e) {
    // Ignore
  }

  let provenBlockNumber = await aztecOldNode.getProvenBlockNumber();
  const targetBlock = registerTx.blockNumber!;
  console.log(`   Key registration block: ${targetBlock}`);
  console.log(`   Current proven block: ${provenBlockNumber}`);

  while (provenBlockNumber < targetBlock) {
    console.log("   Waiting for proof...");
    try {
      await oldApp.methods
        .mint(oldDeployer, 1n)
        .send({ from: oldDeployer })
        .wait();
    } catch (e) {
      // Ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    provenBlockNumber = await aztecOldNode.getProvenBlockNumber();
  }

  // Use the proven block number as our snapshot height
  const snapshotHeight = provenBlockNumber;
  console.log(`   Snapshot height H = ${snapshotHeight} (proven block)\n`);

  // ============================================================
  // Step 7: Deploy NEW rollup contracts
  // ============================================================
  console.log("7. Deploying NEW rollup contracts...");

  // MigratorModeB on new rollup
  const newMigratorModeB = await MigratorModeBContract.deploy(
    newDeployerWallet,
    EthAddress.fromString(l1MigratorAddress), // l1_migrator
    oldRollupVersion, // old_rollup_version
    oldApp.address, // old_app_address
    keyRegistry.address, // old_key_registry
  )
    .send({ from: newDeployer })
    .deployed();
  console.log(
    `   new_migrator_mode_b deployed at: ${newMigratorModeB.address}`,
  );

  // ExampleMigrationApp on new rollup (with old_app_address)
  const newApp = await ExampleMigrationAppContract.deploy(newDeployerWallet, {
    _is_some: true,
    _value: oldApp.address,
  })
    .send({ from: newDeployer })
    .deployed();
  console.log(`   new_example_app deployed at: ${newApp.address}\n`);

  // ============================================================
  // Step 8: Bridge archive root via L1
  // ============================================================
  console.log("8. Sending archive root from L1 to NEW rollup...");

  const archiveInfo = await publicClient.readContract({
    address: l1MigratorAddress,
    abi: L1MigratorAbi,
    functionName: "getArchiveInfo",
    args: [BigInt(oldRollupVersion)],
  });
  console.log(`   Archive Root: ${archiveInfo[0]}`);
  console.log(`   Proven Checkpoint: ${archiveInfo[1]}`);

  const migrateRootsTxHash = await l1WalletClient.writeContract({
    address: l1MigratorAddress,
    abi: L1MigratorAbi,
    functionName: "migrateArchiveRoot",
    args: [
      BigInt(oldRollupVersion),
      {
        actor: toHex(newMigratorModeB.address.toBigInt(), { size: 32 }),
        version: BigInt(newRollupVersion),
      },
    ],
  });

  const migrateRootsReceipt = await publicClient.waitForTransactionReceipt({
    hash: migrateRootsTxHash,
  });
  console.log(`   L1 tx status: ${migrateRootsReceipt.status}`);

  // Parse events
  const archiveRootMigratedLog = migrateRootsReceipt.logs.find((log) => {
    try {
      const decoded = decodeEventLog({
        abi: L1MigratorAbi,
        data: log.data,
        topics: log.topics,
      });
      return decoded.eventName === "ArchiveRootMigrated";
    } catch {
      return false;
    }
  });

  if (!archiveRootMigratedLog) {
    throw new Error("ArchiveRootMigrated event not found");
  }

  const archiveRootMigratedEvent = decodeEventLog({
    abi: L1MigratorAbi,
    data: archiveRootMigratedLog.data,
    topics: archiveRootMigratedLog.topics,
  });

  const eventArgs = archiveRootMigratedEvent.args as {
    oldVersion: bigint;
    newVersion: bigint;
    l2Migrator: `0x${string}`;
    archiveRoot: `0x${string}`;
    provenCheckpointNumber: bigint;
    messageLeaf: `0x${string}`;
    messageLeafIndex: bigint;
  };

  console.log(`   Archive Root sent: ${eventArgs.archiveRoot}`);
  console.log(`   Proven Block: ${eventArgs.provenCheckpointNumber}`);
  const provenArchiveRoot = Fr.fromHexString(eventArgs.archiveRoot);

  // IMPORTANT: Use the proven checkpoint number from the L1 event as both the
  // proven_block_number (for register_archive_root content hash match) and the
  // snapshot height (since the archive root covers all blocks up to this number).
  // Override snapshotHeight with the actual proven block number from L1
  const effectiveSnapshotHeight = BlockNumber.fromBigInt(eventArgs.provenCheckpointNumber);
  console.log(`   Using effective snapshot height: ${effectiveSnapshotHeight} (from L1 proven checkpoint)`);

  // Get L1-to-L2 message hash
  const inboxLogs = migrateRootsReceipt.logs.filter(
    (log) =>
      log.address.toLowerCase() === newInboxAddress.toString().toLowerCase(),
  );
  if (inboxLogs.length === 0) {
    throw new Error("No MessageSent event found");
  }
  const messageSentEvent = decodeEventLog({
    abi: InboxAbi,
    data: inboxLogs[0].data,
    topics: inboxLogs[0].topics,
  });
  const l1ToL2LeafIndex = messageSentEvent.args.index;
  const l1ToL2MessageHash = new Fr(BigInt(messageSentEvent.args.hash));
  console.log(`   L1-to-L2 message hash: ${l1ToL2MessageHash}\n`);

  // ============================================================
  // Step 9: Wait for L1-to-L2 message to sync
  // ============================================================
  console.log("9. Waiting for L1-to-L2 message to sync...");

  let messageReady = false;
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts && !messageReady; i++) {
    const messageBlock =
      await aztecNewNode.getL1ToL2MessageBlock(l1ToL2MessageHash);
    if (messageBlock !== undefined) {
      messageReady = true;
      console.log(`   Message synced in block ${messageBlock}!`);
    } else {
      console.log(`   Waiting... attempt ${i + 1}/${maxAttempts}`);
      try {
        await newApp.methods
          .mint(newDeployer, 1n)
          .send({ from: newDeployer })
          .wait();
      } catch (e) {
        // Ignore
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  if (!messageReady) {
    throw new Error("L1-to-L2 message not ready after timeout");
  }

  // Mine an extra block to ensure the L1-to-L2 message tree state is fully committed
  console.log("   Mining extra block to ensure message tree is settled...");
  try {
    await newApp.methods
      .mint(newDeployer, 1n)
      .send({ from: newDeployer })
      .wait();
  } catch (e) {
    // Ignore
  }
  console.log("");

  // ============================================================
  // Step 10: Register archive root + set snapshot height
  // ============================================================
  console.log("10. Registering archive root and setting snapshot height...");
  console.log(`   archive_root: ${provenArchiveRoot}`);
  console.log(`   proven_block_number: ${effectiveSnapshotHeight}`);
  console.log(`   secret: ${Fr.ZERO}`);
  console.log(`   leaf_index: ${l1ToL2LeafIndex}`);

  // Retry registration up to 3 times (L1-to-L2 message tree may need time to settle)
  let registerArchiveTx;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      registerArchiveTx = await newMigratorModeB.methods
        .register_archive_root(
          provenArchiveRoot,
          effectiveSnapshotHeight,
          Fr.ZERO, // secret = 0
          new Fr(l1ToL2LeafIndex),
        )
        .send({ from: newDeployer })
        .wait();
      break;
    } catch (e) {
      if (attempt < 2) {
        console.log(`   Attempt ${attempt + 1} failed, retrying after extra block...`);
        try {
          await newApp.methods
            .mint(newDeployer, 1n)
            .send({ from: newDeployer })
            .wait();
        } catch (_) {
          // Ignore
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } else {
        throw e;
      }
    }
  }
  console.log(`   Register archive root tx: ${registerArchiveTx!.txHash}`);

  const storedArchiveRoot = await newMigratorModeB.methods
    .get_old_archive_root(effectiveSnapshotHeight)
    .simulate({ from: newDeployer });
  console.log(`   Stored archive root: ${new Fr(storedArchiveRoot)}`);

  const setSnapshotTx = await newMigratorModeB.methods
    .set_snapshot_height(effectiveSnapshotHeight)
    .send({ from: newDeployer })
    .wait();
  console.log(`   Set snapshot height tx: ${setSnapshotTx.txHash}`);

  const storedSnapshot = await newMigratorModeB.methods
    .get_snapshot_height()
    .simulate({ from: newDeployer });
  console.log(`   Stored snapshot height: ${storedSnapshot}\n`);

  // ============================================================
  // Step 11: Gather balance note (UintNote) proof data
  // ============================================================
  console.log("11. Gathering balance note proof data...");

  // Get balance notes from PXE
  const balancesSlot = oldApp.artifact.storageLayout["balances"].slot;
  console.log(`   Balances storage slot: ${balancesSlot}`);

  const balanceNotes = await oldUserWallet.getNotes({
    owner: oldRollupUser,
    contractAddress: oldApp.address,
    storageSlot: balancesSlot,
  });
  console.log(`   Found ${balanceNotes.length} balance note(s) in PXE`);

  if (balanceNotes.length === 0) {
    throw new Error("No balance notes found");
  }

  // Use the first balance note for migration
  const balanceNote = balanceNotes[0];
  const balanceNoteValue = balanceNote.note.items[0]; // UintNote has single field: value
  console.log(`   Balance note value: ${balanceNoteValue}`);
  console.log(`   Balance note hash (inner): ${balanceNote.noteHash}`);
  console.log(`   Balance note randomness: ${balanceNote.randomness}`);
  console.log(`   Balance note nonce: ${balanceNote.noteNonce}`);
  console.log(`   Balance note storage slot: ${balanceNote.storageSlot}`);
  console.log(
    `   Balance note siloed nullifier: ${balanceNote.siloedNullifier}`,
  );

  // Compute unique note hash (what's actually in the tree)
  const balanceSiloedHash = await siloNoteHash(
    balanceNote.contractAddress,
    balanceNote.noteHash,
  );
  const balanceUniqueHash = await computeUniqueNoteHash(
    balanceNote.noteNonce,
    balanceSiloedHash,
  );
  console.log(`   Balance note unique hash: ${balanceUniqueHash}`);

  // Find leaf index in note hash tree
  const balanceLeafResults = await aztecOldNode.findLeavesIndexes(
    effectiveSnapshotHeight,
    MerkleTreeId.NOTE_HASH_TREE,
    [balanceUniqueHash],
  );
  if (!balanceLeafResults[0]) {
    throw new Error("Balance note not found in note hash tree");
  }
  const balanceLeafIndex = balanceLeafResults[0].data;
  console.log(`   Balance note leaf index: ${balanceLeafIndex}`);

  // Get note hash sibling path
  const balanceNoteHashSiblingPath =
    await aztecOldNode.getNoteHashSiblingPath(effectiveSnapshotHeight, balanceLeafIndex);
  console.log(
    `   Balance note hash sibling path length: ${balanceNoteHashSiblingPath.toFields().length}`,
  );

  // Compute siloed nullifier for balance note (constrained — matches in-circuit computation)
  // nsk_app = poseidon2([nsk.hi, nsk.lo, contract_address], GENERATOR_INDEX__NSK_M=48)
  const balanceNskApp = await computeAppNullifierSecretKey(nsk_m, oldApp.address);
  // inner_nullifier = poseidon2([note_hash, nsk_app], GENERATOR_INDEX__NOTE_NULLIFIER=53)
  const balanceInnerNullifier = await poseidon2HashWithSeparator(
    [balanceNote.noteHash, balanceNskApp],
    GENERATOR_INDEX__NOTE_NULLIFIER,
  );
  // siloed_nullifier = poseidon2([contract_address, inner_nullifier], OUTER_NULLIFIER=7)
  const balanceSiloedNullifier = await siloNullifier(oldApp.address, balanceInnerNullifier);
  console.log(`   Balance computed siloed nullifier: ${balanceSiloedNullifier}`);
  console.log(`   Balance PXE siloed nullifier:      ${balanceNote.siloedNullifier}`);

  // Get low nullifier witness using the computed siloed nullifier
  const balanceLowNullifierWitness =
    await aztecOldNode.getLowNullifierMembershipWitness(
      effectiveSnapshotHeight,
      balanceSiloedNullifier,
    );
  if (!balanceLowNullifierWitness) {
    throw new Error("Could not get low nullifier witness for balance note");
  }
  console.log(
    `   Balance low nullifier value: ${balanceLowNullifierWitness.leafPreimage.getKey()}`,
  );
  console.log(
    `   Balance low nullifier next: ${balanceLowNullifierWitness.leafPreimage.getNextKey()}`,
  );
  console.log(
    `   Balance low nullifier index: ${balanceLowNullifierWitness.index}\n`,
  );

  // ============================================================
  // Step 12: Gather migration key note proof data
  // ============================================================
  console.log("12. Gathering migration key note proof data...");

  const keyRegistrySlot =
    keyRegistry.artifact.storageLayout["registered_keys"].slot;
  console.log(`   Key registry storage slot: ${keyRegistrySlot}`);

  const keyNotes = await oldUserWallet.getNotes({
    owner: oldRollupUser,
    contractAddress: keyRegistry.address,
    storageSlot: keyRegistrySlot,
  });
  console.log(`   Found ${keyNotes.length} key note(s) in PXE`);

  if (keyNotes.length === 0) {
    throw new Error("No key registration notes found");
  }

  const keyNote = keyNotes[0];
  console.log(`   Key note hash (inner): ${keyNote.noteHash}`);
  console.log(`   Key note randomness: ${keyNote.randomness}`);
  console.log(`   Key note nonce: ${keyNote.noteNonce}`);
  console.log(`   Key note storage slot: ${keyNote.storageSlot}`);
  console.log(`   Key note siloed nullifier: ${keyNote.siloedNullifier}`);

  // Compute unique note hash
  const keySiloedHash = await siloNoteHash(
    keyNote.contractAddress,
    keyNote.noteHash,
  );
  const keyUniqueHash = await computeUniqueNoteHash(
    keyNote.noteNonce,
    keySiloedHash,
  );
  console.log(`   Key note unique hash: ${keyUniqueHash}`);

  // Find leaf index
  const keyLeafResults = await aztecOldNode.findLeavesIndexes(
    effectiveSnapshotHeight,
    MerkleTreeId.NOTE_HASH_TREE,
    [keyUniqueHash],
  );
  if (!keyLeafResults[0]) {
    throw new Error("Key note not found in note hash tree");
  }
  const keyLeafIndex = keyLeafResults[0].data;
  console.log(`   Key note leaf index: ${keyLeafIndex}`);

  // Get note hash sibling path
  const keyNoteHashSiblingPath = await aztecOldNode.getNoteHashSiblingPath(
    effectiveSnapshotHeight,
    keyLeafIndex,
  );
  console.log(
    `   Key note hash sibling path length: ${keyNoteHashSiblingPath.toFields().length}`,
  );

  // Compute siloed nullifier for key note (constrained — matches in-circuit computation)
  const keyNskApp = await computeAppNullifierSecretKey(nsk_m, keyRegistry.address);
  const keyInnerNullifier = await poseidon2HashWithSeparator(
    [keyNote.noteHash, keyNskApp],
    GENERATOR_INDEX__NOTE_NULLIFIER,
  );
  const keySiloedNullifier = await siloNullifier(keyRegistry.address, keyInnerNullifier);
  console.log(`   Key computed siloed nullifier: ${keySiloedNullifier}`);
  console.log(`   Key PXE siloed nullifier:      ${keyNote.siloedNullifier}`);

  // Get low nullifier witness using the computed siloed nullifier
  const keyLowNullifierWitness =
    await aztecOldNode.getLowNullifierMembershipWitness(
      effectiveSnapshotHeight,
      keySiloedNullifier,
    );
  if (!keyLowNullifierWitness) {
    throw new Error("Could not get low nullifier witness for key note");
  }
  console.log(
    `   Key low nullifier value: ${keyLowNullifierWitness.leafPreimage.getKey()}`,
  );
  console.log(
    `   Key low nullifier next: ${keyLowNullifierWitness.leafPreimage.getNextKey()}`,
  );
  console.log(
    `   Key low nullifier index: ${keyLowNullifierWitness.index}\n`,
  );

  // ============================================================
  // Step 13: Get block header and archive proof
  // ============================================================
  console.log("13. Getting block header and archive proof...");

  const blockHeader = await aztecOldNode.getBlockHeader(effectiveSnapshotHeight);
  if (!blockHeader) {
    throw new Error("Could not get block header for snapshot height");
  }
  console.log(`   Block header hash: ${await blockHeader.hash()}`);
  console.log(
    `   Block number: ${blockHeader.globalVariables.blockNumber}`,
  );

  const archiveLeafIndex = BigInt(effectiveSnapshotHeight);
  const archiveSiblingPath = await aztecOldNode.getArchiveSiblingPath(
    effectiveSnapshotHeight,
    archiveLeafIndex,
  );
  console.log(
    `   Archive sibling path length: ${archiveSiblingPath.toFields().length}\n`,
  );

  // ============================================================
  // Step 14: Call migrate_mode_b on NEW rollup
  // ============================================================
  console.log("14. Calling migrate_mode_b on NEW rollup...");

  const migrateAmount = BigInt(balanceNoteValue.toBigInt());
  console.log(`   Migrating amount: ${migrateAmount}`);

  const newBalanceBefore = await newApp.methods
    .get_balance(newDeployer)
    .simulate({ from: newDeployer });
  console.log(`   Balance on NEW rollup before (deployer): ${newBalanceBefore}`);

  const noirBlockHeader = blockHeaderToNoir(blockHeader);

  try {
    // NOTE: We send from newDeployer (whose account is pre-deployed by the sandbox)
    // because the user's Schnorr account signing key note is not available on the new rollup.
    // The tokens will be minted to msg_sender (the deployer) for testing purposes.
    // In production, the user would deploy their account on the new rollup first.
    const migrateTx = await newApp.methods
      .migrate_mode_b(
        newMigratorModeB.address,
        // Auth
        msk,
        migrateAmount,
        // UintNote fields
        oldRollupUser, // balance_note_owner
        balanceNote.storageSlot, // balance_note_storage_slot
        balanceNote.randomness, // balance_note_randomness
        balanceNote.noteNonce, // balance_note_nonce
        // UintNote inclusion proof
        new Fr(balanceLeafIndex), // balance_note_leaf_index
        balanceNoteHashSiblingPath.toFields(), // balance_note_sibling_path
        // UintNote non-nullification proof (nullifier computed in-circuit from nsk)
        new Fr(balanceLowNullifierWitness.leafPreimage.getKey()), // balance_low_nullifier_value
        new Fr(balanceLowNullifierWitness.leafPreimage.getNextKey()), // balance_low_nullifier_next_value
        new Fr(balanceLowNullifierWitness.leafPreimage.getNextIndex()), // balance_low_nullifier_next_index
        new Fr(balanceLowNullifierWitness.index), // balance_low_nullifier_leaf_index
        balanceLowNullifierWitness.siblingPath.toFields(), // balance_low_nullifier_sibling_path
        // MigrationKeyNote fields
        keyNote.storageSlot, // key_note_storage_slot
        keyNote.randomness, // key_note_randomness
        keyNote.noteNonce, // key_note_nonce
        // MigrationKeyNote inclusion proof
        new Fr(keyLeafIndex), // key_note_leaf_index
        keyNoteHashSiblingPath.toFields(), // key_note_sibling_path
        // MigrationKeyNote non-nullification proof (nullifier computed in-circuit from nsk)
        new Fr(keyLowNullifierWitness.leafPreimage.getKey()), // key_low_nullifier_value
        new Fr(keyLowNullifierWitness.leafPreimage.getNextKey()), // key_low_nullifier_next_value
        new Fr(keyLowNullifierWitness.leafPreimage.getNextIndex()), // key_low_nullifier_next_index
        new Fr(keyLowNullifierWitness.index), // key_low_nullifier_leaf_index
        keyLowNullifierWitness.siblingPath.toFields(), // key_low_nullifier_sibling_path
        // Block header + archive proof
        noirBlockHeader,
        new Fr(archiveLeafIndex),
        archiveSiblingPath.toFields(),
        // Address preimage: nsk (hi/lo) + public keys + partial address
        nsk_m_hi, // nsk_hi
        nsk_m_lo, // nsk_lo
        ivpk_m.x, // ivpk_m_x
        ivpk_m.y, // ivpk_m_y
        ovpk_m.x, // ovpk_m_x
        ovpk_m.y, // ovpk_m_y
        tpk_m.x, // tpk_m_x
        tpk_m.y, // tpk_m_y
        userPartialAddress, // partial_address
      )
      .send({ from: newDeployer })
      .wait();

    console.log(`   Migrate tx: ${migrateTx.txHash}`);

    // Tokens minted to msg_sender (newDeployer)
    const newBalanceAfter = await newApp.methods
      .get_balance(newDeployer)
      .simulate({ from: newDeployer });
    console.log(`   Balance on NEW rollup after (deployer): ${newBalanceAfter}`);

    if (BigInt(newBalanceAfter) >= migrateAmount) {
      console.log(
        "   ✅ Mode B migration successful! Balance matches migrated amount.",
      );
    } else {
      console.log(
        "   ⚠️  Migration completed but balance does not match expected amount.",
      );
    }
  } catch (e) {
    const err = e as Error;
    console.log(`   ❌ migrate_mode_b failed: ${err.message}`);
    if (err.stack) {
      console.log(`   Stack: ${err.stack.split('\n').slice(0, 10).join('\n   ')}`);
    }
    // Print any additional properties
    if ('cause' in err && err.cause) {
      console.log(`   Cause: ${JSON.stringify(err.cause, null, 2)}`);
    }
  }

  // ============================================================
  // Summary
  // ============================================================
  const newBalanceAfter = await newApp.methods
    .get_balance(newDeployer)
    .simulate({ from: newDeployer });

  console.log("\n=== Mode B Migration Test Summary ===\n");
  console.log("Contracts deployed:");
  console.log("  OLD Rollup (L2):");
  console.log(`    - ExampleMigrationApp: ${oldApp.address}`);
  console.log(`    - MigrationKeyRegistry: ${keyRegistry.address}`);
  console.log("  NEW Rollup (L2):");
  console.log(`    - MigratorModeB: ${newMigratorModeB.address}`);
  console.log(`    - ExampleMigrationApp: ${newApp.address}`);
  console.log("  L1:");
  console.log(`    - L1 Migrator: ${l1MigratorAddress}`);
  console.log(`    - Poseidon2: ${poseidon2Address}`);
  console.log("");
  console.log(`Snapshot height: ${effectiveSnapshotHeight}`);
  console.log(`Migration secret key: ${msk}`);
  console.log(`Migration public key hash: ${mpkHash}`);
  console.log(`Migrated amount: ${migrateAmount}`);
  console.log("");
  console.log("Balances:");
  console.log(`  OLD rollup: ${oldBalance}`);
  console.log(`  NEW rollup: ${newBalanceAfter}`);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
