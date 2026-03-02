import { NftMigrationAppV1Contract } from "./artifacts/NftMigrationAppV1.js";
import { NftMigrationAppV2Contract } from "./artifacts/NftMigrationAppV2.js";
import { Fr } from "@aztec/foundation/curves/bn254";
import { signMigrationModeA } from "aztec-state-migration/mode-a";
import { deploy } from "./deploy.js";
import {
  deployNftAppPair,
  deployArchiveRegistry,
  bridgeBlock,
  deployAndFundAccount,
  assertEq,
  assertPrivateNftOwnership,
  expectRevert,
} from "./test-utils.js";
import { AbiType } from "@aztec/stdlib/abi";
import { AztecAddress } from "@aztec/stdlib/aztec-address";

const MIGRATION_DATA_TYPE: AbiType = { kind: "field" };

async function main() {
  console.log("=== NFT Migration E2E Test (Mode A) ===\n");

  // ============================================================
  // Step 0: Deploy shared infrastructure
  // ============================================================
  const env = await deploy();

  const {
    aztecNode: oldAztecNode,
    deployerManager: oldDeployerManager,
    migrationWallet: oldUserWallet,
  } = env[env.oldRollupVersion];
  const { aztecNode: newAztecNode, migrationWallet: newUserWallet } =
    env[env.newRollupVersion];

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

  const { oldApp, newApp } = await deployNftAppPair(
    env,
    newArchiveRegistry.address,
  );
  const oldAppUser = NftMigrationAppV1Contract.at(
    oldApp.address,
    oldUserWallet,
  );
  const newAppUser = NftMigrationAppV2Contract.at(
    newApp.address,
    newUserWallet,
  );
  console.log(`   old_nft_app: ${oldApp.address}`);
  console.log(`   new_nft_app: ${newApp.address}\n`);

  // ============================================================
  // Step 3: Mint private NFT on OLD rollup
  // ============================================================
  console.log("Step 3. Minting private NFT on OLD rollup...");

  const PRIVATE_TOKEN_ID = 42n;
  await oldApp.methods
    .mint_to_private(oldUserManager.address, PRIVATE_TOKEN_ID)
    .send({ from: oldDeployerManager.address });

  await assertPrivateNftOwnership(
    oldAppUser,
    oldUserManager.address,
    PRIVATE_TOKEN_ID,
    true,
    oldUserManager.address,
  );
  console.log(`   Minted NFT #${PRIVATE_TOKEN_ID}\n`);

  // ============================================================
  // Step 4: Lock private NFT for migration
  // ============================================================
  console.log("Step 4. Locking private NFT for migration...");

  const mpk = await oldUserWallet.getMigrationPublicKey(
    oldUserManager.address,
  )!;

  await oldAppUser.methods
    .lock_nft_mode_a(PRIVATE_TOKEN_ID, env.newRollupVersion, mpk.toNoirStruct())
    .send({ from: oldUserManager.address });

  await assertPrivateNftOwnership(
    oldAppUser,
    oldUserManager.address,
    PRIVATE_TOKEN_ID,
    false,
    oldUserManager.address,
  );
  console.log(
    `   NFT #${PRIVATE_TOKEN_ID} locked (no longer in private set)\n`,
  );

  // ============================================================
  // Step 5: Bridge archive root
  // ============================================================
  console.log("Step 5. Bridging archive root...");

  const { provenBlockNumber, blockHeader } = await bridgeBlock(
    env,
    newArchiveRegistry,
  );
  console.log(`   Proven block: ${provenBlockNumber}\n`);

  // ============================================================
  // Step 6: Get migration notes and build proofs
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
  const lockNoteAndData = lockNotesAndData[0];

  const migrationNoteProof = await oldUserWallet.buildMigrationNoteProof(
    provenBlockNumber,
    lockNoteAndData,
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
  // Step 7: Call migrate_nft_mode_a on NEW rollup
  // ============================================================
  console.log("Step 7. Calling migrate_nft_mode_a on NEW rollup...");

  await assertPrivateNftOwnership(
    newAppUser,
    newUserManager.address,
    PRIVATE_TOKEN_ID,
    false,
    newUserManager.address,
  );

  await newAppUser.methods
    .migrate_nft_mode_a(
      PRIVATE_TOKEN_ID,
      mpk.toNoirStruct(),
      signature,
      migrationNoteProof,
      blockHeader,
    )
    .send({ from: newUserManager.address });

  await assertPrivateNftOwnership(
    newAppUser,
    newUserManager.address,
    PRIVATE_TOKEN_ID,
    true,
    newUserManager.address,
  );
  console.log(`   NFT #${PRIVATE_TOKEN_ID} migrated to NEW rollup!`);
  console.log("   Private NFT migration successful!\n");

  // ============================================================
  // Step 8: Double migration negative test
  // ============================================================
  console.log("Step 8. Testing double migration (should fail)...");
  await expectRevert(
    newAppUser.methods
      .migrate_nft_mode_a(
        PRIVATE_TOKEN_ID,
        mpk.toNoirStruct(),
        signature,
        migrationNoteProof,
        blockHeader,
      )
      .send({ from: newUserManager.address }),
  );
  console.log("   Double migration correctly rejected!\n");

  // ============================================================
  // Step 9: Mint public NFT on OLD rollup
  // ============================================================
  console.log("=== Test Scenario 2: Public NFT Migration ===\n");
  console.log("Step 9. Minting public NFT on OLD rollup...");

  const PUBLIC_TOKEN_ID = 99n;
  await oldApp.methods
    .mint_to_public(oldUserManager.address, PUBLIC_TOKEN_ID)
    .send({ from: oldDeployerManager.address });

  const oldPublicOwner = await oldAppUser.methods
    .public_owner_of(PUBLIC_TOKEN_ID)
    .simulate({ from: oldUserManager.address });
  assertEq(
    oldPublicOwner.toString(),
    oldUserManager.address.toString(),
    "Old public owner after mint",
  );
  console.log(
    `   Minted public NFT #${PUBLIC_TOKEN_ID}, owner: ${oldPublicOwner}\n`,
  );

  // ============================================================
  // Step 10: Lock public NFT for migration
  // ============================================================
  console.log("Step 10. Locking public NFT for migration...");

  await oldAppUser.methods
    .lock_public_nft_for_migration(
      PUBLIC_TOKEN_ID,
      env.newRollupVersion,
      mpk.toNoirStruct(),
    )
    .send({ from: oldUserManager.address });

  const oldPublicOwnerAfterLock = await oldAppUser.methods
    .public_owner_of(PUBLIC_TOKEN_ID)
    .simulate({ from: oldUserManager.address });
  assertEq(
    oldPublicOwnerAfterLock.toString(),
    AztecAddress.ZERO.toString(),
    "Old public owner after lock (should be zero)",
  );
  console.log(
    `   Public owner after lock: ${oldPublicOwnerAfterLock} (cleared)\n`,
  );

  // ============================================================
  // Step 11: Bridge archive root again
  // ============================================================
  console.log("Step 11. Bridging archive root for public lock...");

  const {
    provenBlockNumber: publicProvenBlockNumber,
    blockHeader: publicBlockHeader,
  } = await bridgeBlock(env, newArchiveRegistry);
  console.log(`   Proven block: ${publicProvenBlockNumber}\n`);

  // ============================================================
  // Step 12: Get notes, filter, build proof
  // ============================================================
  console.log("Step 12. Getting notes and building proofs...");

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
  const filteredNote = filteredNotes[0];

  const publicMigrationNoteProof = await oldUserWallet.buildMigrationNoteProof(
    publicProvenBlockNumber,
    filteredNote,
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
  // Step 13: Call migrate_nft_to_public_mode_a on NEW rollup
  // ============================================================
  console.log("Step 13. Calling migrate_nft_to_public_mode_a on NEW rollup...");

  const newPublicOwnerBefore = await newAppUser.methods
    .public_owner_of(PUBLIC_TOKEN_ID)
    .simulate({ from: newUserManager.address });
  assertEq(
    newPublicOwnerBefore.toString(),
    AztecAddress.ZERO.toString(),
    "New public owner before migrate",
  );

  await newAppUser.methods
    .migrate_nft_to_public_mode_a(
      PUBLIC_TOKEN_ID,
      mpk.toNoirStruct(),
      publicSignature,
      publicMigrationNoteProof,
      publicBlockHeader,
    )
    .send({ from: newUserManager.address });

  const newPublicOwnerAfter = await newAppUser.methods
    .public_owner_of(PUBLIC_TOKEN_ID)
    .simulate({ from: newUserManager.address });
  assertEq(
    newPublicOwnerAfter.toString(),
    newUserManager.address.toString(),
    "New public owner after migrate",
  );
  console.log(`   Public owner on NEW rollup: ${newPublicOwnerAfter}`);
  console.log("   Public NFT migration successful!\n");

  // ============================================================
  // Step 14: Double public migration negative test
  // ============================================================
  console.log("Step 14. Testing double public migration (should fail)...");
  await expectRevert(
    newAppUser.methods
      .migrate_nft_to_public_mode_a(
        PUBLIC_TOKEN_ID,
        mpk.toNoirStruct(),
        publicSignature,
        publicMigrationNoteProof,
        publicBlockHeader,
      )
      .send({ from: newUserManager.address }),
  );
  console.log("   Double public migration correctly rejected!\n");

  // ============================================================
  // Summary
  // ============================================================
  console.log("=== NFT Mode A Migration Test Summary ===\n");
  console.log(`  Private NFT #${PRIVATE_TOKEN_ID}: migrated to NEW rollup`);
  console.log(`  Public NFT #${PUBLIC_TOKEN_ID}: migrated to NEW rollup`);
  console.log("  Double migration: correctly rejected for both");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
