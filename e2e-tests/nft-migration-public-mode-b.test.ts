import { Fr } from "@aztec/foundation/curves/bn254";
import { deploy } from "./deploy.js";
import {
  deployNftAppPair,
  deployArchiveRegistry,
  deployKeyRegistry,
  bridgeBlock,
  deployAndFundAccount,
  assertEq,
  expectRevert,
} from "./test-utils.js";
import { NftMigrationAppV1Contract } from "./artifacts/NftMigrationAppV1.js";
import {
  NftMigrationAppV2Contract,
  NftMigrationAppV2ContractArtifact,
} from "./artifacts/NftMigrationAppV2.js";
import { MigrationKeyRegistryContract } from "../ts/aztec-state-migration/noir-contracts/MigrationKeyRegistry.js";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { buildPublicMapDataProof } from "../ts/aztec-state-migration/mode-b/proofs.js";

// Extract ABI type for the owner proof data from the contract artifact
const proofDataAbiType = NftMigrationAppV2ContractArtifact.functions
  .find((f) => f.name === "migrate_public_owner_mode_b")!
  .parameters.find((p) => p.name === "proof_data")!.type;
if (proofDataAbiType.kind !== "struct")
  throw new Error("Expected struct ABI type for proof_data");
const ownerAbiType = proofDataAbiType.fields.find(
  (f) => f.name === "data",
)!.type;

async function main() {
  console.log("=== NFT Mode B Public State Migration E2E Test ===\n");

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
  console.log(`   new_nft_app: ${newApp.address}\n`);

  // ============================================================
  // Step 3: Mint public NFT on OLD rollup
  // ============================================================
  console.log("Step 3. Minting public NFT on OLD rollup...");

  const TOKEN_ID = 42n;
  // Note: NFT V1 mint_to_public is a PRIVATE function (not public like Token's)
  await oldApp.methods
    .mint_to_public(oldUserManager.address, TOKEN_ID)
    .send({ from: oldDeployerManager.address });

  const oldPublicOwner = await oldAppUser.methods
    .public_owner_of(TOKEN_ID)
    .simulate({ from: oldUserManager.address });
  assertEq(
    oldPublicOwner.toString(),
    oldUserManager.address.toString(),
    "Old public owner after mint",
  );
  console.log(`   Minted public NFT #${TOKEN_ID}, owner: ${oldPublicOwner}\n`);

  // ============================================================
  // Step 4: Register migration key
  // ============================================================
  console.log("Step 4. Registering migration key...");

  const oldUserKeyRegistry = MigrationKeyRegistryContract.at(
    oldKeyRegistry.address,
    oldUserWallet,
  );

  const mpk = await oldUserWallet.getMigrationPublicKey(
    oldUserManager.address,
  )!;
  await oldUserKeyRegistry.methods
    .register(mpk.toNoirStruct())
    .send({ from: oldUserManager.address });

  const registeredKey = await oldUserKeyRegistry.methods
    .get(oldUserManager.address)
    .simulate({ from: oldUserManager.address });
  console.log(`   Verified registered mpk: ${registeredKey}\n`);

  // ============================================================
  // Step 5: Bridge archive root + set snapshot height
  // ============================================================
  console.log("Step 5. Bridging archive root and setting snapshot height...");

  const { provenBlockNumber, archiveProof, blockHeader } = await bridgeBlock(
    env,
    newArchiveRegistry,
  );
  console.log(`   Proven block: ${provenBlockNumber}`);

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
  // Step 6: Build public data proof
  // ============================================================
  console.log("Step 6. Building public data proof...");

  const slot = oldApp.artifact.storageLayout["public_owners"].slot;
  // NFT public_owners: Map<Field, PublicMutable<AztecAddress>>
  // Key is token_id (Fr), value is owner (AztecAddress)
  const publicOwnerProof = await buildPublicMapDataProof(
    oldAztecNode,
    provenBlockNumber,
    oldUserManager.address,
    oldApp.address,
    slot,
    [new Fr(TOKEN_ID)],
    ownerAbiType,
  );

  // ============================================================
  // Step 7: Build key note proof
  // ============================================================
  console.log("Step 7. Building key note proof...");

  const keyNoteProof = await oldUserWallet.buildKeyNoteProofData(
    oldKeyRegistry.address,
    oldUserManager.address,
    provenBlockNumber,
  );

  // ============================================================
  // Step 8: Sign migration
  // ============================================================
  console.log("Step 8. Signing migration...");

  const oldMigrationSigner = await oldUserWallet.getMigrationSignerFromAddress(
    oldUserManager.address,
  );
  // For NFT, the signed data is the owner AztecAddress (not a balance amount)
  const signature = await newUserWallet.signMigrationModeB(
    oldMigrationSigner,
    newUserManager.address,
    new Fr(env.oldRollupVersion),
    new Fr(env.newRollupVersion),
    newApp.address,
    { publicData: [{ data: oldUserManager.address, abiType: ownerAbiType }] },
  );

  // ============================================================
  // Step 9: Call migrate_public_owner_mode_b on NEW rollup
  // ============================================================
  console.log("Step 9. Calling migrate_public_owner_mode_b on NEW rollup...");

  await newAppUser.methods
    .migrate_public_owner_mode_b(
      publicOwnerProof,
      blockHeader,
      TOKEN_ID,
      signature,
      keyNoteProof,
    )
    .send({ from: newUserManager.address });

  const newPublicOwner = await newAppUser.methods
    .public_owner_of(TOKEN_ID)
    .simulate({ from: newUserManager.address });
  assertEq(
    newPublicOwner.toString(),
    newUserManager.address.toString(),
    "New public owner after migrate",
  );
  console.log(`   Public owner on NEW rollup: ${newPublicOwner}`);
  console.log("   Public NFT Mode B migration successful!\n");

  // ============================================================
  // Step 10: Double migration negative test
  // ============================================================
  console.log("Step 10. Testing double migration (should fail)...");
  await expectRevert(
    newAppUser.methods
      .migrate_public_owner_mode_b(
        publicOwnerProof,
        blockHeader,
        TOKEN_ID,
        signature,
        keyNoteProof,
      )
      .send({ from: newUserManager.address }),
  );
  console.log("   Double migration correctly rejected!\n");

  // ============================================================
  // Summary
  // ============================================================
  console.log("=== NFT Public Mode B Migration Test Summary ===\n");
  console.log(`Snapshot height: ${provenBlockNumber}`);
  console.log(`Migrated token_id: ${TOKEN_ID}`);
  console.log(`New rollup public owner: ${newPublicOwner}`);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
