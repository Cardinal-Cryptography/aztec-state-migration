import { TokenMigrationAppV1Contract } from "./artifacts/TokenMigrationAppV1.js";
import { TokenMigrationAppV2Contract } from "./artifacts/TokenMigrationAppV2.js";
import { Fr } from "@aztec/foundation/curves/bn254";
import { signMigrationModeA } from "../ts/aztec-state-migration/index.js";
import { deploy } from "./deploy.js";
import {
  deployTokenAppPair,
  deployArchiveRegistry,
  bridgeBlock,
  deployAndFundAccount,
  assertEq,
  expectRevert,
} from "./test-utils.js";
import { AbiType } from "@aztec/stdlib/abi";

const MIGRATION_DATA_TYPE: AbiType = { kind: "field" };

async function main() {
  console.log("=== Token Migration E2E Test (Mode A) ===\n");

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
  // Step 1: Create user wallets
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
  console.log(`   new_archive_registry: ${newArchiveRegistry.address}`);

  const { oldApp, newApp } = await deployTokenAppPair(
    env,
    newArchiveRegistry.address,
  );
  const oldAppUser = TokenMigrationAppV1Contract.at(
    oldApp.address,
    oldUserWallet,
  );
  const newAppUser = TokenMigrationAppV2Contract.at(
    newApp.address,
    newUserWallet,
  );
  console.log(`   old_token_app: ${oldApp.address}`);
  console.log(`   new_token_app: ${newApp.address}\n`);

  // ============================================================
  // Step 3: Mint private tokens on OLD rollup
  // ============================================================
  console.log("Step 3. Minting private tokens on OLD rollup...");
  const MINT_AMOUNT = 1000n;
  await oldApp.methods
    .mint_to_private(oldUserManager.address, MINT_AMOUNT)
    .send({ from: oldDeployerManager.address });

  const oldBalanceAfterMint = await oldAppUser.methods
    .balance_of_private(oldUserManager.address)
    .simulate({ from: oldUserManager.address });
  assertEq(oldBalanceAfterMint, MINT_AMOUNT, "Old private balance after mint");

  const oldTotalSupplyAfterMint = await oldApp.methods
    .total_supply()
    .simulate({ from: oldDeployerManager.address });
  assertEq(oldTotalSupplyAfterMint, MINT_AMOUNT, "Old total supply after mint");
  console.log(`   Minted ${MINT_AMOUNT}, balance: ${oldBalanceAfterMint}, total_supply: ${oldTotalSupplyAfterMint}\n`);

  // ============================================================
  // Step 4: Lock private tokens for migration
  // ============================================================
  console.log("Step 4. Locking private tokens for migration...");
  const mpk = await oldUserWallet.getMigrationPublicKey(
    oldUserManager.address,
  )!;

  const LOCK_AMOUNT = 300n;
  await oldAppUser.methods
    .lock_migration_notes_mode_a(
      LOCK_AMOUNT,
      env.newRollupVersion,
      mpk.toNoirStruct(),
    )
    .send({ from: oldUserManager.address });

  const oldBalanceAfterLock = await oldAppUser.methods
    .balance_of_private(oldUserManager.address)
    .simulate({ from: oldUserManager.address });
  assertEq(
    oldBalanceAfterLock,
    MINT_AMOUNT - LOCK_AMOUNT,
    "Old private balance after lock",
  );

  const oldTotalSupplyAfterLock = await oldApp.methods
    .total_supply()
    .simulate({ from: oldDeployerManager.address });
  assertEq(
    oldTotalSupplyAfterLock,
    MINT_AMOUNT,
    "Old total supply after lock (should NOT change)",
  );
  console.log(`   Balance after lock: ${oldBalanceAfterLock}, total_supply: ${oldTotalSupplyAfterLock}\n`);

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
  // Step 6: Prepare migration args
  // ============================================================
  console.log("Step 6. Preparing migration args...");

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

  const [migrationNoteProof] = await oldUserWallet.buildMigrationNoteProofs(
    provenBlockNumber,
    lockNotesAndData,
  );

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

  // ============================================================
  // Step 7: Call migrate_mode_a on NEW rollup
  // ============================================================
  console.log("Step 7. Calling migrate_mode_a on NEW rollup...");

  const newBalanceBefore = await newAppUser.methods
    .balance_of_private(newUserManager.address)
    .simulate({ from: newUserManager.address });
  assertEq(newBalanceBefore, 0n, "New private balance before migrate");

  await newAppUser.methods
    .migrate_mode_a(
      LOCK_AMOUNT,
      mpk.toNoirStruct(),
      signature,
      migrationNoteProof,
      blockHeader,
    )
    .send({ from: newUserManager.address });

  const newBalanceAfter = await newAppUser.methods
    .balance_of_private(newUserManager.address)
    .simulate({ from: newUserManager.address });
  assertEq(
    newBalanceAfter,
    LOCK_AMOUNT,
    "New private balance after migrate",
  );

  const newTotalSupplyAfterPrivate = await newApp.methods
    .total_supply()
    .simulate({ from: newDeployerManager.address });
  assertEq(
    newTotalSupplyAfterPrivate,
    LOCK_AMOUNT,
    "New total supply after private migrate",
  );
  console.log(`   Balance on NEW rollup: ${newBalanceAfter}, total_supply: ${newTotalSupplyAfterPrivate}`);
  console.log("   Private migration successful!\n");

  // ============================================================
  // Step 8: Double migration negative test (should fail)
  // ============================================================
  console.log("Step 8. Testing double migration (should fail)...");
  await expectRevert(
    newAppUser.methods
      .migrate_mode_a(
        LOCK_AMOUNT,
        mpk.toNoirStruct(),
        signature,
        migrationNoteProof,
        blockHeader,
      )
      .simulate({ from: newUserManager.address }),
  );
  console.log("   Double migration correctly rejected!\n");

  // ============================================================
  // Step 9: Mint PUBLIC tokens on OLD rollup
  // ============================================================
  console.log("=== Test Scenario 2: Public Balance Migration ===\n");
  console.log("Step 9. Minting PUBLIC tokens on OLD rollup...");

  const PUBLIC_MINT_AMOUNT = 1000n;
  await oldApp.methods
    .mint_to_public(oldUserManager.address, PUBLIC_MINT_AMOUNT)
    .send({ from: oldDeployerManager.address });

  const oldPublicBalanceAfterMint = await oldApp.methods
    .balance_of_public(oldUserManager.address)
    .simulate({ from: oldDeployerManager.address });
  assertEq(
    oldPublicBalanceAfterMint,
    PUBLIC_MINT_AMOUNT,
    "Old public balance after mint",
  );

  const oldTotalSupplyAfterBothMints = await oldApp.methods
    .total_supply()
    .simulate({ from: oldDeployerManager.address });
  assertEq(
    oldTotalSupplyAfterBothMints,
    MINT_AMOUNT + PUBLIC_MINT_AMOUNT,
    "Old total supply after both mints",
  );
  console.log(`   Minted ${PUBLIC_MINT_AMOUNT} public tokens, total_supply: ${oldTotalSupplyAfterBothMints}\n`);

  // ============================================================
  // Step 10: Lock public tokens for migration
  // ============================================================
  console.log("Step 10. Locking PUBLIC tokens for migration...");

  const PUBLIC_LOCK_AMOUNT = 500n;
  await oldAppUser.methods
    .lock_public_for_migration(
      PUBLIC_LOCK_AMOUNT,
      env.newRollupVersion,
      mpk.toNoirStruct(),
    )
    .send({ from: oldUserManager.address });

  const oldPublicBalanceAfterLock = await oldApp.methods
    .balance_of_public(oldUserManager.address)
    .simulate({ from: oldDeployerManager.address });
  assertEq(
    oldPublicBalanceAfterLock,
    PUBLIC_MINT_AMOUNT - PUBLIC_LOCK_AMOUNT,
    "Old public balance after lock",
  );
  console.log(`   Public balance after lock: ${oldPublicBalanceAfterLock}\n`);

  // ============================================================
  // Step 11: Bridge archive root again
  // ============================================================
  console.log("Step 11. Bridging archive root for public lock note...");

  const {
    l1Result: l1ResultPublic,
    provenBlockNumber: publicProvenBlockNumber,
    blockHeader: publicBlockHeader,
  } = await bridgeBlock(env, newArchiveRegistry);
  console.log(`   Proven block: ${l1ResultPublic.provenBlockNumber}\n`);

  // ============================================================
  // Step 12: Get public lock note, filter, build proof
  // ============================================================
  console.log("Step 12. Getting public lock notes and building proofs...");

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

  const filteredNotes = await newUserWallet.filterOutMigratedNotes(
    newApp.address,
    allLockNotesAndData,
  );

  if (filteredNotes.length !== 1) {
    throw new Error(
      `Expected exactly 1 remaining note, but found ${filteredNotes.length}`,
    );
  }

  const [publicMigrationNoteProof] =
    await oldUserWallet.buildMigrationNoteProofs(
      publicProvenBlockNumber,
      filteredNotes,
    );

  const publicSignature = await signMigrationModeA(
    oldMigrationSigner,
    publicBlockHeader.global_variables.version,
    new Fr(env.newRollupVersion),
    filteredNotes.map(({ note }) => note),
    newUserManager.address,
    newApp.address,
  );

  // ============================================================
  // Step 13: Call migrate_to_public_mode_a on NEW rollup
  // ============================================================
  console.log("Step 13. Calling migrate_to_public_mode_a on NEW rollup...");

  const newPublicBalanceBefore = await newApp.methods
    .balance_of_public(newUserManager.address)
    .simulate({ from: newDeployerManager.address });
  assertEq(newPublicBalanceBefore, 0n, "New public balance before migrate");

  await newAppUser.methods
    .migrate_to_public_mode_a(
      PUBLIC_LOCK_AMOUNT,
      mpk.toNoirStruct(),
      publicSignature,
      publicMigrationNoteProof,
      publicBlockHeader,
    )
    .send({ from: newUserManager.address });

  const newPublicBalanceAfter = await newApp.methods
    .balance_of_public(newUserManager.address)
    .simulate({ from: newDeployerManager.address });
  assertEq(
    newPublicBalanceAfter,
    PUBLIC_LOCK_AMOUNT,
    "New public balance after migrate",
  );

  const newTotalSupplyFinal = await newApp.methods
    .total_supply()
    .simulate({ from: newDeployerManager.address });
  assertEq(
    newTotalSupplyFinal,
    LOCK_AMOUNT + PUBLIC_LOCK_AMOUNT,
    "New total supply final",
  );
  console.log(`   Public balance on NEW rollup: ${newPublicBalanceAfter}, total_supply: ${newTotalSupplyFinal}`);
  console.log("   Public balance migration successful!\n");

  // ============================================================
  // Step 14: Double public migration negative test
  // ============================================================
  console.log("Step 14. Testing double public migration (should fail)...");
  await expectRevert(
    newAppUser.methods
      .migrate_to_public_mode_a(
        PUBLIC_LOCK_AMOUNT,
        mpk.toNoirStruct(),
        publicSignature,
        publicMigrationNoteProof,
        publicBlockHeader,
      )
      .simulate({ from: newUserManager.address }),
  );
  console.log("   Double public migration correctly rejected!\n");

  // ============================================================
  // Summary
  // ============================================================
  console.log("=== Token Mode A Migration Test Summary ===\n");
  console.log("Balances:");
  console.log(`  OLD rollup private balance: ${oldBalanceAfterLock}`);
  console.log(`  OLD rollup public balance: ${oldPublicBalanceAfterLock}`);
  console.log(`  NEW rollup private balance: ${newBalanceAfter}`);
  console.log(`  NEW rollup public balance: ${newPublicBalanceAfter}`);
  console.log(`  NEW rollup total supply: ${newTotalSupplyFinal}`);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
