import { ExampleMigrationAppContract } from "../noir/target/artifacts/ExampleMigrationApp.js";
import { Fr } from "@aztec/foundation/curves/bn254";
import { MigrationClient } from "../ts/migration-lib/index.js";
import { deploy } from "./deploy.js";

async function main() {
  console.log("=== Cross-Rollup Migration E2E Test ===\n");

  // ============================================================
  // Deploy all contracts (phases 1-5)
  // ============================================================
  const env = await deploy();

  const {
    l1MigratorAddress,
    oldApp,
    newMigrator,
    newApp,
    oldRollupVersion,
    newRollupVersion,
    aztecOldNode,
    aztecNewNode,
    oldRollupWallet: oldUserWallet,
    newRollupWallet: newUserWallet,
    oldDeployer,
    oldRollupUser,
    newDeployer,
    newRollupUser,
    publicClient,
    l1WalletClient,
    newInboxAddress,
  } = env;

  // ============================================================
  // Create MigrationClient
  // ============================================================
  const migrationClient = new MigrationClient({
    oldNode: aztecOldNode,
    newNode: aztecNewNode,
    l1PublicClient: publicClient,
    l1WalletClient,
    l1MigratorAddress,
    newMigrator,
    oldRollupVersion,
    newRollupVersion,
    newInboxAddress,
  });

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
  console.log(`   Minted ${MINT_AMOUNT}, balance: ${oldBalanceAfterMint}\n`);

  // ============================================================
  // Step 7: Lock tokens for migration on OLD rollup
  // ============================================================
  console.log("7. Locking tokens for migration...");
  const { lockArgs, msk, mpk } = await migrationClient.prepareMigrationNoteLock();
  console.log(`   MPK: (${mpk.x}, ${mpk.y})`);

  const LOCK_AMOUNT = 500n;
  const oldAppAsUser = ExampleMigrationAppContract.at(
    oldApp.address,
    oldUserWallet,
  );
  const lockTx = await oldAppAsUser.methods
    .lock_migration_notes_mode_a(
      LOCK_AMOUNT,
      lockArgs.destinationRollup,
      lockArgs.mpk,
    )
    .send({ from: oldRollupUser })
    .wait();
  console.log(`   Lock tx: ${lockTx.txHash}`);

  const oldBalanceAfterLock = await oldApp.methods
    .get_balance(oldRollupUser)
    .simulate({ from: oldRollupUser });
  console.log(`   Balance after lock: ${oldBalanceAfterLock}\n`);

  // ============================================================
  // Steps 8-12: Bridge (fully orchestrated by MigrationClient)
  // ============================================================
  console.log("8-12. Bridging archive root (proof wait → L1 tx → message sync → register)...");
  const bridgeResult = await migrationClient.bridge(lockTx.blockNumber!, {
    newRollupSender: newDeployer,
    onProofPoll: async (currentProvenBlock) => {
      console.log(
        `   Block ${lockTx.blockNumber} not yet proven (at ${currentProvenBlock}). Waiting...`,
      );
      try {
        await oldApp.methods
          .mint(oldDeployer, 1n)
          .send({ from: oldDeployer })
          .wait();
      } catch {
        // Ignore
      }
    },
    onMessagePoll: async (attempt) => {
      console.log(`   Waiting for L1→L2 message... attempt ${attempt}`);
      try {
        await newApp.methods
          .mint(newDeployer, 1n)
          .send({ from: newDeployer })
          .wait();
      } catch {
        // Ignore
      }
    },
  });
  console.log(`   Bridge complete. Proven block: ${bridgeResult.provenBlockNumber}`);
  console.log(`   Archive root: ${bridgeResult.provenArchiveRoot}`);
  console.log(`   Register tx: ${bridgeResult.registerTxHash}\n`);

  const storedArchiveRoot = await newMigrator.methods
    .get_old_archive_root(bridgeResult.provenBlockNumber)
    .simulate({ from: newDeployer });
  console.log(`   Stored archive root: ${new Fr(storedArchiveRoot)}\n`);

  // ============================================================
  // Steps 13-14: Prepare migration args and call migrate on NEW rollup
  // ============================================================
  console.log("13. Preparing migration args...");
  const { migrateArgs } = await migrationClient.prepareMigrateModeA({
    msk,
    oldAppAddress: oldApp.address,
    oldUserWallet,
    oldOwner: oldRollupUser,
    provenBlockNumber: bridgeResult.provenBlockNumber,
  });
  console.log("   Migration args prepared.\n");

  console.log("14. Calling migrate on NEW rollup...");
  const newBalanceBefore = await newApp.methods
    .get_balance(newRollupUser)
    .simulate({ from: newRollupUser });
  console.log(`   Balance on NEW rollup before: ${newBalanceBefore}`);

  try {
    const newAppAsUser = await ExampleMigrationAppContract.at(
      newApp.address,
      newUserWallet,
    );
    const migrateTx = await newAppAsUser.methods
      .migrate_mode_a(
        LOCK_AMOUNT,
        migrateArgs.migratorAddress,
        migrateArgs.migrationArgs,
        migrateArgs.fullMigrationNote,
      )
      .send({ from: newRollupUser })
      .wait();
    console.log(`   Migrate tx: ${migrateTx.txHash}`);

    const newBalanceAfter = await newApp.methods
      .get_balance(newRollupUser)
      .simulate({ from: newRollupUser });
    console.log(`   Balance on NEW rollup after: ${newBalanceAfter}`);

    if (BigInt(newBalanceAfter) === LOCK_AMOUNT) {
      console.log("\n✅ Cross-rollup migration fully successful!");
    } else {
      console.log("\n⚠️  Migration completed but balance does not match.");
    }
  } catch (e) {
    console.log(`   ❌ migrate failed: ${(e as Error).message}`);
  }

  // ============================================================
  // Summary
  // ============================================================
  const finalBalance = await newApp.methods
    .get_balance(newRollupUser)
    .simulate({ from: newRollupUser });
  console.log("\n=== Summary ===");
  console.log(`  OLD rollup balance: ${oldBalanceAfterLock}`);
  console.log(`  NEW rollup balance: ${finalBalance}`);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
