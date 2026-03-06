import { Fr } from "@aztec/foundation/curves/bn254";
import { signMigrationModeB } from "aztec-state-migration/mode-b";
import { deploy } from "./deploy.js";
import {
  deployNftAppPair,
  deployArchiveRegistry,
  deployKeyRegistry,
  bridgeBlock,
  deployAndFundAccount,
  assertPrivateNftOwnership,
  expectRevert,
} from "./test-utils.js";
import { NftMigrationAppV1Contract } from "./artifacts/NftMigrationAppV1.js";
import { NftMigrationAppV2Contract } from "./artifacts/NftMigrationAppV2.js";
import { MigrationKeyRegistryContract } from "../ts/aztec-state-migration/noir-contracts/MigrationKeyRegistry.js";
import { NFTNote } from "../ts/aztec-state-migration/common-notes.js";
import { NoteStatus } from "@aztec/stdlib/note";

async function main() {
  console.log("=== NFT Mode B (Emergency Snapshot) Migration E2E Test ===\n");

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
  console.log(`   new_nft_app: ${newApp.address}`);
  console.log(`   new_archive_registry: ${newArchiveRegistry.address}\n`);

  // ============================================================
  // Step 3: Mint 3 NFTs on OLD rollup
  // ============================================================
  console.log("Step 3. Minting 3 NFTs on OLD rollup...");

  const TOKEN_ID_1 = 42n;
  const TOKEN_ID_2 = 99n;
  const TOKEN_ID_3 = 123n;

  await oldApp.methods
    .mint_to_private(oldUserManager.address, TOKEN_ID_1)
    .send({ from: oldDeployerManager.address });
  console.log(`   Minted NFT #${TOKEN_ID_1}`);

  await oldApp.methods
    .mint_to_private(oldUserManager.address, TOKEN_ID_2)
    .send({ from: oldDeployerManager.address });
  console.log(`   Minted NFT #${TOKEN_ID_2}`);

  await oldApp.methods
    .mint_to_private(oldUserManager.address, TOKEN_ID_3)
    .send({ from: oldDeployerManager.address });
  console.log(`   Minted NFT #${TOKEN_ID_3}`);

  const [ownedNfts] = await oldAppUser.methods
    .get_private_nfts(oldUserManager.address, 0)
    .simulate({ from: oldUserManager.address });
  const activeNfts = (ownedNfts as bigint[]).filter((id) => id !== 0n);
  console.log(`   Owned NFTs: [${activeNfts.join(", ")}]\n`);

  // ============================================================
  // Step 4: Nullify one NFT via lock_nft_mode_a
  // ============================================================
  console.log("Step 4. Nullifying NFT via lock_nft_mode_a...");

  const mpk = await oldUserWallet.getMigrationPublicKey(
    oldUserManager.address,
  )!;

  await oldAppUser.methods
    .lock_nft_mode_a(TOKEN_ID_3, env.newRollupVersion, mpk.toNoirStruct())
    .send({ from: oldUserManager.address });
  console.log(`   NFT #${TOKEN_ID_3} nullified (locked for migration)`);

  const [ownedNftsAfterLock] = await oldAppUser.methods
    .get_private_nfts(oldUserManager.address, 0)
    .simulate({ from: oldUserManager.address });
  const activeNftsAfterLock = (ownedNftsAfterLock as bigint[]).filter(
    (id) => id !== 0n,
  );
  console.log(`   Remaining NFTs: [${activeNftsAfterLock.join(", ")}]\n`);

  // ============================================================
  // Step 5: Register migration key
  // ============================================================
  console.log("Step 5. Registering migration key...");

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
  // Step 8: Get notes and separate active vs nullified
  // ============================================================
  console.log("Step 8. Getting notes...");

  const nftsSlot = oldApp.artifact.storageLayout["private_nfts"].slot;

  const nftNotesAll = await oldUserWallet.getNotes({
    owner: oldUserManager.address,
    contractAddress: oldApp.address,
    storageSlot: nftsSlot,
    status: NoteStatus.ACTIVE_OR_NULLIFIED,
    scopes: [oldUserManager.address],
  });

  const nftNotesActive = await oldUserWallet.getNotes({
    owner: oldUserManager.address,
    contractAddress: oldApp.address,
    storageSlot: nftsSlot,
    status: NoteStatus.ACTIVE,
    scopes: [oldUserManager.address],
  });

  const nftNotesNullified = nftNotesAll.filter(
    (n) => !nftNotesActive.some((a) => a.equals(n)),
  );

  console.log(
    `   Active notes: ${nftNotesActive.length}, Nullified notes: ${nftNotesNullified.length}`,
  );

  if (nftNotesActive.length === 0) {
    throw new Error("No active NFT notes found");
  }

  // ============================================================
  // Step 9: Build proofs for one active note and sign
  // ============================================================
  console.log("Step 9. Building proofs and signing...");

  const activeNote = nftNotesActive[0];

  const fullProof = await oldUserWallet.buildFullNoteProof(
    provenBlockNumber,
    activeNote,
    (note) => NFTNote.fromNote(note),
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
    newUserManager.address,
    newApp.address,
    { notes: [activeNote] },
  );

  console.log("   Migration args prepared.\n");

  // ============================================================
  // Step 10: Call migrate_nft_mode_b on NEW rollup
  // ============================================================
  console.log("Step 10. Calling migrate_nft_mode_b on NEW rollup...");

  const migratedTokenId = fullProof.note_proof_data.data.token_id;
  console.log(`   Migrating token_id: ${migratedTokenId}`);

  await newAppUser.methods
    .migrate_nft_mode_b(
      migratedTokenId,
      signature,
      fullProof,
      blockHeader,
      oldUserManager.address,
      publicKeys,
      partialAddress,
      keyNoteProof,
      { hi: nhk.hi, lo: nhk.lo },
    )
    .send({ from: newUserManager.address });

  await assertPrivateNftOwnership(
    newAppUser,
    newUserManager.address,
    migratedTokenId.toBigInt(),
    true,
    newUserManager.address,
  );
  console.log("   Mode B NFT migration successful!\n");

  // ============================================================
  // Step 11: Double migration negative test
  // ============================================================
  console.log("Step 11. Testing double migration (should fail)...");
  await expectRevert(
    newAppUser.methods
      .migrate_nft_mode_b(
        migratedTokenId,
        signature,
        fullProof,
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
  // Step 12: Nullified note rejection test
  // ============================================================
  console.log("Step 12. Testing nullified note migration (should fail)...");

  if (nftNotesNullified.length === 0) {
    throw new Error("No nullified NFT notes found to test failure case");
  }

  const nullifiedNote = nftNotesNullified[0];

  const nullifiedNoteProof = await oldUserWallet.buildFullNoteProof(
    provenBlockNumber,
    nullifiedNote,
    (note) => NFTNote.fromNote(note),
  );

  const nullifiedNoteSig = await signMigrationModeB(
    oldMigrationSigner,
    blockHeader.global_variables.version,
    new Fr(env.newRollupVersion),
    newUserManager.address,
    newApp.address,
    { notes: [nullifiedNote] },
  );

  const nullifiedTokenId = nullifiedNoteProof.note_proof_data.data.token_id;

  await expectRevert(
    newAppUser.methods
      .migrate_nft_mode_b(
        nullifiedTokenId,
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
  console.log("=== NFT Mode B Migration Test Summary ===\n");
  console.log("Contracts deployed:");
  console.log("  OLD Rollup (L2):");
  console.log(`    - NftMigrationApp: ${oldApp.address}`);
  console.log(`    - MigrationKeyRegistry: ${oldKeyRegistry.address}`);
  console.log("  NEW Rollup (L2):");
  console.log(`    - MigrationArchiveRegistry: ${newArchiveRegistry.address}`);
  console.log(`    - NftMigrationApp: ${newApp.address}`);
  console.log(`\nSnapshot height: ${provenBlockNumber}`);
  console.log(`Migrated token_id: ${migratedTokenId}`);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
