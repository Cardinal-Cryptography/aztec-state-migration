import { Fr } from "@aztec/foundation/curves/bn254";
import { signMigrationModeB } from "../ts/aztec-state-migration/index.js";
import { deploy } from "./deploy.js";
import {
  deployTokenAppPair,
  deployArchiveRegistry,
  deployKeyRegistry,
  bridgeBlock,
  deployAndFundAccount,
  assertEq,
  expectRevert,
} from "./test-utils.js";
import { TokenMigrationAppV1Contract } from "./artifacts/TokenMigrationAppV1.js";
import { TokenMigrationAppV2Contract } from "./artifacts/TokenMigrationAppV2.js";
import { MigrationKeyRegistryContract } from "../ts/aztec-state-migration/noir-contracts/MigrationKeyRegistry.js";
import { UintNote } from "../ts/aztec-state-migration/common-notes.js";
import { NoteStatus } from "@aztec/stdlib/note";

async function main() {
  console.log("=== Token Mode B (Emergency Snapshot) Migration E2E Test ===\n");

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
  // Step 2: Deploy L2 contracts (with KeyRegistry)
  // ============================================================
  console.log("Step 2. Deploying L2 contracts...");

  const oldKeyRegistry = await deployKeyRegistry(env);
  console.log(`   old_key_registry: ${oldKeyRegistry.address}`);

  const newArchiveRegistry = await deployArchiveRegistry(
    env,
    oldKeyRegistry.address,
  );

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
  console.log(`   new_token_app: ${newApp.address}`);
  console.log(`   new_archive_registry: ${newArchiveRegistry.address}\n`);

  // ============================================================
  // Step 3: Mint tokens on OLD rollup
  // ============================================================
  console.log("Step 3. Minting tokens on OLD rollup...");

  const MINT_AMOUNT_1 = 500n;
  const MINT_AMOUNT_2 = 300n;
  const BURN_AMOUNT = 150n;

  await oldApp.methods
    .mint_to_private(oldUserManager.address, MINT_AMOUNT_1)
    .send({ from: oldDeployerManager.address });
  console.log(`   Minted ${MINT_AMOUNT_1} tokens (mint 1)`);

  await oldApp.methods
    .mint_to_private(oldUserManager.address, MINT_AMOUNT_2)
    .send({ from: oldDeployerManager.address });
  console.log(`   Minted ${MINT_AMOUNT_2} tokens (mint 2)`);

  // ============================================================
  // Step 4: Burn tokens to create a nullified note
  // ============================================================
  console.log("Step 4. Burning tokens to create nullified note...");

  await oldAppUser.methods
    .burn_private(oldUserManager.address, BURN_AMOUNT, 0)
    .send({ from: oldUserManager.address });
  console.log(`   Burned ${BURN_AMOUNT} tokens`);

  const oldBalance = await oldAppUser.methods
    .balance_of_private(oldUserManager.address)
    .simulate({ from: oldUserManager.address });
  assertEq(
    oldBalance,
    MINT_AMOUNT_1 + MINT_AMOUNT_2 - BURN_AMOUNT,
    "Old balance after burn",
  );

  const oldTotalSupply = await oldApp.methods
    .total_supply()
    .simulate({ from: oldDeployerManager.address });
  assertEq(
    oldTotalSupply,
    MINT_AMOUNT_1 + MINT_AMOUNT_2 - BURN_AMOUNT,
    "Old total supply after burn",
  );
  console.log(`   Balance: ${oldBalance}, total_supply: ${oldTotalSupply}\n`);

  // ============================================================
  // Step 5: Register migration key
  // ============================================================
  console.log("Step 5. Registering migration key...");

  const mpk = await oldUserWallet.getMigrationPublicKey(
    oldUserManager.address,
  )!;

  const oldUserKeyRegistry = MigrationKeyRegistryContract.at(
    oldKeyRegistry.address,
    oldUserWallet,
  );

  await oldUserKeyRegistry.methods
    .register(mpk.toNoirStruct())
    .send({ from: oldUserManager.address });

  const registeredKey = await oldUserKeyRegistry.methods
    .get(oldUserManager.address)
    .simulate({ from: oldUserManager.address });
  console.log(`   Verified registered mpk: ${registeredKey}\n`);

  // ============================================================
  // Step 6: Bridge archive root + set snapshot height
  // ============================================================
  console.log("Step 6. Bridging archive root and setting snapshot height...");

  const { provenBlockNumber, archiveProof, blockHeader } = await bridgeBlock(
    env,
    newArchiveRegistry,
  );
  console.log(`   Bridge complete. Proven block: ${provenBlockNumber}`);

  await newArchiveRegistry.methods
    .set_snapshot_height(
      provenBlockNumber,
      blockHeader,
      provenBlockNumber,
      archiveProof.archive_sibling_path,
    )
    .send({ from: newDeployerManager.address });

  const storedSnapshot = await newArchiveRegistry.methods
    .get_snapshot_height()
    .simulate({ from: newDeployerManager.address });
  console.log(`   Stored snapshot height: ${storedSnapshot}\n`);

  // ============================================================
  // Step 7: Derive account keys
  // ============================================================
  console.log("Step 7. Deriving account keys...");

  const publicKeys = await oldUserWallet.getPublicKeys(oldUserManager.address)!;
  const completeAddress = await oldUserManager.getCompleteAddress();
  const partialAddress = completeAddress.partialAddress;
  const nhk = await oldUserWallet.getNhk(oldUserManager.address);
  console.log(`   nhk derived, partial address: ${partialAddress}\n`);

  // ============================================================
  // Step 8: Build proofs and sign
  // ============================================================
  console.log("Step 8. Building proofs and signing...");

  const balancesSlot = oldApp.artifact.storageLayout["private_balances"].slot;

  const balanceNotesAll = await oldUserWallet.getNotes({
    owner: oldUserManager.address,
    contractAddress: oldApp.address,
    storageSlot: balancesSlot,
    status: NoteStatus.ACTIVE_OR_NULLIFIED,
    scopes: [oldUserManager.address],
  });

  const balanceNotesActive = await oldUserWallet.getNotes({
    owner: oldUserManager.address,
    contractAddress: oldApp.address,
    storageSlot: balancesSlot,
    status: NoteStatus.ACTIVE,
    scopes: [oldUserManager.address],
  });

  const balanceNotesNullified = balanceNotesAll.filter(
    (n) => !balanceNotesActive.some((a) => a.equals(n)),
  );

  if (balanceNotesActive.length === 0) {
    throw new Error("No active balance notes found");
  }

  console.log(
    `   Active notes: ${balanceNotesActive.length}, Nullified notes: ${balanceNotesNullified.length}`,
  );

  const balanceNotes = balanceNotesActive.slice(0, 1);

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

  const oldMigrationSigner = await oldUserWallet.getMigrationSignerFromAddress(
    oldUserManager.address,
  );
  const signature = await signMigrationModeB(
    oldMigrationSigner,
    blockHeader.global_variables.version,
    new Fr(env.newRollupVersion),
    balanceNotes,
    newUserManager.address,
    newApp.address,
  );

  console.log("   Migration args prepared.\n");

  // ============================================================
  // Step 9: Call migrate_mode_b on NEW rollup
  // ============================================================
  console.log("Step 9. Calling migrate_mode_b on NEW rollup...");

  const noteProof = fullProofs[0];
  const migrateAmount = noteProof.note_proof_data.data.value;
  console.log(`   Migrating amount: ${migrateAmount}`);

  const newBalanceBefore = await newAppUser.methods
    .balance_of_private(newUserManager.address)
    .simulate({ from: newUserManager.address });
  assertEq(newBalanceBefore, 0n, "New balance before migrate");

  await newAppUser.methods
    .migrate_mode_b(
      migrateAmount,
      signature,
      noteProof,
      blockHeader,
      oldUserManager.address,
      publicKeys,
      partialAddress,
      keyNoteProof,
      { hi: nhk.hi, lo: nhk.lo },
    )
    .send({ from: newUserManager.address });

  const newBalanceAfter = await newAppUser.methods
    .balance_of_private(newUserManager.address)
    .simulate({ from: newUserManager.address });
  assertEq(newBalanceAfter, migrateAmount, "New balance after migrate");

  const newTotalSupply = await newApp.methods
    .total_supply()
    .simulate({ from: newDeployerManager.address });
  assertEq(newTotalSupply, migrateAmount, "New total supply after migrate");

  console.log(
    `   Balance on NEW rollup: ${newBalanceAfter}, total_supply: ${newTotalSupply}`,
  );
  console.log("   Mode B migration successful!\n");

  // ============================================================
  // Step 10: Double migration negative test
  // ============================================================
  console.log("Step 10. Testing double migration (should fail)...");
  await expectRevert(
    newAppUser.methods
      .migrate_mode_b(
        migrateAmount,
        signature,
        noteProof,
        blockHeader,
        oldUserManager.address,
        publicKeys,
        partialAddress,
        keyNoteProof,
        { hi: nhk.hi, lo: nhk.lo },
      )
      .send({ from: newUserManager.address }),
  );
  console.log("   Double migration correctly rejected!\n");

  // ============================================================
  // Step 11: Nullified note rejection test
  // ============================================================
  console.log("Step 11. Testing nullified note migration (should fail)...");

  if (balanceNotesNullified.length === 0) {
    throw new Error("No nullified balance notes found to test failure case");
  }

  const nullifiedNote = balanceNotesNullified[0];

  const [nullifiedNoteProof] = await oldUserWallet.buildFullNoteProofs(
    provenBlockNumber,
    [nullifiedNote],
    (note) => UintNote.fromNote(note),
  );

  const nullifiedNoteSig = await signMigrationModeB(
    oldMigrationSigner,
    blockHeader.global_variables.version,
    new Fr(env.newRollupVersion),
    [nullifiedNote],
    newUserManager.address,
    newApp.address,
  );

  const nullifiedAmount = nullifiedNoteProof.note_proof_data.data.value;

  await expectRevert(
    newAppUser.methods
      .migrate_mode_b(
        nullifiedAmount,
        nullifiedNoteSig,
        nullifiedNoteProof,
        blockHeader,
        oldUserManager.address,
        publicKeys,
        partialAddress,
        keyNoteProof,
        { hi: nhk.hi, lo: nhk.lo },
      )
      .simulate({ from: newUserManager.address }),
    "Note nullifier non-inclusion",
  );
  console.log("   Nullified note correctly rejected!\n");

  // ============================================================
  // Summary
  // ============================================================
  console.log("=== Token Mode B Migration Test Summary ===\n");
  console.log("Contracts deployed:");
  console.log("  OLD Rollup (L2):");
  console.log(`    - TokenMigrationApp: ${oldApp.address}`);
  console.log(`    - MigrationKeyRegistry: ${oldKeyRegistry.address}`);
  console.log("  NEW Rollup (L2):");
  console.log(`    - MigrationArchiveRegistry: ${newArchiveRegistry.address}`);
  console.log(`    - TokenMigrationApp: ${newApp.address}`);
  console.log(`\nSnapshot height: ${provenBlockNumber}`);
  console.log(`Migrated amount: ${migrateAmount}`);
  console.log("\nBalances:");
  console.log(`  OLD rollup: ${oldBalance}`);
  console.log(`  NEW rollup: ${newBalanceAfter}`);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
