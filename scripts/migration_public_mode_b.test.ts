import { Fr } from "@aztec/foundation/curves/bn254";
import {
  poseidon2Hash,
  poseidon2HashWithSeparator,
} from "@aztec/foundation/crypto/poseidon";
import { deploy } from "./deploy.js";
import {
  deployAppPair,
  deployArchiveRegistry,
  deployKeyRegistry,
  bridgeBlock,
  deployAndFundAccount,
} from "./test-utils.js";
import { ExampleMigrationAppContract } from "../noir/target/artifacts/ExampleMigrationApp.js";
import { MigrationKeyRegistryContract } from "../noir/target/artifacts/MigrationKeyRegistry.js";
import { KeyNote } from "../ts/migration-lib/types.js";
import { BlockNumber } from "@aztec/foundation/branded-types";

// Must match CLAIM_DOMAIN_B_PUBLIC in public_state_migration.nr
const CLAIM_DOMAIN_B_PUBLIC = new Fr(0xdeafbeefn);

// TODO: this should be part of the library
/**
 * Build a PublicDataSlotProofData for a single storage slot by querying
 * the public data tree witness from the Aztec node.
 */
async function buildPublicDataSlotProof(
  aztecNode: import("@aztec/aztec.js/node").AztecNode,
  blockNumber: BlockNumber,
  contractAddress: import("@aztec/stdlib/aztec-address").AztecAddress,
  storageSlot: Fr,
) {
  // Compute the siloed slot (public data tree index)
  const siloedSlot = await poseidon2HashWithSeparator(
    [contractAddress, storageSlot],
    23, // GENERATOR_INDEX__PUBLIC_LEAF_INDEX
  );

  const witness = await aztecNode.getPublicDataWitness(blockNumber, siloedSlot);
  if (!witness) {
    throw new Error(
      `No public data witness for slot ${storageSlot} (siloed: ${siloedSlot})`,
    );
  }

  return {
    next_slot: witness.leafPreimage.nextKey,
    next_index: new Fr(witness.leafPreimage.nextIndex),
    leaf_index: new Fr(witness.index),
    sibling_path: witness.siblingPath.toFields(),
  };
}

async function main() {
  console.log("=== Mode B Public State Migration E2E Test ===\n");

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
  // Create user wallets
  // ============================================================
  console.log("1. Creating user wallets...");

  const oldUserManager = await deployAndFundAccount(env, oldAztecNode);
  const newUserManager = await deployAndFundAccount(env, newAztecNode);

  console.log(`   Old User: ${oldUserManager.address}`);
  console.log(`   New User: ${newUserManager.address}\n`);

  // ============================================================
  // Deploy L2 contracts
  // ============================================================
  console.log("2. Deploying L2 contracts...");

  const oldKeyRegistry = await deployKeyRegistry(env);
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

  console.log(`   old_key_registry: ${oldKeyRegistry.address}`);
  console.log(`   new_archive_registry: ${newArchiveRegistry.address}`);
  console.log(`   old_example_app: ${oldApp.address}`);
  console.log(`   new_example_app: ${newApp.address}\n`);

  // ============================================================
  // Set SomeStruct on OLD rollup
  // ============================================================
  console.log("3. Setting SomeStruct on OLD rollup...");

  const TEST_A = 12345n;
  const TEST_B = oldUserManager.address;
  const SOME_STRUCT = { a: TEST_A, b: TEST_B };

  const initTx = await oldAppUser.methods
    .init_some_struct(SOME_STRUCT)
    .send({ from: oldUserManager.address })
    .wait();
  console.log(`   Init tx: ${initTx.txHash}`);
  console.log(`   SomeStruct = { a: ${SOME_STRUCT.a}, b: ${SOME_STRUCT.b} }\n`);

  // ============================================================
  // Register migration key
  // ============================================================
  console.log("4. Registering migration key...");

  const mpk = oldUserWallet.getMigrationPublicKey(oldUserManager.address)!;
  const oldUserKeyRegistry = MigrationKeyRegistryContract.at(
    oldKeyRegistry.address,
    oldUserWallet,
  );

  const registerTx = await oldUserKeyRegistry.methods
    .register(mpk.toNoirStruct())
    .send({ from: oldUserManager.address })
    .wait();
  console.log(`   Register tx: ${registerTx.txHash}\n`);

  // ============================================================
  // Bridge archive root + set snapshot height
  // ============================================================
  console.log("5. Bridging archive root and setting snapshot height...");

  const { l1Result, provenBlockNumber, archiveProof, blockHeader } =
    await bridgeBlock(env, newArchiveRegistry, registerTx.blockNumber!);
  console.log(`   Proven block: ${l1Result.provenBlockNumber}`);
  console.log(`   Archive root: ${l1Result.provenArchiveRoot}`);

  await newArchiveRegistry.methods
    .set_snapshot_height(
      l1Result.provenBlockNumber,
      blockHeader,
      l1Result.provenBlockNumber,
      archiveProof.archive_sibling_path,
    )
    .send({ from: newDeployerManager.address })
    .wait();
  console.log(`   Snapshot height set: ${l1Result.provenBlockNumber}\n`);

  // ============================================================
  // Build key note proofs (same as Mode B private)
  // ============================================================
  console.log("6. Building key note proofs...");
  const oldMigrationAccount = await oldUserWallet.getMigrationAccount(
    oldUserManager.address,
  );

  const keyRegistrySlot =
    oldKeyRegistry.artifact.storageLayout["registered_keys"].slot;
  const keyNotes = await oldUserWallet.getNotes({
    owner: oldUserManager.address,
    contractAddress: oldKeyRegistry.address,
    storageSlot: keyRegistrySlot,
  });
  if (keyNotes.length === 0) {
    throw new Error("No key notes found");
  }

  const [keyNoteProof] = await oldUserWallet.buildNoteProofs(
    provenBlockNumber,
    [keyNotes[0]],
    (note) => KeyNote.fromNote(note),
  );
  console.log(`   Key note proof built\n`);

  // ============================================================
  // Get public data tree witnesses for SomeStruct (2 fields)
  // ============================================================
  console.log("8. Getting public data tree witnesses...");

  const baseSlot = oldApp.artifact.storageLayout["some_struct"].slot;
  console.log(`   Base storage slot: ${baseSlot}`);

  const publicDataSlotProofs = [];
  for (let i = 0; i < 2; i++) {
    const slot = new Fr(baseSlot.toBigInt() + BigInt(i));
    const proof = await buildPublicDataSlotProof(
      oldAztecNode,
      provenBlockNumber,
      oldApp.address,
      slot,
    );
    publicDataSlotProofs.push(proof);
    console.log(`   Slot ${i} (${slot}): witness built`);
  }
  console.log(`   Public data proofs built\n`);

  // ============================================================
  // Call migrate_to_public_mode_b on NEW rollup
  // ============================================================
  console.log("10. Calling migrate_to_public_mode_b on NEW rollup...");

  try {
    const migrateTx = await newAppUser.methods
      .migrate_to_public_mode_b(
        {
          data: SOME_STRUCT,
          slot_proof_data: publicDataSlotProofs,
        },
        blockHeader,
      )
      .send({ from: newUserManager.address })
      .wait();
    console.log(`   Migrate tx: ${migrateTx.txHash}`);

    // Verify struct was set on new rollup
    const result = await newAppUser.methods
      .get_some_struct()
      .simulate({ from: newUserManager.address });
    console.log(`   Result on NEW rollup: { a: ${result.a}, b: ${result.b} }`);

    if (BigInt(result.a) !== TEST_A) {
      throw new Error(
        `Field 'a' mismatch: got ${result.a}, expected ${TEST_A}`,
      );
    }
    console.log("\n   Public state migration (Mode B) successful!");
  } catch (e) {
    throw new Error(`migrate_to_public_mode_b failed: ${(e as Error).message}`);
  }

  // TODO: Test map migration and owned map migration

  // ============================================================
  // Summary
  // ============================================================
  console.log("\n=== Public State Migration (Mode B) Test Summary ===");
  console.log("Contracts:");
  console.log(`  OLD: ExampleMigrationApp ${oldApp.address}`);
  console.log(`  OLD: MigrationKeyRegistry ${oldKeyRegistry.address}`);
  console.log(`  NEW: MigrationArchiveRegistry ${newArchiveRegistry.address}`);
  console.log(`  NEW: ExampleMigrationApp ${newApp.address}`);
  console.log(`\nSnapshot height: ${l1Result.provenBlockNumber}`);
  console.log(`Migrated struct: { a: ${SOME_STRUCT.a}, b: ${SOME_STRUCT.b} }`);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
