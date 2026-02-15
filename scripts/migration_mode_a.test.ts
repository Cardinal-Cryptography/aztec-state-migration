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
import { createLogger } from "@aztec/foundation/log";
import {
  MigrationNote,
  MigrationNoteProofData,
} from "../ts/migration-lib/types.js";

async function main() {
  const logger = createLogger("migration_mode_a_test");
  console.log("=== Cross-Rollup Migration E2E Test (Mode A) ===\n");

  // ============================================================
  // Deploy shared infrastructure
  // ============================================================
  const env = await deploy();

  const { aztecNode: oldAztecNode, migrationWallet: oldMigrationWallet } =
    env[env.oldRollupVersion];
  const { aztecNode: newAztecNode, migrationWallet: newMigrationWallet } =
    env[env.newRollupVersion];

  // ============================================================
  // Create user wallets (TestMigrationWallet)
  // ============================================================
  console.log("   Creating user wallets...");

  const oldUserManager = await deployAndFundAccount(env, oldAztecNode);
  const newUserManager = await deployAndFundAccount(env, newAztecNode);

  console.log(`   Old User: ${oldUserManager.address}`);
  console.log(`   New User: ${newUserManager.address}\n`);

  // ============================================================
  // Deploy L2 contracts
  // ============================================================
  console.log("4. Deploying L2 contracts...");
  const { oldApp, newApp } = await deployAppPair(env);
  console.log(`   old_example_app: ${oldApp.address}`);
  console.log(`   new_example_app: ${newApp.address}`);

  const newArchiveRegistry = await deployArchiveRegistry(env);
  console.log(`   new_archive_registry: ${newArchiveRegistry.address}\n`);

  // ============================================================
  // Step 6: Mint tokens on OLD rollup
  // ============================================================
  console.log("6. Minting tokens on OLD rollup...");
  const MINT_AMOUNT = 1000n;
  const oldAppAsUser = ExampleMigrationAppContract.at(
    oldApp.address,
    oldMigrationWallet,
  );
  await oldAppAsUser.methods
    .mint(oldUserManager.address, MINT_AMOUNT)
    .send({ from: oldUserManager.address })
    .wait();
  const oldBalanceAfterMint = await oldAppAsUser.methods
    .get_balance(oldUserManager.address)
    .simulate({ from: oldUserManager.address });
  console.log(`   Minted ${MINT_AMOUNT}, balance: ${oldBalanceAfterMint}\n`);

  // ============================================================
  // Step 7: Lock tokens for migration on OLD rollup
  // ============================================================
  console.log("7. Locking tokens for migration...");
  const mpk = oldMigrationWallet.getMigrationPublicKey(oldUserManager.address)!;
  console.log(`   MPK: (${mpk.x}, ${mpk.y})`);

  const LOCK_AMOUNT = 500n;
  const lockTx = await oldAppAsUser.methods
    .lock_migration_notes_mode_a(
      LOCK_AMOUNT,
      env.newRollupVersion,
      mpk.toNoirStruct(),
    )
    .send({ from: oldUserManager.address })
    .wait();
  console.log(`   Lock tx: ${lockTx.txHash}`);

  const oldBalanceAfterLock = await oldAppAsUser.methods
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
  const lockNotes = await oldMigrationWallet.getMigrationNotes({
    owner: oldUserManager.address,
    contractAddress: oldApp.address,
  });
  if (lockNotes.length === 0) {
    throw new Error("No migration notes found");
  }

  // Build proofs via wallet
  const migrationNoteProofs = (
    await oldMigrationWallet.buildNoteProofs(
      provenBlockNumber,
      lockNotes,
      MigrationNote.fromNote,
    )
  ).map((p) => MigrationNoteProofData.fromNoteProofData(p));

  // Sign via standalone function
  const oldAccount = await oldMigrationWallet.getMigrationAccount(
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
  const newAppAsUser = ExampleMigrationAppContract.at(
    newApp.address,
    newMigrationWallet,
  );

  const newBalanceBefore = await newAppAsUser.methods
    .get_balance(newUserManager.address)
    .simulate({ from: newUserManager.address });
  console.log(`   Balance on NEW rollup before migrate: ${newBalanceBefore}`);

  try {
    const migrateTx = await newAppAsUser.methods
      .migrate_mode_a(
        LOCK_AMOUNT,
        newArchiveRegistry.address,
        mpk.toNoirStruct(),
        [...signature],
        migrationNoteProofs,
        archiveProof,
      )
      .send({ from: newUserManager.address })
      .wait();
    console.log(`   Migrate tx: ${migrateTx.txHash}`);

    const newBalanceAfter = await newAppAsUser.methods
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

  // ============================================================
  // Summary
  // ============================================================
  const finalBalance = await newAppAsUser.methods
    .get_balance(newUserManager.address)
    .simulate({ from: newUserManager.address });
  console.log("\n=== Summary ===");
  console.log(`  OLD rollup balance: ${oldBalanceAfterLock}`);
  console.log(`  NEW rollup balance: ${finalBalance}`);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
