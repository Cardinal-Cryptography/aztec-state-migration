import { Fr } from "@aztec/foundation/curves/bn254";
import { signMigrationModeB } from "../ts/migration-lib/index.js";
import { deploy } from "./deploy.js";
import {
  deployAppPair,
  deployArchiveRegistry,
  deployKeyRegistry,
  bridgeArchiveRoot,
  deployAndFundAccount,
} from "./test-utils.js";
import { ExampleMigrationAppContract } from "../ts/migration-lib/noir-contracts/ExampleMigrationApp.js";
import { MigrationKeyRegistryContract } from "../ts/migration-lib/noir-contracts/MigrationKeyRegistry.js";
import { UintNote } from "../ts/migration-lib/common-notes.js";
import { NoteStatus } from "@aztec/stdlib/note";

async function main() {
  console.log("=== Mode B (Emergency Snapshot) Migration E2E Test ===\n");

  // ============================================================
  // Step 0: Deploy shared infrastructure
  // ============================================================
  const env = await deploy();

  const {
    aztecNode: oldAztecNode,
    deployerManager: oldDeployerManager,
    migrationWallet: oldUserWallet,
  } = env[env.oldRollupVersion];
  const {
    aztecNode: newAztecNode,
    deployerManager: newDeployerManager,
    migrationWallet: newUserWallet,
  } = env[env.newRollupVersion];

  // ============================================================
  // Step 1: Create user wallets (MigrationTestWallet)
  // ============================================================
  console.log("Step 1. Creating user wallets...");

  const oldUserManager = await deployAndFundAccount(env, oldAztecNode);
  const newUserManager = await deployAndFundAccount(env, newAztecNode);

  console.log(`   Old User: ${oldUserManager.address}`);
  console.log(`   New User: ${newUserManager.address}`);

  // ============================================================
  // Step 2: Deploy L2 contracts
  // ============================================================
  console.log("Step 2. Deploying L2 contracts...");

  const oldKeyRegistry = await deployKeyRegistry(env);
  console.log(`   old_key_registry: ${oldKeyRegistry.address}`);

  const newArchiveRegistry = await deployArchiveRegistry(
    env,
    oldKeyRegistry.address,
  );

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

  console.log(`   new_archive_registry: ${newArchiveRegistry.address}\n`);

  // ============================================================
  // Step 3: Mint tokens to Alice on OLD rollup
  // ============================================================
  console.log("Step 3. Minting tokens to Alice on OLD rollup...");

  const MINT_AMOUNT_1 = 500n;
  const MINT_AMOUNT_2 = 300n;
  const BURN_AMOUNT_1 = 150n;

  await oldApp.methods
    .mint(oldUserManager.address, MINT_AMOUNT_1)
    .send({ from: oldDeployerManager.address })
    .wait();
  console.log(`   Minted ${MINT_AMOUNT_1} tokens (mint 1)`);

  await oldApp.methods
    .mint(oldUserManager.address, MINT_AMOUNT_2)
    .send({ from: oldDeployerManager.address })
    .wait();
  console.log(`   Minted ${MINT_AMOUNT_2} tokens (mint 2)`);

  await oldAppUser.methods
    .burn(oldUserManager.address, BURN_AMOUNT_1)
    .send({ from: oldUserManager.address })
    .wait();
  console.log(`   Burned ${BURN_AMOUNT_1} tokens (burn 1)`);

  const oldBalance = await oldAppUser.methods
    .get_balance(oldUserManager.address)
    .simulate({ from: oldUserManager.address });
  console.log(`   Total balance on OLD rollup: ${oldBalance}\n`);

  // ============================================================
  // Step 4: Register migration key for Alice
  // ============================================================
  console.log("Step 4. Registering migration key for Alice...");

  const mpk = oldUserWallet.getMigrationPublicKey(oldUserManager.address)!;

  const oldUserKeyRegistry = MigrationKeyRegistryContract.at(
    oldKeyRegistry.address,
    oldUserWallet,
  );

  await oldUserKeyRegistry.methods
    .register(mpk.toNoirStruct())
    .send({ from: oldUserManager.address })
    .wait();

  const registeredKey = await oldUserKeyRegistry.methods
    .get(oldUserManager.address)
    .simulate({ from: oldUserManager.address });
  console.log(`   Verified registered mpk: ${registeredKey}\n`);

  // ============================================================
  // Steps 5-7: Bridge + set snapshot height
  // ============================================================
  console.log("Step 5-7. Bridging archive root and setting snapshot height...");

  const { l1Result, provenBlockNumber, archiveProof } = await bridgeArchiveRoot(
    env,
    newArchiveRegistry,
  );
  console.log(
    `   Bridge complete. Proven block: ${l1Result.provenBlockNumber}`,
  );
  console.log(`   Archive root: ${l1Result.provenArchiveRoot}`);

  // Set snapshot height for Mode B
  await newArchiveRegistry.methods
    .set_snapshot_height(l1Result.provenBlockNumber)
    .send({ from: newDeployerManager.address })
    .wait();

  const storedSnapshot = await newArchiveRegistry.methods
    .get_snapshot_height()
    .simulate({ from: newDeployerManager.address });
  console.log(`   Stored snapshot height: ${storedSnapshot}\n`);

  // ============================================================
  // Step 8: Derive account keys for Mode B
  // ============================================================
  console.log("Step 8. Deriving account keys...");

  const publicKeys = oldUserWallet.getPublicKeys(oldUserManager.address)!;
  const completeAddress = await oldUserManager.getCompleteAddress();
  const partialAddress = completeAddress.partialAddress;
  const oldMigrationAccount = await oldUserWallet.getMigrationAccount(
    oldUserManager.address,
  );
  const newMigrationAccount = await newUserWallet.getMigrationAccount(
    newUserManager.address,
  );
  const nsk = await oldMigrationAccount.getMaskedNsk(
    newMigrationAccount,
    oldApp.address,
  );

  console.log(`   nsk derived`);
  console.log(`   Partial address: ${partialAddress}\n`);

  // ============================================================
  // Step 9: Build proofs and sign
  // ============================================================
  console.log("Step 9. Building proofs and signing...");

  const keyRegistrySlot =
    oldKeyRegistry.artifact.storageLayout["registered_keys"].slot;
  const balancesSlot = oldApp.artifact.storageLayout["balances"].slot;

  const keyNotes = await oldUserWallet.getNotes({
    owner: oldUserManager.address,
    contractAddress: oldKeyRegistry.address,
    storageSlot: keyRegistrySlot,
  });

  const balanceNotesAll = await oldUserWallet.getNotes({
    owner: oldUserManager.address,
    contractAddress: oldApp.address,
    storageSlot: balancesSlot,
    status: NoteStatus.ACTIVE_OR_NULLIFIED,
  });

  const balanceNotesActive = await oldUserWallet.getNotes({
    owner: oldUserManager.address,
    contractAddress: oldApp.address,
    storageSlot: balancesSlot,
    status: NoteStatus.ACTIVE,
  });

  const balanceNotesNullified = balanceNotesAll.filter(
    (n) => !balanceNotesActive.some((a) => a.equals(n)),
  );

  if (balanceNotesActive.length === 0) {
    throw new Error("No active balance notes found");
  }
  if (keyNotes.length === 0) {
    throw new Error("No key notes found");
  }

  // The ExampleMigrationApp currently only creates one note per call.
  const balanceNotes = balanceNotesActive.slice(0, 1);

  // Build proofs via wallet
  const fullProofs = await oldUserWallet.buildFullNoteProofs(
    provenBlockNumber,
    balanceNotes,
    (note) => UintNote.fromNote(note),
  );

  const keyNoteProof = await oldUserWallet.buildKeyNoteProofData(
    oldKeyRegistry.address,
    oldUserManager.address,
    provenBlockNumber,
  );

  // Sign via standalone function
  const oldAccount = await oldUserWallet.getMigrationAccount(
    oldUserManager.address,
  );
  const signature = await signMigrationModeB(
    oldAccount.migrationKeySigner,
    archiveProof.archive_block_header.global_variables.version,
    new Fr(env.newRollupVersion),
    balanceNotes,
    newUserManager.address,
    newApp.address,
  );

  console.log(`   Migration args prepared.\n`);

  // ============================================================
  // Step 10: Call migrate_mode_b on NEW rollup
  // ============================================================
  console.log("Step 10. Calling migrate_mode_b on NEW rollup...");

  // The ExampleMigrationApp currently only supports migrating one note at a time.
  const noteProof = fullProofs[0];
  const migrateAmount = noteProof.note_proof_data.data.value;
  console.log(`   Migrating amount: ${migrateAmount}`);

  const newBalanceBefore = await newAppUser.methods
    .get_balance(newUserManager.address)
    .simulate({ from: newUserManager.address });
  console.log(`   Balance on NEW rollup before : ${newBalanceBefore}`);

  await newAppUser.methods
    .migrate_mode_b(
      migrateAmount,
      signature,
      [noteProof],
      archiveProof,
      oldUserManager.address,
      publicKeys.toNoirStruct(),
      partialAddress,
      keyNoteProof,
      { hi: nsk.hi, lo: nsk.lo },
    )
    .send({ from: newUserManager.address })
    .wait();

  const newBalanceAfter = await newAppUser.methods
    .get_balance(newUserManager.address)
    .simulate({ from: newUserManager.address });
  console.log(`   Balance on NEW rollup after : ${newBalanceAfter}`);

  if (BigInt(newBalanceAfter) !== migrateAmount) {
    throw new Error(
      `Migration completed but balance ${newBalanceAfter} does not match expected ${migrateAmount}`,
    );
  }
  console.log(
    "\n   Mode B migration successful! Balance matches migrated amount.",
  );

  // ============================================================
  // Step 11: Call migrate_mode_b on NEW rollup with nullified note (should fail)
  // ============================================================
  console.log(
    "Step 11. Calling migrate_mode_b on NEW rollup with nullified note (should fail)...",
  );

  if (balanceNotesNullified.length === 0) {
    throw new Error("No nullified balance notes found to test failure case");
  }

  // Take one nullified note
  const nullifiedNote = balanceNotesNullified[0];

  const [nullifiedNoteProof] = await oldUserWallet.buildFullNoteProofs(
    provenBlockNumber,
    [nullifiedNote],
    (note) => UintNote.fromNote(note),
  );

  const nullifiedNoteSig = await signMigrationModeB(
    oldAccount.migrationKeySigner,
    archiveProof.archive_block_header.global_variables.version,
    new Fr(env.newRollupVersion),
    [nullifiedNote],
    newUserManager.address,
    newApp.address,
  );

  const amount = nullifiedNoteProof.note_proof_data.data.value;

  try {
    let res = await newAppUser.methods
      .migrate_mode_b(
        amount,
        nullifiedNoteSig,
        [nullifiedNoteProof],
        archiveProof,
        oldUserManager.address,
        publicKeys.toNoirStruct(),
        partialAddress,
        keyNoteProof,
        { hi: nsk.hi, lo: nsk.lo },
      )
      .send({ from: newUserManager.address })
      .wait();
    if (!res.status.includes("reverted")) {
      throw new Error(
        "Expected migration of nullified note to fail, but it succeeded",
      );
    } else {
      if (!res.error.includes("Note nullifier non-inclusion")) {
        throw new Error(
          `Migration failed as expected, but with unexpected error: ${res.error}`,
        );
      }
    }
  } catch (e) {
    const err = e as Error;
    if (!err.message.includes("Note nullifier non-inclusion")) {
      throw new Error(
        `Unexpected error during nullified note test: ${err.message}`,
      );
    }
  }
  console.log("   Expected failure: Note is not active");
  // ============================================================

  // ============================================================
  // Summary
  // ============================================================

  console.log("\n=== Mode B Migration Test Summary ===\n");
  console.log("Contracts deployed:");
  console.log("  OLD Rollup (L2):");
  console.log(`    - ExampleMigrationApp: ${oldApp.address}`);
  console.log(`    - MigrationKeyRegistry: ${oldKeyRegistry.address}`);
  console.log("  NEW Rollup (L2):");
  console.log(`    - MigrationArchiveRegistry: ${newArchiveRegistry.address}`);
  console.log(`    - ExampleMigrationApp: ${newApp.address}`);
  console.log(`\nSnapshot height: ${l1Result.provenBlockNumber}`);
  console.log(`Migrated amount: ${migrateAmount}`);
  console.log("\nBalances:");
  console.log(`  OLD rollup: ${oldBalance}`);
  console.log(`  NEW rollup: ${newBalanceAfter}`);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
