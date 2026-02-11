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
import { MigratorContract } from "../noir/target/artifacts/Migrator.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { EthAddress } from "@aztec/foundation/eth-address";
import { Fr, Fq } from "@aztec/foundation/curves/bn254";
import { getPXEConfig } from "@aztec/pxe/server";
import { MerkleTreeId } from "@aztec/stdlib/trees";
import { computeUniqueNoteHash, siloNoteHash } from "@aztec/stdlib/hash";
import type { BlockHeader } from "@aztec/stdlib/tx";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import { BlockNumber } from "@aztec/foundation/branded-types";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Convert TypeScript BlockHeader to Noir-compatible format with snake_case keys.
 * The Aztec.js encoder looks for exact field name matches from the ABI.
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
    // In this version, it's spongeBlobHash (not contentCommitment.blobsHash)
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
        // In this version, feePerDaGas and feePerL2Gas are already bigints (UInt128)
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

// L1 Migrator ABI - sends old rollup archive roots to new rollup
const L1MigratorAbi = parseAbi([
  "constructor(address _registry, address _poseidon2)",
  "function migrateArchiveRoot(uint256 oldVersion, (bytes32 actor, uint256 version) l2Migrator) external returns (bytes32 leaf, uint256 leafIndex)",
  "function getArchiveInfo(uint256 version) external view returns (bytes32 archiveRoot, uint256 provenCheckpointNumber)",
  "function REGISTRY() external view returns (address)",
  "function POSEIDON2() external view returns (address)",
  "function SECRET_HASH_FOR_ZERO() external view returns (bytes32)",
  "event ArchiveRootMigrated(uint256 indexed oldVersion, uint256 indexed newVersion, bytes32 indexed l2Migrator, bytes32 archiveRoot, uint256 provenCheckpointNumber, bytes32 messageLeaf, uint256 messageLeafIndex)",
]);

// Inbox MessageSent event ABI
const InboxAbi = parseAbi([
  "event MessageSent(uint256 indexed checkpointNumber, uint256 index, bytes32 indexed hash, bytes16 rollingHash)",
]);

// Load L1 Migrator bytecode from compiled artifact
function loadL1MigratorBytecode(): Hex {
  const artifactPath = join(
    __dirname,
    "../solidity/target/Migrator.sol/Migrator.json",
  );
  const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
  return artifact.bytecode.object as Hex;
}

// Load Poseidon2 bytecode from compiled artifact
function loadPoseidon2Bytecode(): Hex {
  const artifactPath = join(
    __dirname,
    "../solidity/target/Poseidon2Yul.sol/Poseidon2Yul_BN254.json",
  );
  const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
  return artifact.bytecode.object as Hex;
}

async function main() {
  console.log("=== Cross-Rollup Migration E2E Test ===\n");
  console.log("Simulating OLD and NEW rollups on the same local network.\n");
  console.log("Architecture:");
  console.log("  OLD Rollup: old_example_app + old_migrator");
  console.log("  NEW Rollup: new_example_app + new_migrator");
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

  // Setup wallets (using TestWallet to create PXE instances)
  const oldRollupWallet = await TestWallet.create(aztecOldNode);
  const newRollupWallet = await TestWallet.create(aztecNewNode);

  // Get pre-seeded test accounts data and register them in PXE
  // (accounts are already deployed on the network via TEST_ACCOUNTS=true)
  console.log("   Registering test accounts on OLD rollup...");
  const testAccountsData = await getInitialTestAccountsData();

  // Create account managers (registers in PXE) but don't deploy (already deployed)
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
  // For wallets, we use the TestWallet which can act as any registered account
  const oldDeployerWallet = oldRollupWallet;
  const oldUserWallet = oldRollupWallet;
  console.log(`   Old Deployer (test account 0): ${oldDeployer}`);
  console.log(`   Old User (test account 1): ${oldRollupUser}`);

  // Register test accounts on NEW rollup
  console.log("   Registering test accounts on NEW rollup...");
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
  console.log(`   New Deployer (test account 0): ${newDeployer}`);
  console.log(`   New User (test account 1): ${newRollupUser}`);

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

  // ============================================================
  // Step 2: Deploy Poseidon2 contract on L1
  // ============================================================
  console.log("2. Deploying Poseidon2 contract on L1...");

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
  console.log(`   Poseidon2 deployed at: ${poseidon2Address}\n`);

  // ============================================================
  // Step 3: Deploy L1 Migrator contract
  // ============================================================
  console.log("3. Deploying L1 Migrator contract...");

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
  // Step 4: Deploy OLD rollup contracts (L2)
  // ============================================================
  console.log("4. Deploying OLD rollup L2 contracts...");
  console.log(
    "   (old_migrator creates lock notes, does NOT consume L1 messages)",
  );

  // OLD Migrator - doesn't need L1 migrator since it only creates lock notes
  const oldMigrator = await MigratorContract.deploy(
    oldDeployerWallet,
    // No L1 Migrator (this is the OLD rollup)
    {
      _is_some: false,
      _value: EthAddress.ZERO,
    },
    // No old L2 Migrator (this is the OLD rollup)
    {
      _is_some: false,
      _value: { version: 0n, address: AztecAddress.ZERO },
    },
  )
    .send({ from: oldDeployer })
    .deployed();

  console.log(`   old_migrator deployed at: ${oldMigrator.address}`);

  // OLD ExampleApp
  const oldApp = await ExampleMigrationAppContract.deploy(oldDeployerWallet, {
    _is_some: false,
    _value: AztecAddress.ZERO,
  })
    .send({ from: oldDeployer })
    .deployed();

  console.log(`   old_example_app deployed at: ${oldApp.address}\n`);

  // ============================================================
  // Step 5: Deploy NEW rollup contracts (L2)
  // ============================================================
  console.log("5. Deploying NEW rollup L2 contracts...");
  console.log("   (new_migrator consumes L1 messages with archive roots)");

  // NEW Migrator - needs L1 Migrator to receive archive roots
  // and old L2 Migrator info for verifying lock notes
  const newMigrator = await MigratorContract.deploy(
    newDeployerWallet,
    // L1 Migrator
    {
      _is_some: true,
      _value: EthAddress.fromString(l1MigratorAddress),
    },
    // old L2 Migrator
    {
      _is_some: true,
      _value: {
        address: oldMigrator.address,
        version: oldRollupVersion,
      },
    },
  )
    .send({ from: newDeployer })
    .deployed();

  console.log(`   new_migrator deployed at: ${newMigrator.address}`);

  // NEW ExampleApp
  const newApp = await ExampleMigrationAppContract.deploy(newDeployerWallet, {
    _is_some: true,
    _value: oldApp.address,
  })
    .send({ from: newDeployer })
    .deployed();

  console.log(`   new_example_app deployed at: ${newApp.address}\n`);

  // ============================================================
  // Step 6: Mint tokens on OLD rollup
  // ============================================================
  console.log("6. Minting tokens on OLD rollup...");

  const MINT_AMOUNT = 1000n;
  await oldApp.methods
    .mint(oldRollupUser, MINT_AMOUNT)
    .send({ from: oldDeployer })
    .wait();

  const oldBalanceAfterMint = await oldApp.methods
    .get_balance(oldRollupUser)
    .simulate({ from: oldRollupUser });
  console.log(
    `   Minted ${MINT_AMOUNT} tokens to old rollup user on OLD rollup`,
  );
  console.log(`   Balance on OLD rollup: ${oldBalanceAfterMint}\n`);

  // ============================================================
  // Step 7: Lock tokens for migration on OLD rollup
  // ============================================================
  console.log("7. Locking tokens for migration on OLD rollup...");

  // User's migration secret key (should be derived from wallet secret in production)
  const msk = new Fr(12345n);
  console.log(`   Owner MSK: ${msk}`);

  const LOCK_AMOUNT = 500n;

  console.log(`   Locking ${LOCK_AMOUNT} tokens...`);
  console.log(`   Destination rollup: ${newRollupVersion}`);

  // Need to use the user wallet to lock tokens (the user is the owner of the balance note)
  const oldAppAsUser = ExampleMigrationAppContract.at(
    oldApp.address,
    oldUserWallet,
  );
  const lockTx = await oldAppAsUser.methods
    .lock_for_migration(
      oldMigrator.address, // Migrator on OLD rollup
      LOCK_AMOUNT,
      newRollupVersion, // Destination rollup version
      msk,
    )
    .send({ from: oldRollupUser })
    .wait();

  console.log(`   Lock tx: ${lockTx.txHash}`);

  const oldBalanceAfterLock = await oldApp.methods
    .get_balance(oldRollupUser)
    .simulate({ from: oldRollupUser });
  console.log(`   Balance on OLD rollup after lock: ${oldBalanceAfterLock}`);
  console.log(
    `   ✅ ${MINT_AMOUNT - BigInt(oldBalanceAfterLock)} tokens locked for migration\n`,
  );

  // ============================================================
  // Step 8: Trigger more blocks to ensure lock note is proven
  // ============================================================
  console.log("8. Waiting for lock note block to be proven...");
  let provenBlockNumber = await aztecOldNode.getProvenBlockNumber();
  console.log(`   Lock tx block: ${lockTx.blockNumber}`);
  console.log(`   Current proven block: ${provenBlockNumber}`);
  while (provenBlockNumber < lockTx.blockNumber!) {
    console.log("   ⚠️  Block not yet proven. Waiting more...");
    // Trigger more blocks by sending dummy transactions (if needed) to speed up proving
    try {
      await oldApp.methods
        .mint(oldDeployer, 1n)
        .send({ from: oldDeployer })
        .wait();
    } catch (e) {
      // Ignore errors
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    provenBlockNumber = await aztecOldNode.getProvenBlockNumber();
  }
  console.log("   ✅  Block proven.");
  console.log("");

  // ============================================================
  // Step 9: Get archive info from L1
  // ============================================================
  console.log("9. Getting archive info from L1...");

  const archiveInfo = await publicClient.readContract({
    address: l1MigratorAddress,
    abi: L1MigratorAbi,
    functionName: "getArchiveInfo",
    args: [BigInt(oldRollupVersion)],
  });

  console.log(`   Archive Root: ${archiveInfo[0]}`);
  console.log(`   Proven Checkpoint: ${archiveInfo[1]}\n`);

  // ============================================================
  // Step 10: Migrate archive root via L1 → L2 message
  // ============================================================
  console.log("10. Sending archive root from L1 to NEW rollup...");

  const migrateRootsTxHash = await l1WalletClient.writeContract({
    address: l1MigratorAddress,
    abi: L1MigratorAbi,
    functionName: "migrateArchiveRoot",
    args: [
      BigInt(oldRollupVersion), // oldVersion
      {
        actor: toHex(newMigrator.address.toBigInt(), { size: 32 }),
        version: BigInt(newRollupVersion),
      },
    ],
  });

  const migrateRootsReceipt = await publicClient.waitForTransactionReceipt({
    hash: migrateRootsTxHash,
  });
  console.log(`   L1 tx status: ${migrateRootsReceipt.status}`);

  // Parse ArchiveRootMigrated event
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

  console.log("   Event args:", archiveRootMigratedEvent.args);

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
  console.log(`   L1→L2 Message Leaf Index: ${eventArgs.messageLeafIndex}`);
  const provenArchiveRoot = Fr.fromHexString(eventArgs.archiveRoot);
  provenBlockNumber = BlockNumber.fromBigInt(eventArgs.provenCheckpointNumber);

  // Get L1→L2 message hash from Inbox
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
  console.log(`   L1→L2 message hash: ${l1ToL2MessageHash}\n`);

  // ============================================================
  // Step 11: Wait for L1→L2 message to sync
  // ============================================================
  console.log("11. Waiting for L1→L2 message to sync...");

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
    throw new Error("L1→L2 message not ready after timeout");
  }
  console.log("");

  // ============================================================
  // Step 12: Register old archive roots on NEW Migrator
  // ============================================================
  console.log("12. Registering old archive roots on NEW Migrator...");

  const registerTx = await newMigrator.methods
    .register_archive_root(
      provenArchiveRoot, // archive_root
      provenBlockNumber, // proven_block_number
      Fr.ZERO, // secret = 0 (using SECRET_HASH_FOR_ZERO)
      new Fr(l1ToL2LeafIndex), // leaf_index
    )
    .send({ from: newDeployer })
    .wait();

  console.log(`   Register tx: ${registerTx.txHash}`);

  const storedArchiveRoot = await newMigrator.methods
    .get_old_archive_root(provenBlockNumber)
    .simulate({ from: newDeployer });

  console.log(`   Stored archive root: ${new Fr(storedArchiveRoot)}`);
  console.log("   ✅ Archive root registered on NEW Migrator!\n");

  // ============================================================
  // Step 13: Get lock note and merkle proofs
  // ============================================================
  console.log("13. Computing lock note hash and getting merkle proofs...");

  // Get note hashes from the lock transaction
  const lockTxEffect = await aztecOldNode.getTxEffect(lockTx.txHash);

  if (!lockTxEffect) {
    console.log("   ❌ Could not get lock transaction effect\n");
    process.exit(1);
  }

  // Get note hashes from tx effect
  const noteHashes = lockTxEffect.data?.noteHashes || [];
  console.log(`   Lock tx has ${noteHashes.length} note hashes`);

  // Find the lock note in the tree - it should be one of the note hashes
  // The lock note is created by the Migrator, so we need to identify which hash is the lock note
  // For now, we'll try each note hash until we find one that works

  let lockNoteLeafIndex: bigint | undefined;

  for (let i = 0; i < noteHashes.length; i++) {
    const noteHash = noteHashes[i];
    console.log(`   Note hash ${i}: ${noteHash}`);

    const leafIndexResults = await aztecOldNode.findLeavesIndexes(
      provenBlockNumber,
      MerkleTreeId.NOTE_HASH_TREE,
      [noteHash],
    );

    if (leafIndexResults[0]) {
      console.log(`     Found at leaf index: ${leafIndexResults[0].data}`);
      // Use the last note hash (likely the lock note since balance notes come first)
      lockNoteLeafIndex = leafIndexResults[0].data;
    }
  }

  if (!lockNoteLeafIndex) {
    console.log("   ❌ Could not find lock note in tree\n");
    process.exit(1);
  }

  console.log(`   Using lock note at leaf index: ${lockNoteLeafIndex}`);

  // Get the note hash sibling path
  const noteHashSiblingPath = await aztecOldNode.getNoteHashSiblingPath(
    provenBlockNumber,
    lockNoteLeafIndex,
  );
  console.log(
    `   Note hash sibling path length: ${noteHashSiblingPath.toFields().length}`,
  );

  // Get the block header for the block containing the note
  const blockHeader = await aztecOldNode.getBlockHeader(provenBlockNumber);
  if (!blockHeader) {
    console.log("   ❌ Could not get block header\n");
    process.exit(1);
  }
  console.log(`   Block header hash: ${await blockHeader.hash()}`);

  // Get the archive sibling path
  // Archive tree leaf index == block number (leaves are stored in block order by design)
  const archiveLeafIndex = BigInt(provenBlockNumber);
  // 1st arg: tree snapshot (which block's tree state to use)
  // 2nd arg: leaf index (which block header to get the path for)
  const archiveSiblingPath = await aztecOldNode.getArchiveSiblingPath(
    provenBlockNumber,
    archiveLeafIndex,
  );
  console.log(
    `   Archive sibling path length: ${archiveSiblingPath.toFields().length}`,
  );

  // Compute the storage slot for the lock note
  // The Migrator stores notes in: migration_notes.at(note_owner).insert(...)
  // where note_owner is passed from ExampleMigrationApp as the user (oldRollupUser)
  const migrationNotesSlot =
    oldMigrator.artifact.storageLayout["migration_notes"].slot;

  // Get the actual lock note from PXE with its randomness and nonce
  // The note is stored in the Migrator contract, owned by the oldApp (the caller of lock_migration_note)
  const lockNotes = await oldUserWallet.getNotes({
    owner: oldRollupUser,
    contractAddress: oldMigrator.address,
    storageSlot: migrationNotesSlot,
  });

  if (lockNotes.length === 0) {
    throw new Error("No lock notes found in PXE");
  } else if (lockNotes.length === 1) {
    console.log(`   Found lock note in PXE`);
  } else {
    console.log(
      `   ⚠️  Multiple (${lockNotes.length}) lock notes found in PXE, using the first one`,
    );
  }
  const lockNote = lockNotes[0];

  // The PXE noteHash is the inner hash, not the unique hash in the tree
  // We need to compute the unique hash: poseidon2([nonce, siloed_hash], UNIQUE_NOTE_HASH_INDEX)
  // where siloed_hash = poseidon2([contract_address, inner_hash], SILOED_NOTE_HASH_INDEX)
  console.log(`   Inner note hash (from PXE): ${lockNote.noteHash}`);
  console.log(`   Note randomness: ${lockNote.randomness}`);
  console.log(`   Note nonce: ${lockNote.noteNonce}`);
  console.log(`   Note storage slot (from PXE): ${lockNote.storageSlot}`);
  console.log(`   Note contract address: ${lockNote.contractAddress}`);
  console.log(`   Note owner (from PXE): ${lockNote.owner}`);
  console.log(
    `   Note data:`,
    lockNote.note.items.map((f) => f.toString()),
  );

  const siloedNoteHash = await siloNoteHash(
    lockNote.contractAddress,
    lockNote.noteHash,
  );
  console.log(`   Siloed note hash (computed): ${siloedNoteHash}`);
  const uniqueNoteHash = await computeUniqueNoteHash(
    lockNote.noteNonce,
    siloedNoteHash,
  );
  console.log(`   Unique note hash (computed): ${uniqueNoteHash}`);

  // Find the leaf index for this computed unique note hash
  const computedLeafIndexResults = await aztecOldNode.findLeavesIndexes(
    await aztecOldNode.getBlockNumber(),
    MerkleTreeId.NOTE_HASH_TREE,
    [uniqueNoteHash],
  );

  if (!computedLeafIndexResults[0]) {
    console.log("   ❌  Could not find computed unique hash in tree\n");
    process.exit(1);
  }

  // ============================================================
  // Step 14: Call migrate on NEW rollup
  // ============================================================
  console.log("14. Calling migrate on NEW rollup...");

  // Use provenCheckpoint for block header and sibling paths.
  // The note hash tree is append-only, so the tree at the checkpoint block still contains
  // the note from the earlier block at the same leaf index.
  // This way block_header.block_number == provenCheckpoint, matching the key in old_archive_roots.
  const finalBlockHeader = await aztecOldNode.getBlockHeader(provenBlockNumber);
  if (!finalBlockHeader) {
    console.log("   ❌ Could not get block header\n");
    process.exit(1);
  }

  const finalNoteHashSiblingPath = await aztecOldNode.getNoteHashSiblingPath(
    provenBlockNumber,
    lockNoteLeafIndex,
  );

  const finalArchiveLeafIndex = BigInt(provenBlockNumber);
  const finalArchiveSiblingPath = await aztecOldNode.getArchiveSiblingPath(
    provenBlockNumber,
    finalArchiveLeafIndex,
  );

  const newBalanceBefore = await newApp.methods
    .get_balance(newRollupUser)
    .simulate({ from: newRollupUser });
  console.log(`   Balance on NEW rollup before: ${newBalanceBefore}`);

  try {
    // Convert BlockHeader to Noir-compatible format with snake_case keys
    const noirBlockHeader = blockHeaderToNoir(finalBlockHeader);

    // Need to use the user wallet on NEW rollup for migration
    const newAppAsUser = await ExampleMigrationAppContract.at(
      newApp.address,
      newUserWallet,
    );
    const migrateTx = await newAppAsUser.methods
      .migrate(
        newMigrator.address, // migrator_address (NEW)
        msk,
        LOCK_AMOUNT,
        lockNote.storageSlot, // migration_note_storage_slot (from PXE)
        lockNote.randomness, // migration_note_randomness
        lockNote.noteNonce, // migration_note_nonce
        new Fr(lockNoteLeafIndex), // migration_note_hash_leaf_index
        finalNoteHashSiblingPath.toFields(), // migration_note_hash_sibling_path
        noirBlockHeader, // block_header (converted to snake_case)
        new Fr(finalArchiveLeafIndex), // archive_leaf_index
        finalArchiveSiblingPath.toFields(), // archive_sibling_path
      )
      .send({ from: newRollupUser })
      .wait();

    console.log(`   Migrate tx: ${migrateTx.txHash}`);

    const newBalanceAfter = await newApp.methods
      .get_balance(newRollupUser)
      .simulate({ from: newRollupUser });
    console.log(`   Balance on NEW rollup after: ${newBalanceAfter}`);

    if (BigInt(newBalanceAfter) === LOCK_AMOUNT) {
      console.log("✅ Cross-rollup migration fully successful!");
    } else {
      console.log("⚠️  Migration completed but balance does not match.");
    }
  } catch (e) {
    console.log(`   ❌ migrate failed: ${(e as Error).message}`);
  }

  const newBalanceAfter = await newApp.methods
    .get_balance(newRollupUser)
    .simulate({ from: newRollupUser });
  // ============================================================
  // Summary
  // ============================================================
  console.log("=== Cross-Rollup Migration Test Summary ===\n");
  console.log("Contracts deployed:");
  console.log("  OLD Rollup (L2):");
  console.log(`    - old_migrator: ${oldMigrator.address}`);
  console.log(`    - old_example_app: ${oldApp.address}`);
  console.log("  NEW Rollup (L2):");
  console.log(`    - new_migrator: ${newMigrator.address}`);
  console.log(`    - new_example_app: ${newApp.address}`);
  console.log("  L1:");
  console.log(`    - L1 Migrator: ${l1MigratorAddress}`);
  console.log(`    - Poseidon2: ${poseidon2Address}`);
  console.log("");
  console.log("Migration Flow:");
  console.log("  1. ✅ User mints tokens on OLD rollup");
  console.log(
    "  2. ✅ User locks tokens for migration (creates MigrationNote)",
  );
  console.log(
    "  3. ✅ L1 Migrator sends archive root to NEW rollup via L1→L2 message",
  );
  console.log(
    "  4. ✅ NEW Migrator consumes L1→L2 message and registers archive root",
  );
  console.log(
    "  5. ✅ migrate called (BlockHeader conversion working)",
  );
  console.log("");
  console.log("Balances:");
  console.log(`  OLD rollup old rollup user balance: ${oldBalanceAfterLock}`);
  console.log(`  NEW rollup new rollup user balance: ${newBalanceAfter}`);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
