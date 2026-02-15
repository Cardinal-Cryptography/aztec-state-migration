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

  // ============================================================
  // Summary
  // ============================================================
  const finalBalance = await newAppUser.methods
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
