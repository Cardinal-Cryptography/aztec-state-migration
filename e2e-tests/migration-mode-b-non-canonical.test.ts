import { Fr } from "@aztec/foundation/curves/bn254";
import { signMigrationModeB } from "../ts/aztec-state-migration/index.js";
import { deploy } from "./deploy.js";
import {
  deployAppPair,
  deployArchiveRegistry,
  deployKeyRegistry,
  bridgeBlock,
  deployAndFundAccount,
  assertEq,
} from "./test-utils.js";
import { ExampleMigrationAppV1Contract } from "./artifacts/ExampleMigrationAppV1.js";
import { ExampleMigrationAppV2Contract } from "./artifacts/ExampleMigrationAppV2.js";
import { MigrationKeyRegistryContract } from "../ts/aztec-state-migration/noir-contracts/MigrationKeyRegistry.js";
import { UintNote } from "../ts/aztec-state-migration/common-notes.js";
import { NoteStatus } from "@aztec/stdlib/note";
import { FieldLike } from "@aztec/aztec.js/abi";

async function main() {
  console.log("=== Mode B (Emergency Snapshot) Migration E2E Test ===\n");

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
  // Step 1: Create user wallets (MigrationTestWallet)
  // ============================================================
  console.log("Step 1. Creating user wallets...");

  const oldUserManager = await deployAndFundAccount(env, oldAztecNode);
  const newUserManager = await deployAndFundAccount(env, newAztecNode);

  console.log(`   Old User: ${oldUserManager.address}`);
  console.log(`   New User: ${newUserManager.address}`);

  // ============================================================
  // Step 2: Deploy L2 contracts
  // ============================================================
  console.log("Step 2. Deploying L2 contracts...");

  const oldKeyRegistry = await deployKeyRegistry(env);
  console.log(`   old_key_registry: ${oldKeyRegistry.address}`);

  const newArchiveRegistry = await deployArchiveRegistry(
    env,
    oldKeyRegistry.address,
  );

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

  console.log(`   new_archive_registry: ${newArchiveRegistry.address}\n`);

  // ============================================================
  // Step 3: Initializing note on OLD rollup
  // ============================================================
  console.log("Step 3. Initializing note on OLD rollup...");

  const FOO = 0xf00;

  await oldAppUser.methods
    .init_non_canonical_note(FOO)
    .send({ from: oldUserManager.address });

  let fooNote: { foo: FieldLike } = await oldAppUser.methods
    .get_non_canonical_note(oldUserManager.address)
    .simulate({ from: oldUserManager.address });
  assertEq(
    fooNote.foo,
    FOO,
    "Non-canonical note not initialized with expected FOO value",
  );
  console.log(`   Initialized non-canonical note with FOO: ${FOO}`);

  // ============================================================
  // Step 4: Register migration key for Alice
  // ============================================================
  console.log("Step 4. Registering migration key for Alice...");

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
  // Steps 5-7: Bridge + set snapshot height
  // ============================================================
  console.log("Step 5-7. Bridging archive root and setting snapshot height...");

  const { provenBlockNumber, archiveProof, blockHeader } = await bridgeBlock(
    env,
    newArchiveRegistry,
  );
  console.log(`   Bridge complete. Proven block: ${provenBlockNumber}`);

  // Set snapshot height for Mode B
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
  // Step 8: Derive account keys for Mode B
  // ============================================================
  console.log("Step 8. Deriving account keys...");

  const publicKeys = await oldUserWallet.getPublicKeys(oldUserManager.address)!;
  const completeAddress = await oldUserManager.getCompleteAddress();
  const partialAddress = completeAddress.partialAddress;
  const nhk = await oldUserWallet.getMaskedNhk(
    oldUserManager.address,
    newUserManager.address,
    newApp.address,
  );

  console.log(`   nhk derived`);
  console.log(`   Partial address: ${partialAddress}\n`);

  // ============================================================
  // Step 9: Build proofs and sign
  // ============================================================
  console.log("Step 9. Building proofs and signing...");

  const slot = oldApp.artifact.storageLayout["non_canonical_note"].slot;

  const notesAll = await oldUserWallet.getNotes({
    owner: oldUserManager.address,
    contractAddress: oldApp.address,
    storageSlot: slot,
    scopes: [oldUserManager.address],
  });
  assertEq(
    notesAll.length,
    1,
    `Expected to find exactly 1 note for non-canonical note slot, but found ${notesAll.length}`,
  );

  // The ExampleMigrationApp currently only creates one note per call.
  const notes = notesAll.slice(0, 1);

  // Build proofs via wallet
  const fullProofs = await oldUserWallet.buildFullNoteProofs(
    provenBlockNumber,
    notes,
    (note) => ({ foo: note.items[0] }),
  );

  const keyNoteProof = await oldUserWallet.buildKeyNoteProofData(
    oldKeyRegistry.address,
    oldUserManager.address,
    provenBlockNumber,
  );

  // Sign via standalone function
  const oldMigrationSigner = await oldUserWallet.getMigrationSignerFromAddress(
    oldUserManager.address,
  );
  const signature = await signMigrationModeB(
    oldMigrationSigner,
    blockHeader.global_variables.version,
    new Fr(env.newRollupVersion),
    notes,
    newUserManager.address,
    newApp.address,
  );

  console.log(`   Migration args prepared.\n`);

  // ============================================================
  // Step 10: Call migrate_mode_b on NEW rollup
  // ============================================================
  console.log("Step 10. Calling migrate_mode_b on NEW rollup...");

  // The ExampleMigrationApp currently only supports migrating one note at a time.
  const noteProof = fullProofs[0];
  const migrateFoo = noteProof.note_proof_data.data.foo;
  console.log(`   Migrating foo: ${migrateFoo}`);
  const expectedErrorMsg =
    "Note nullifier does not match canonical nullifier computation";

  try {
    let res = await newAppUser.methods
      .migrate_non_canonical_note_mode_b(
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
    if (!res.status.includes("reverted")) {
      throw new Error(
        "Expected migration of nullified note to fail, but it succeeded",
      );
    } else {
      if (!res.error!.includes(expectedErrorMsg)) {
        throw new Error(
          `Migration failed, but with unexpected error: ${res.error}`,
        );
      }
    }
  } catch (e) {
    const err = e as Error;
    if (!err.message.includes(expectedErrorMsg)) {
      throw new Error(
        `Unexpected error during nullified note test: ${err.message}`,
      );
    }
  }
  console.log(
    "   Expected failure: Note nullifier does not match canonical nullifier computation",
  );
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
