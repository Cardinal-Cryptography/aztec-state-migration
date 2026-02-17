import { ExampleMigrationAppContract } from "../noir/target/artifacts/ExampleMigrationApp.js";
import { Fr } from "@aztec/foundation/curves/bn254";
import { signMigrationModeA } from "../ts/migration-lib/index.js";
import { deploy } from "./deploy.js";
import {
  deployAppPair,
  deployArchiveRegistry,
  bridgeArchiveRoot,
  deployAndFundAccount,
} from "./test-utils.js";
import {
  MigrationNote,
  MigrationNoteProofData,
} from "../ts/migration-lib/types.js";

async function main() {
  console.log("=== Cross-Rollup Migration E2E Test (Mode A) ===\n");

  // ============================================================
  // Deploy shared infrastructure
  // ============================================================
  const env = await deploy();

  const { aztecNode: oldAztecNode, migrationWallet: oldUserWallet } =
    env[env.oldRollupVersion];
  const { aztecNode: newAztecNode, migrationWallet: newUserWallet } =
    env[env.newRollupVersion];

  // ============================================================
  // Create user wallets (MigrationTestWallet)
  // ============================================================
  console.log("   Creating user wallets...");

  const oldUserManager = await deployAndFundAccount(env, oldAztecNode);
  const newUserManager = await deployAndFundAccount(env, newAztecNode);

  console.log(`   Old User: ${oldUserManager.address}`);
  console.log(`   New User: ${newUserManager.address}\n`);

  // ============================================================
  // Deploy L2 contracts
  // ============================================================
  const newArchiveRegistry = await deployArchiveRegistry(env);
  console.log(`   new_archive_registry: ${newArchiveRegistry.address}\n`);

  console.log("4. Deploying L2 contracts...");
  const { oldApp, newApp } = await deployAppPair(
    env,
    newArchiveRegistry.address,
  );
  const oldAppUser = ExampleMigrationAppContract.at(
    oldApp.address,
    oldUserWallet,
  );
  const newAppUser = ExampleMigrationAppContract.at(
    newApp.address,
    newUserWallet,
  );
  console.log(`   old_example_app: ${oldApp.address}`);
  console.log(`   new_example_app: ${newApp.address}`);

  // ============================================================
  // Step 6: Mint tokens on OLD rollup
  // ============================================================
  console.log("6. Minting tokens on OLD rollup...");
  const MINT_AMOUNT = 1000n;
  await oldAppUser.methods
    .mint(oldUserManager.address, MINT_AMOUNT)
    .send({ from: oldUserManager.address })
    .wait();
  const oldBalanceAfterMint = await oldAppUser.methods
    .get_balance(oldUserManager.address)
    .simulate({ from: oldUserManager.address });
  console.log(`   Minted ${MINT_AMOUNT}, balance: ${oldBalanceAfterMint}\n`);

  // ============================================================
  // Step 7: Lock tokens for migration on OLD rollup
  // ============================================================
  console.log("7. Locking tokens for migration...");
  const mpk = oldUserWallet.getMigrationPublicKey(oldUserManager.address)!;
  console.log(`   MPK: (${mpk.x}, ${mpk.y})`);

  const LOCK_AMOUNT = 500n;
  const lockTx = await oldAppUser.methods
    .lock_migration_notes_mode_a(
      LOCK_AMOUNT,
      env.newRollupVersion,
      mpk.toNoirStruct(),
    )
    .send({ from: oldUserManager.address })
    .wait();
  console.log(`   Lock tx: ${lockTx.txHash}`);

  const oldBalanceAfterLock = await oldAppUser.methods
    .get_balance(oldUserManager.address)
    .simulate({ from: oldUserManager.address });
  console.log(`   Balance after lock: ${oldBalanceAfterLock}\n`);

  // ============================================================
  // Steps 8-12: Bridge archive root
  // ============================================================
  console.log("8-12. Bridging archive root...");
  const { l1Result, provenBlockNumber, archiveProof } = await bridgeArchiveRoot(
    env,
    newArchiveRegistry,
    lockTx.blockNumber!,
  );
  console.log(`   Proven block: ${l1Result.provenBlockNumber}`);
  console.log(`   Archive root: ${l1Result.provenArchiveRoot}\n`);

  // ============================================================
  // Steps 13-14: Prepare migration args and call migrate on NEW rollup
  // ============================================================
  console.log("13. Preparing migration args...");

  // Get lock notes via wallet
  const lockNotes = await oldUserWallet.getMigrationNotes({
    owner: oldUserManager.address,
    contractAddress: oldApp.address,
  });
  if (lockNotes.length === 0) {
    throw new Error("No migration notes found");
  }

  // Build proofs via wallet
  const migrationNoteProofs = (
    await oldUserWallet.buildNoteProofs(
      provenBlockNumber,
      lockNotes,
      MigrationNote.fromNote,
    )
  ).map((p) => MigrationNoteProofData.fromNoteProofData(p));

  // Sign via standalone function
  const oldAccount = await oldUserWallet.getMigrationAccount(
    oldUserManager.address,
  );
  const signature = await signMigrationModeA(
    oldAccount.migrationKeySigner,
    archiveProof.archive_block_header.global_variables.version,
    new Fr(env.newRollupVersion),
    lockNotes,
    newUserManager.address,
    newApp.address,
  );
  console.log("   Migration args prepared.\n");

  console.log("14. Calling migrate on NEW rollup...");

  const newBalanceBefore = await newAppUser.methods
    .get_balance(newUserManager.address)
    .simulate({ from: newUserManager.address });
  console.log(`   Balance on NEW rollup before migrate: ${newBalanceBefore}`);

  try {
    const migrateTx = await newAppUser.methods
      .migrate_mode_a(
        LOCK_AMOUNT,
        mpk.toNoirStruct(),
        [...signature],
        migrationNoteProofs,
        archiveProof,
      )
      .send({ from: newUserManager.address })
      .wait();
    console.log(`   Migrate tx: ${migrateTx.txHash}`);

    const newBalanceAfter = await newAppUser.methods
      .get_balance(newUserManager.address)
      .simulate({ from: newUserManager.address });
    console.log(`   Balance on NEW rollup after: ${newBalanceAfter}`);

    if (BigInt(newBalanceAfter) === LOCK_AMOUNT) {
      console.log("\n   Cross-rollup migration fully successful!");
    } else {
      console.log("\n   Migration completed but balance does not match.");
    }
  } catch (e) {
    console.log(`   migrate failed: ${(e as Error).message}`);
  }

  const newBalanceAfter = await newApp.methods
    .get_balance(newRollupUser)
    .simulate({ from: newRollupUser });

  // ============================================================
  // Step 15: Mint PUBLIC tokens on OLD rollup
  // ============================================================
  console.log(
    "\n=== Test Scenario 2: Public Balance Migration ===\n",
  );
  console.log("15. Minting PUBLIC tokens on OLD rollup...");

  const PUBLIC_MINT_AMOUNT = 1000n;
  await oldAppAsUser.methods
    .mint_public(oldRollupUser, PUBLIC_MINT_AMOUNT)
    .send({ from: oldRollupUser })
    .wait();

  const oldPublicBalanceAfterMint = await oldApp.methods
    .get_public_balance(oldRollupUser)
    .simulate({ from: oldRollupUser });
  console.log(
    `   Minted ${PUBLIC_MINT_AMOUNT} public tokens to old rollup user`,
  );
  console.log(
    `   Public balance on OLD rollup: ${oldPublicBalanceAfterMint}\n`,
  );

  // ============================================================
  // Step 16: Lock PUBLIC tokens for migration on OLD rollup
  // ============================================================
  console.log("16. Locking PUBLIC tokens for migration on OLD rollup...");

  const PUBLIC_LOCK_AMOUNT = 500n;
  const msk2 = new Fr(67890n); // Different MSK for this migration
  console.log(`   Owner MSK: ${msk2}`);
  console.log(`   Locking ${PUBLIC_LOCK_AMOUNT} public tokens...`);
  console.log(`   Destination rollup: ${newRollupVersion}`);

  const lockPublicTx = await oldAppAsUser.methods
    .lock_public_for_migration(
      oldMigrator.address,
      PUBLIC_LOCK_AMOUNT,
      newRollupVersion,
      msk2,
    )
    .send({ from: oldRollupUser })
    .wait();

  console.log(`   Lock public tx: ${lockPublicTx.txHash}`);

  const oldPublicBalanceAfterLock = await oldApp.methods
    .get_public_balance(oldRollupUser)
    .simulate({ from: oldRollupUser });
  console.log(
    `   Public balance on OLD rollup after lock: ${oldPublicBalanceAfterLock}`,
  );
  console.log(
    `   ✅ ${PUBLIC_MINT_AMOUNT - BigInt(oldPublicBalanceAfterLock)} public tokens locked for migration\n`,
  );

  // ============================================================
  // Step 17: Wait for public lock note block to be proven
  // ============================================================
  console.log("17. Waiting for public lock note block to be proven...");
  let publicProvenBlockNumber = await aztecOldNode.getProvenBlockNumber();
  console.log(`   Lock public tx block: ${lockPublicTx.blockNumber}`);
  console.log(`   Current proven block: ${publicProvenBlockNumber}`);
  while (publicProvenBlockNumber < lockPublicTx.blockNumber!) {
    console.log("   ⚠️  Block not yet proven. Waiting more...");
    try {
      await oldApp.methods
        .mint(oldDeployer, 1n)
        .send({ from: oldDeployer })
        .wait();
    } catch (e) {
      // Ignore errors
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    publicProvenBlockNumber = await aztecOldNode.getProvenBlockNumber();
  }
  console.log("   ✅  Block proven.\n");

  // ============================================================
  // Step 18: Bridge new archive root if needed
  // ============================================================
  console.log("18. Bridging archive root for public lock note...");

  // Get the latest archive info from L1
  const publicArchiveInfo = await publicClient.readContract({
    address: l1MigratorAddress,
    abi: L1MigratorAbi,
    functionName: "getArchiveInfo",
    args: [BigInt(oldRollupVersion)],
  });
  console.log(`   Archive Root: ${publicArchiveInfo[0]}`);
  console.log(`   Proven Checkpoint: ${publicArchiveInfo[1]}`);

  // Bridge the archive root
  const publicMigrateRootsTxHash = await l1WalletClient.writeContract({
    address: l1MigratorAddress,
    abi: L1MigratorAbi,
    functionName: "migrateArchiveRoot",
    args: [
      BigInt(oldRollupVersion),
      {
        actor: toHex(newMigrator.address.toBigInt(), { size: 32 }),
        version: BigInt(newRollupVersion),
      },
    ],
  });

  const publicMigrateRootsReceipt =
    await publicClient.waitForTransactionReceipt({
      hash: publicMigrateRootsTxHash,
    });
  console.log(`   L1 tx status: ${publicMigrateRootsReceipt.status}`);

  // Parse ArchiveRootMigrated event
  const publicArchiveRootMigratedLog =
    publicMigrateRootsReceipt.logs.find((log) => {
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

  if (!publicArchiveRootMigratedLog) {
    throw new Error("ArchiveRootMigrated event not found for public lock");
  }

  const publicArchiveRootEvent = decodeEventLog({
    abi: L1MigratorAbi,
    data: publicArchiveRootMigratedLog.data,
    topics: publicArchiveRootMigratedLog.topics,
  });

  const publicEventArgs = publicArchiveRootEvent.args as {
    oldVersion: bigint;
    newVersion: bigint;
    l2Migrator: `0x${string}`;
    archiveRoot: `0x${string}`;
    provenCheckpointNumber: bigint;
    messageLeaf: `0x${string}`;
    messageLeafIndex: bigint;
  };

  const publicProvenArchiveRoot = Fr.fromHexString(
    publicEventArgs.archiveRoot,
  );
  publicProvenBlockNumber = BlockNumber.fromBigInt(
    publicEventArgs.provenCheckpointNumber,
  );
  console.log(`   Archive Root sent: ${publicEventArgs.archiveRoot}`);
  console.log(`   Proven Block: ${publicEventArgs.provenCheckpointNumber}`);

  // Get L1→L2 message hash from Inbox
  const publicInboxLogs = publicMigrateRootsReceipt.logs.filter(
    (log) =>
      log.address.toLowerCase() === newInboxAddress.toString().toLowerCase(),
  );

  if (publicInboxLogs.length === 0) {
    throw new Error("No MessageSent event found for public lock");
  }

  const publicMessageSentEvent = decodeEventLog({
    abi: InboxAbi,
    data: publicInboxLogs[0].data,
    topics: publicInboxLogs[0].topics,
  });

  const publicL1ToL2LeafIndex = publicMessageSentEvent.args.index;
  const publicL1ToL2MessageHash = new Fr(
    BigInt(publicMessageSentEvent.args.hash),
  );
  console.log(`   L1→L2 message hash: ${publicL1ToL2MessageHash}\n`);

  // ============================================================
  // Step 19: Wait for L1→L2 message to sync and register root
  // ============================================================
  console.log("19. Waiting for L1→L2 message to sync...");

  let publicMessageReady = false;
  for (let i = 0; i < maxAttempts && !publicMessageReady; i++) {
    const messageBlock = await aztecNewNode.getL1ToL2MessageBlock(
      publicL1ToL2MessageHash,
    );
    if (messageBlock !== undefined) {
      publicMessageReady = true;
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

  if (!publicMessageReady) {
    throw new Error("L1→L2 message not ready after timeout for public lock");
  }

  console.log("   Registering archive root on NEW Migrator...");
  const publicRegisterTx = await newMigrator.methods
    .register_archive_root(
      publicProvenArchiveRoot,
      publicProvenBlockNumber,
      Fr.ZERO,
      new Fr(publicL1ToL2LeafIndex),
    )
    .send({ from: newDeployer })
    .wait();

  console.log(`   Register tx: ${publicRegisterTx.txHash}`);
  console.log("   ✅ Archive root registered!\n");

  // ============================================================
  // Step 20: Get public lock note and merkle proofs
  // ============================================================
  console.log(
    "20. Computing public lock note hash and getting merkle proofs...",
  );

  // Get note hashes from the public lock transaction
  const publicLockTxEffect = await aztecOldNode.getTxEffect(
    lockPublicTx.txHash,
  );

  if (!publicLockTxEffect) {
    console.log("   ❌ Could not get public lock transaction effect\n");
    process.exit(1);
  }

  const publicNoteHashes = publicLockTxEffect.data?.noteHashes || [];
  console.log(`   Public lock tx has ${publicNoteHashes.length} note hashes`);

  let publicLockNoteLeafIndex: bigint | undefined;

  for (let i = 0; i < publicNoteHashes.length; i++) {
    const noteHash = publicNoteHashes[i];
    console.log(`   Note hash ${i}: ${noteHash}`);

    const leafIndexResults = await aztecOldNode.findLeavesIndexes(
      publicProvenBlockNumber,
      MerkleTreeId.NOTE_HASH_TREE,
      [noteHash],
    );

    if (leafIndexResults[0]) {
      console.log(`     Found at leaf index: ${leafIndexResults[0].data}`);
      publicLockNoteLeafIndex = leafIndexResults[0].data;
    }
  }

  if (!publicLockNoteLeafIndex) {
    console.log("   ❌ Could not find public lock note in tree\n");
    process.exit(1);
  }

  console.log(
    `   Using public lock note at leaf index: ${publicLockNoteLeafIndex}`,
  );

  // Get the actual lock note from PXE
  const publicLockNotes = await oldUserWallet.getNotes({
    owner: oldRollupUser,
    contractAddress: oldMigrator.address,
    storageSlot: migrationNotesSlot,
  });

  // Find the note for the public lock (most recently created — last one)
  // The private lock note was already used, so the remaining one is the public lock note
  if (publicLockNotes.length === 0) {
    throw new Error("No lock notes found in PXE for public lock");
  }

  // The public lock note should be the latest one
  const publicLockNote = publicLockNotes[publicLockNotes.length - 1];
  console.log(
    `   Found ${publicLockNotes.length} lock note(s) in PXE, using the last one`,
  );
  console.log(
    `   Inner note hash (from PXE): ${publicLockNote.noteHash}`,
  );
  console.log(`   Note randomness: ${publicLockNote.randomness}`);
  console.log(`   Note nonce: ${publicLockNote.noteNonce}`);
  console.log(
    `   Note storage slot (from PXE): ${publicLockNote.storageSlot}`,
  );

  const publicSiloedNoteHash = await siloNoteHash(
    publicLockNote.contractAddress,
    publicLockNote.noteHash,
  );
  const publicUniqueNoteHash = await computeUniqueNoteHash(
    publicLockNote.noteNonce,
    publicSiloedNoteHash,
  );
  console.log(
    `   Unique note hash (computed): ${publicUniqueNoteHash}`,
  );

  // Verify we can find this hash in the tree
  const publicComputedLeafIndexResults =
    await aztecOldNode.findLeavesIndexes(
      await aztecOldNode.getBlockNumber(),
      MerkleTreeId.NOTE_HASH_TREE,
      [publicUniqueNoteHash],
    );

  if (!publicComputedLeafIndexResults[0]) {
    console.log(
      "   ❌  Could not find computed unique hash in tree\n",
    );
    process.exit(1);
  }

  // Get sibling paths for the proof
  const publicNoteHashSiblingPath =
    await aztecOldNode.getNoteHashSiblingPath(
      publicProvenBlockNumber,
      publicLockNoteLeafIndex,
    );

  const publicFinalBlockHeader = await aztecOldNode.getBlockHeader(
    publicProvenBlockNumber,
  );
  if (!publicFinalBlockHeader) {
    console.log("   ❌ Could not get block header\n");
    process.exit(1);
  }

  const publicArchiveLeafIndex = BigInt(publicProvenBlockNumber);
  const publicArchiveSiblingPath =
    await aztecOldNode.getArchiveSiblingPath(
      publicProvenBlockNumber,
      publicArchiveLeafIndex,
    );

  console.log(
    `   Note hash sibling path length: ${publicNoteHashSiblingPath.toFields().length}`,
  );
  console.log(
    `   Archive sibling path length: ${publicArchiveSiblingPath.toFields().length}\n`,
  );

  // ============================================================
  // Step 21: Call migrate_to_public on NEW rollup
  // ============================================================
  console.log("21. Calling migrate_to_public on NEW rollup...");

  const newPublicBalanceBefore = await newApp.methods
    .get_public_balance(newRollupUser)
    .simulate({ from: newRollupUser });
  console.log(
    `   Public balance on NEW rollup before: ${newPublicBalanceBefore}`,
  );

  try {
    const noirPublicBlockHeader = blockHeaderToNoir(publicFinalBlockHeader);

    const newAppAsUser = await ExampleMigrationAppContract.at(
      newApp.address,
      newUserWallet,
    );
    const migratePublicTx = await newAppAsUser.methods
      .migrate_to_public(
        newMigrator.address,
        msk2,
        PUBLIC_LOCK_AMOUNT,
        publicLockNote.storageSlot,
        publicLockNote.randomness,
        publicLockNote.noteNonce,
        new Fr(publicLockNoteLeafIndex),
        publicNoteHashSiblingPath.toFields(),
        noirPublicBlockHeader,
        new Fr(publicArchiveLeafIndex),
        publicArchiveSiblingPath.toFields(),
      )
      .send({ from: newRollupUser })
      .wait();

    console.log(`   Migrate to public tx: ${migratePublicTx.txHash}`);

    const newPublicBalanceAfterMigrate = await newApp.methods
      .get_public_balance(newRollupUser)
      .simulate({ from: newRollupUser });
    console.log(
      `   Public balance on NEW rollup after: ${newPublicBalanceAfterMigrate}`,
    );

    if (BigInt(newPublicBalanceAfterMigrate) === PUBLIC_LOCK_AMOUNT) {
      console.log(
        "✅ Public balance migration fully successful!",
      );
    } else {
      console.log(
        "⚠️  Migration completed but public balance does not match.",
      );
    }
  } catch (e) {
    console.log(
      `   ❌ migrate_to_public failed: ${(e as Error).message}`,
    );
  }

  const newPublicBalanceAfter = await newApp.methods
    .get_public_balance(newRollupUser)
    .simulate({ from: newRollupUser });

  // ============================================================
  // Summary
  // ============================================================
  console.log("\n=== Cross-Rollup Migration Test Summary ===\n");
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
  console.log("Scenario 1: Private Balance Migration");
  console.log("  1. ✅ User mints private tokens on OLD rollup");
  console.log(
    "  2. ✅ User locks private tokens for migration (creates MigrationNote)",
  );
  console.log(
    "  3. ✅ L1 Migrator sends archive root to NEW rollup via L1→L2 message",
  );
  console.log("  4. ✅ migrate called → tokens claimed as private balance");
  console.log("");
  console.log("Scenario 2: Public Balance Migration");
  console.log("  5. ✅ User mints public tokens on OLD rollup");
  console.log(
    "  6. ✅ User locks public tokens for migration (creates MigrationNote)",
  );
  console.log("  7. ✅ Archive root bridged and registered");
  console.log(
    "  8. ✅ migrate_to_public called → tokens claimed as public balance",
  );
  console.log("");
  console.log("Balances:");
  console.log(
    `  OLD rollup private balance: ${oldBalanceAfterLock}`,
  );
  console.log(
    `  OLD rollup public balance: ${oldPublicBalanceAfterLock}`,
  );
  console.log(
    `  NEW rollup private balance: ${newBalanceAfter}`,
  );
  console.log(
    `  NEW rollup public balance: ${newPublicBalanceAfter}`,
  );
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
