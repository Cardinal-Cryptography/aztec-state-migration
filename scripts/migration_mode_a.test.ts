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

    if (BigInt(newBalanceAfter) !== LOCK_AMOUNT) {
      throw new Error(
        `Migration completed but balance ${newBalanceAfter} does not match expected ${LOCK_AMOUNT}`,
      );
    }
    console.log("\n   Cross-rollup migration fully successful!");
  } catch (e) {
    throw new Error(`migrate_mode_a failed: ${(e as Error).message}`);
  }

  const newBalanceAfter = await newApp.methods
    .get_balance(newUserManager.address)
    .simulate({ from: newUserManager.address });

  // ============================================================
  // Step 15: Mint PUBLIC tokens on OLD rollup
  // ============================================================
  console.log("\n=== Test Scenario 2: Public Balance Migration ===\n");
  console.log("15. Minting PUBLIC tokens on OLD rollup...");

  const PUBLIC_MINT_AMOUNT = 1000n;
  await oldAppUser.methods
    .mint_public(oldUserManager.address, PUBLIC_MINT_AMOUNT)
    .send({ from: oldUserManager.address })
    .wait();

  const oldPublicBalanceAfterMint = await oldApp.methods
    .get_public_balance(oldUserManager.address)
    .simulate({ from: oldUserManager.address });
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
  console.log(`   Destination rollup: ${env.newRollupVersion}`);

  const lockPublicTx = await oldAppUser.methods
    .lock_public_for_migration(
      PUBLIC_LOCK_AMOUNT,
      env.newRollupVersion,
      oldUserWallet
        .getMigrationPublicKey(oldUserManager.address)!
        .toNoirStruct(),
    )
    .send({ from: oldUserManager.address })
    .wait();

  console.log(`   Lock public tx: ${lockPublicTx.txHash}`);

  const oldPublicBalanceAfterLock = await oldApp.methods
    .get_public_balance(oldUserManager.address)
    .simulate({ from: oldUserManager.address });
  console.log(
    `   Public balance on OLD rollup after lock: ${oldPublicBalanceAfterLock}`,
  );
  console.log(
    `   ✅ ${PUBLIC_MINT_AMOUNT - BigInt(oldPublicBalanceAfterLock)} public tokens locked for migration\n`,
  );

  // ============================================================
  // Step 18: Bridge new archive root if needed
  // ============================================================
  console.log("18. Bridging archive root for public lock note...");

  const {
    l1Result: l1ResultPublic,
    provenBlockNumber: publicProvenBlockNumber,
    archiveProof: publicArchiveProof,
  } = await bridgeArchiveRoot(env, newArchiveRegistry, lockTx.blockNumber!);
  console.log(`   Proven block: ${l1ResultPublic.provenBlockNumber}`);
  console.log(`   Archive root: ${l1ResultPublic.provenArchiveRoot}\n`);

  // ============================================================
  // Step 20: Get public lock note and merkle proofs
  // ============================================================
  console.log(
    "20. Computing public lock note hash and getting merkle proofs...",
  );

  // Get the actual lock note from PXE
  const publicLockNotes = await oldUserWallet.getNotes({
    owner: oldUserManager.address,
    contractAddress: oldApp.address,
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

  const publicMigrationNoteProofs = (
    await oldUserWallet.buildNoteProofs(
      publicProvenBlockNumber,
      [publicLockNote],
      MigrationNote.fromNote,
    )
  ).map((p) => MigrationNoteProofData.fromNoteProofData(p));

  // Sign via standalone function
  const publicSignature = await signMigrationModeA(
    oldAccount.migrationKeySigner,
    publicArchiveProof.archive_block_header.global_variables.version,
    new Fr(env.newRollupVersion),
    [publicLockNote],
    newUserManager.address,
    newApp.address,
  );

  // ============================================================
  // Step 21: Call migrate_to_public on NEW rollup
  // ============================================================
  console.log("21. Calling migrate_to_public on NEW rollup...");

  const newPublicBalanceBefore = await newAppUser.methods
    .get_public_balance(newUserManager.address)
    .simulate({ from: newUserManager.address });
  console.log(
    `   Public balance on NEW rollup before: ${newPublicBalanceBefore}`,
  );

  try {
    const migratePublicTx = await newAppUser.methods
      .migrate_to_public(
        PUBLIC_LOCK_AMOUNT,
        mpk.toNoirStruct(),
        [...publicSignature],
        publicMigrationNoteProofs,
        publicArchiveProof,
      )
      .send({ from: newUserManager.address })
      .wait();

    console.log(`   Migrate to public tx: ${migratePublicTx.txHash}`);

    const newPublicBalanceAfterMigrate = await newApp.methods
      .get_public_balance(newUserManager.address)
      .simulate({ from: newUserManager.address });
    console.log(
      `   Public balance on NEW rollup after: ${newPublicBalanceAfterMigrate}`,
    );

    if (BigInt(newPublicBalanceAfterMigrate) !== PUBLIC_LOCK_AMOUNT) {
      throw new Error(
        `Migration completed but public balance ${newPublicBalanceAfterMigrate} does not match expected ${PUBLIC_LOCK_AMOUNT}`,
      );
    }
    console.log("   Public balance migration fully successful!");
  } catch (e) {
    throw new Error(`migrate_to_public failed: ${(e as Error).message}`);
  }

  const newPublicBalanceAfter = await newApp.methods
    .get_public_balance(newUserManager.address)
    .simulate({ from: newUserManager.address });

  // ============================================================
  // Summary
  // ============================================================

  console.log("Balances:");
  console.log(`  OLD rollup private balance: ${oldBalanceAfterLock}`);
  console.log(`  OLD rollup public balance: ${oldPublicBalanceAfterLock}`);
  console.log(`  NEW rollup private balance: ${newBalanceAfter}`);
  console.log(`  NEW rollup public balance: ${newPublicBalanceAfter}`);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
