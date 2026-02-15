import { Fr } from "@aztec/foundation/curves/bn254";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { signMigrationModeB } from "../ts/migration-lib/index.js";
import { deploy } from "./deploy.js";
import {
  deployAppPair,
  deployArchiveRegistry,
  deployKeyRegistry,
  bridgeArchiveRoot,
  deployAndFundAccount,
} from "./test-utils.js";
import { ExampleMigrationAppContract } from "../noir/target/artifacts/ExampleMigrationApp.js";
import { MigrationKeyRegistryContract } from "../noir/target/artifacts/MigrationKeyRegistry.js";
import { KeyNote, UintNote } from "../ts/migration-lib/types.js";
import { NoteStatus } from "@aztec/stdlib/note";

async function main() {
  console.log("=== Mode B (Emergency Snapshot) Migration E2E Test ===\n");

  // ============================================================
  // Deploy shared infrastructure
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
  // Create user wallets (MigrationTestWallet)
  // ============================================================
  console.log("   Creating user wallets...");

  const oldUserManager = await deployAndFundAccount(env, oldAztecNode);
  const newUserManager = await deployAndFundAccount(env, newAztecNode);

  console.log(`   Old User: ${oldUserManager.address}`);
  console.log(`   New User: ${newUserManager.address}`);

  // ============================================================
  // Deploy L2 contracts
  // ============================================================
  console.log("4. Deploying L2 contracts...");

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
  // Step 6: Mint tokens to Alice on OLD rollup
  // ============================================================
  console.log("6. Minting tokens to Alice on OLD rollup...");

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
  // Step 7: Register migration key for Alice
  // ============================================================
  console.log("7. Registering migration key for Alice...");

  const mpk = oldUserWallet.getMigrationPublicKey(oldUserManager.address)!;
  const mpkHash = await poseidon2Hash([mpk.x, mpk.y]);
  console.log(`   mpk: (${mpk.x}, ${mpk.y})`);
  console.log(`   mpk_hash: ${mpkHash}`);

  const oldUserKeyRegistry = MigrationKeyRegistryContract.at(
    oldKeyRegistry.address,
    oldUserWallet,
  );

  const registerTx = await oldUserKeyRegistry.methods
    .register(mpkHash)
    .send({ from: oldUserManager.address })
    .wait();
  console.log(`   Register tx: ${registerTx.txHash}`);

  const registeredKey = await oldUserKeyRegistry.methods
    .get(oldUserManager.address)
    .simulate({ from: oldUserManager.address });
  console.log(`   Verified registered mpk_hash: ${registeredKey}\n`);

  // ============================================================
  // Steps 8-10: Bridge + set snapshot height
  // ============================================================
  console.log("8-10. Bridging archive root and setting snapshot height...");

  const { l1Result, provenBlockNumber, archiveProof } = await bridgeArchiveRoot(
    env,
    newArchiveRegistry,
    registerTx.blockNumber!,
  );
  console.log(
    `   Bridge complete. Proven block: ${l1Result.provenBlockNumber}`,
  );
  console.log(`   Archive root: ${l1Result.provenArchiveRoot}`);

  // Set snapshot height for Mode B
  const setSnapshotTx = await newArchiveRegistry.methods
    .set_snapshot_height(l1Result.provenBlockNumber)
    .send({ from: newDeployerManager.address })
    .wait();
  console.log(`   Set snapshot height tx: ${setSnapshotTx.txHash}`);

  const storedSnapshot = await newArchiveRegistry.methods
    .get_snapshot_height()
    .simulate({ from: newDeployerManager.address });
  console.log(`   Stored snapshot height: ${storedSnapshot}\n`);

  // ============================================================
  // Step 11: Derive account keys for Mode B
  // ============================================================
  console.log("11. Deriving account keys...");

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
  // Step 12: Build proofs and sign
  // ============================================================
  console.log("12. Building proofs and signing...");

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
  const [fullProofs, keyNoteProof] = await Promise.all([
    oldUserWallet.buildNoteAndNullifierProofs(
      provenBlockNumber,
      balanceNotes,
      (note) => UintNote.fromNote(note),
    ),
    oldUserWallet
      .buildNoteAndNullifierProofs(provenBlockNumber, [keyNotes[0]], (note) =>
        KeyNote.fromNote(note),
      )
      .then((p) => p[0]),
  ]);

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

  console.log(`   Balance note proofs: ${fullProofs.length}`);
  console.log(`   Migration args prepared.\n`);

  // ============================================================
  // Step 13: Call migrate_mode_b on NEW rollup
  // ============================================================
  console.log("13. Calling migrate_mode_b on NEW rollup...");


  // The ExampleMigrationApp currently only supports migrating one note at a time.
  const noteProof = fullProofs[0];
  const migrateAmount = noteProof.note.value;
  console.log(`   Migrating amount: ${migrateAmount}`);

  const newBalanceBefore = await newAppUser.methods
    .get_balance(newUserManager.address)
    .simulate({ from: newUserManager.address });
  console.log(`   Balance on NEW rollup before : ${newBalanceBefore}`);

  try {
    const migrateTx = await newAppUser.methods
      .migrate_mode_b(
        migrateAmount,
        mpk.toNoirStruct(),
        [...signature],
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

    console.log(`   Migrate tx: ${migrateTx.txHash}`);

    const newBalanceAfter = await newAppUser.methods
      .get_balance(newUserManager.address)
      .simulate({ from: newUserManager.address });
    console.log(`   Balance on NEW rollup after : ${newBalanceAfter}`);

    if (BigInt(newBalanceAfter) >= migrateAmount) {
      console.log(
        "\n   Mode B migration successful! Balance matches migrated amount.",
      );
    } else {
      console.log(
        "\n   Migration completed but balance does not match expected amount.",
      );
    }
  } catch (e) {
    const err = e as Error;
    console.log(`   migrate_mode_b failed: ${err.message}`);
    if (err.stack) {
      console.log(
        `   Stack: ${err.stack.split("\n").slice(0, 10).join("\n   ")}`,
      );
    }
  }

  // ============================================================
  // Step 13: Call migrate_mode_b on NEW rollup with nullified note (should fail)
  // ============================================================
  console.log(
    "14. Calling migrate_mode_b on NEW rollup with nullified note (should fail)...",
  );

  if (balanceNotesNullified.length === 0) {
    throw new Error("No nullified balance notes found to test failure case");
  }

  // Take one nullified note
  const nullifiedNote = balanceNotesNullified[0];

  const [nullifiedNoteProof] = await oldUserWallet.buildNoteAndNullifierProofs(
    provenBlockNumber,
    [nullifiedNote],
    (note) => UintNote.fromNote(note),
  );

  const nullifedNoteSig = await signMigrationModeB(
    oldAccount.migrationKeySigner,
    archiveProof.archive_block_header.global_variables.version,
    new Fr(env.newRollupVersion),
    [nullifiedNote],
    newUserManager.address,
    newApp.address,
  );

  const amount = nullifiedNoteProof.note.value;

  try {
    await newAppUser.methods
      .migrate_mode_b(
        amount,
        mpk.toNoirStruct(),
        [...nullifedNoteSig],
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
  } catch (e) {
    const err = e as Error;
    if (err.message.includes("Note nullifier non-inclusion")) {
      console.log("   Expected failure: Note is not active");
    } else {
      console.log(`   Unexpected error: ${err.message}`);
    }
  }
  // ============================================================

  // ============================================================
  // Summary
  // ============================================================
  const newBalanceAfter = await newAppUser.methods
    .get_balance(newUserManager.address)
    .simulate({ from: newUserManager.address });

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
