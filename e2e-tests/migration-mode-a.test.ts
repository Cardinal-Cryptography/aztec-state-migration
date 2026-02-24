import { ExampleMigrationAppV1Contract } from "./artifacts/ExampleMigrationAppV1.js";
import { ExampleMigrationAppV2Contract } from "./artifacts/ExampleMigrationAppV2.js";
import { Fr } from "@aztec/foundation/curves/bn254";
import { signMigrationModeA } from "../ts/aztec-state-migration/index.js";
import { deploy } from "./deploy.js";
import {
  deployAppPair,
  deployArchiveRegistry,
  bridgeBlock,
  deployAndFundAccount,
  assertEq,
} from "./test-utils.js";
import { AbiType } from "@aztec/stdlib/abi";

/** ABI type for decoding the MigrationDataEvent payload.
 *  The ExampleApp passes raw `amount` (u128) as migration_data.
 *  #[derive(Serialize)] flattens MigrationDataEvent<u128> to a single Field,
 *  so { kind: "field" } decodes it as a bigint. */
const MIGRATION_DATA_TYPE: AbiType = { kind: "field" };

async function main() {
  console.log("=== Cross-Rollup Migration E2E Test (Mode A) ===\n");

  // ============================================================
  // Step 0: Deploy shared infrastructure
  // ============================================================
  const env = await deploy();

  const { aztecNode: oldAztecNode, migrationWallet: oldUserWallet } =
    env[env.oldRollupVersion];
  const { aztecNode: newAztecNode, migrationWallet: newUserWallet } =
    env[env.newRollupVersion];

  // ============================================================
  // Step 1: Create user wallets (MigrationTestWallet)
  // ============================================================
  console.log("Step 1. Creating user wallets...");

  const oldUserManager = await deployAndFundAccount(env, oldAztecNode);
  const newUserManager = await deployAndFundAccount(env, newAztecNode);

  console.log(`   Old User: ${oldUserManager.address}`);
  console.log(`   New User: ${newUserManager.address}\n`);

  // ============================================================
  // Step 2: Deploy L2 contracts
  // ============================================================
  console.log("Step 2. Deploying L2 contracts...");

  const newArchiveRegistry = await deployArchiveRegistry(env);
  console.log(`   new_archive_registry: ${newArchiveRegistry.address}\n`);

  const { oldApp, newApp } = await deployAppPair(
    env,
    newArchiveRegistry.address,
  );
  const oldAppUser = ExampleMigrationAppV1Contract.at(
    oldApp.address,
    oldUserWallet,
  );
  const newAppUser = ExampleMigrationAppV2Contract.at(
    newApp.address,
    newUserWallet,
  );
  console.log(`   old_example_app: ${oldApp.address}`);
  console.log(`   new_example_app: ${newApp.address}`);

  // ============================================================
  // Step 3: Mint tokens on OLD rollup
  // ============================================================
  console.log("Step 3. Minting tokens on OLD rollup...");
  const MINT_AMOUNT = 1000n;
  await oldAppUser.methods
    .mint(oldUserManager.address, MINT_AMOUNT)
    .send({ from: oldUserManager.address });
  const oldBalanceAfterMint = await oldAppUser.methods
    .get_balance(oldUserManager.address)
    .simulate({ from: oldUserManager.address });
  console.log(`   Minted ${MINT_AMOUNT}, balance: ${oldBalanceAfterMint}\n`);

  // ============================================================
  // Step 4: Lock tokens for migration on OLD rollup
  // ============================================================
  console.log("Step 4. Locking tokens for migration...");
  const mpk = await oldUserWallet.getMigrationPublicKey(
    oldUserManager.address,
  )!;
  console.log(`   MPK: (${mpk.x}, ${mpk.y})`);

  const LOCK_AMOUNT = 300n;
  await oldAppUser.methods
    .lock_migration_notes_mode_a(
      LOCK_AMOUNT,
      env.newRollupVersion,
      mpk.toNoirStruct(),
    )
    .send({ from: oldUserManager.address });

  const oldBalanceAfterLock = await oldAppUser.methods
    .get_balance(oldUserManager.address)
    .simulate({ from: oldUserManager.address });
  console.log(`   Balance after lock: ${oldBalanceAfterLock}\n`);

  // ============================================================
  // Step 5: Bridge archive root
  // ============================================================
  console.log("Step 5. Bridging archive root...");
  const { l1Result, provenBlockNumber, blockHeader } = await bridgeBlock(
    env,
    newArchiveRegistry,
  );
  console.log(`   Proven block: ${l1Result.provenBlockNumber}`);
  console.log(`   Archive root: ${l1Result.provenArchiveRoot}\n`);

  // ============================================================
  // Steps 6-7: Prepare migration args and call migrate on NEW rollup
  // ============================================================
  console.log("Step 6. Preparing migration args...");

  // Get lock notes via wallet
  const lockNotesAndData = await oldUserWallet.getMigrationNotesAndData<bigint>(
    oldApp.address,
    oldUserManager.address,
    MIGRATION_DATA_TYPE,
  );
  if (lockNotesAndData.length !== 1) {
    throw new Error(
      `Expected exactly 1 migration note, but found ${lockNotesAndData.length}`,
    );
  }

  // Build proofs via wallet, combining note proofs with event data
  const [migrationNoteProof] = await oldUserWallet.buildMigrationNoteProofs(
    provenBlockNumber,
    lockNotesAndData,
  );

  // Sign via standalone function
  const oldMigrationSigner = await oldUserWallet.getMigrationSignerFromAddress(
    oldUserManager.address,
  );

  const signature = await signMigrationModeA(
    oldMigrationSigner,
    blockHeader.global_variables.version,
    new Fr(env.newRollupVersion),
    lockNotesAndData.map(({ note }) => note),
    newUserManager.address,
    newApp.address,
  );

  console.log("Step 7. Calling migrate on NEW rollup...");

  const newBalanceBefore = await newAppUser.methods
    .get_balance(newUserManager.address)
    .simulate({ from: newUserManager.address });
  console.log(`   Balance on NEW rollup before migrate: ${newBalanceBefore}`);

  await newAppUser.methods
    .migrate_mode_a(
      mpk.toNoirStruct(),
      signature,
      migrationNoteProof,
      blockHeader,
    )
    .send({ from: newUserManager.address });

  const newBalanceAfter = await newAppUser.methods
    .get_balance(newUserManager.address)
    .simulate({ from: newUserManager.address });
  console.log(`   Balance on NEW rollup after: ${newBalanceAfter}`);
  assertEq(
    newBalanceAfter,
    LOCK_AMOUNT,
    "Migrated balance on NEW rollup does not match locked amount",
  );

  console.log("\n   Cross-rollup migration fully successful!");

  // ============================================================
  // Step 8: Mint PUBLIC tokens on OLD rollup
  // ============================================================
  console.log("\n=== Test Scenario 2: Public Balance Migration ===\n");
  console.log("Step 8. Minting PUBLIC tokens on OLD rollup...");

  const PUBLIC_MINT_AMOUNT = 1000n;
  await oldAppUser.methods
    .mint_public(oldUserManager.address, PUBLIC_MINT_AMOUNT)
    .send({ from: oldUserManager.address });

  const oldPublicBalanceAfterMint = await oldAppUser.methods
    .get_public_balance(oldUserManager.address)
    .simulate({ from: oldUserManager.address });
  console.log(
    `   Minted ${PUBLIC_MINT_AMOUNT} public tokens to old rollup user`,
  );
  console.log(
    `   Public balance on OLD rollup: ${oldPublicBalanceAfterMint}\n`,
  );

  // ============================================================
  // Step 9: Lock PUBLIC tokens for migration on OLD rollup
  // ============================================================
  console.log("Step 9. Locking PUBLIC tokens for migration on OLD rollup...");

  const PUBLIC_LOCK_AMOUNT = 500n;
  console.log(`   Locking ${PUBLIC_LOCK_AMOUNT} public tokens...`);
  console.log(`   Destination rollup: ${env.newRollupVersion}`);

  const lockPublicTx = await oldAppUser.methods
    .lock_public_for_migration(
      PUBLIC_LOCK_AMOUNT,
      env.newRollupVersion,
      mpk.toNoirStruct(),
    )
    .send({ from: oldUserManager.address });

  const oldPublicBalanceAfterLock = await oldAppUser.methods
    .get_public_balance(oldUserManager.address)
    .simulate({ from: oldUserManager.address });
  console.log(
    `   Public balance on OLD rollup after lock: ${oldPublicBalanceAfterLock}`,
  );
  console.log(
    `   ✅ ${PUBLIC_MINT_AMOUNT - BigInt(oldPublicBalanceAfterLock)} public tokens locked for migration\n`,
  );

  // ============================================================
  // Step 10: Bridge new archive root if needed
  // ============================================================
  console.log("Step 10. Bridging archive root for public lock note...");

  const {
    l1Result: l1ResultPublic,
    provenBlockNumber: publicProvenBlockNumber,
    blockHeader: publicBlockHeader,
  } = await bridgeBlock(env, newArchiveRegistry);
  console.log(`   Proven block: ${l1ResultPublic.provenBlockNumber}`);
  console.log(`   Archive root: ${l1ResultPublic.provenArchiveRoot}\n`);

  // ============================================================
  // Step 11: Get public lock note and merkle proofs
  // ============================================================
  console.log(
    "Step 11. Computing public lock note hash and getting merkle proofs...",
  );

  // Get the actual lock note from PXE
  const allLockNotesAndData =
    await oldUserWallet.getMigrationNotesAndData<bigint>(
      oldApp.address,
      oldUserManager.address,
      MIGRATION_DATA_TYPE,
    );

  if (allLockNotesAndData.length !== 2) {
    throw new Error(
      `Expected exactly 2 migration notes, but found ${allLockNotesAndData.length}`,
    );
  }

  // const alreadyMigratedNoteHashes = lockNotes.map((note) => note.noteHash);
  const filteredNotes = await newUserWallet.filterOutMigratedNotes(
    newApp.address,
    allLockNotesAndData,
  );

  if (filteredNotes.length !== 1) {
    throw new Error(
      `Expected exactly 1 migration note for the public lock, but found ${filteredNotes.length}`,
    );
  }

  const [publicMigrationNoteProof] =
    await oldUserWallet.buildMigrationNoteProofs(
      publicProvenBlockNumber,
      filteredNotes,
    );

  // Sign via standalone function
  const publicSignature = await signMigrationModeA(
    oldMigrationSigner,
    publicBlockHeader.global_variables.version,
    new Fr(env.newRollupVersion),
    filteredNotes.map(({ note }) => note),
    newUserManager.address,
    newApp.address,
  );

  // ============================================================
  // Step 12: Call migrate_to_public_mode_a on NEW rollup
  // ============================================================
  console.log("Step 12. Calling migrate_to_public_mode_a on NEW rollup...");

  const newPublicBalanceBefore = await newAppUser.methods
    .get_public_balance(newUserManager.address)
    .simulate({ from: newUserManager.address });
  console.log(
    `   Public balance on NEW rollup before: ${newPublicBalanceBefore}`,
  );

  await newAppUser.methods
    .migrate_to_public_mode_a(
      mpk.toNoirStruct(),
      publicSignature,
      publicMigrationNoteProof,
      publicBlockHeader,
    )
    .send({ from: newUserManager.address });

  const newPublicBalanceAfter = await newAppUser.methods
    .get_public_balance(newUserManager.address)
    .simulate({ from: newUserManager.address });
  console.log(
    `   Public balance on NEW rollup after: ${newPublicBalanceAfter}`,
  );
  assertEq(
    newPublicBalanceAfter,
    PUBLIC_LOCK_AMOUNT,
    "Migrated public balance on NEW rollup does not match locked amount",
  );
  console.log("   Public balance migration fully successful!");

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
