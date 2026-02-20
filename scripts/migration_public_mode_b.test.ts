import { Fr } from "@aztec/foundation/curves/bn254";
import { deploy } from "./deploy.js";
import {
  deployAppPair,
  deployArchiveRegistry,
  deployKeyRegistry,
  bridgeArchiveRoot,
  deployAndFundAccount,
  assertEq,
} from "./test-utils.js";
import {
  ExampleMigrationAppContract,
  ExampleMigrationAppContractArtifact,
} from "../ts/migration-lib/noir-contracts/ExampleMigrationApp.js";
import { MigrationKeyRegistryContract } from "../ts/migration-lib/noir-contracts/MigrationKeyRegistry.js";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import {
  buildPublicDataProof,
  buildPublicMapDataProof,
} from "../ts/migration-lib/mode-b/proofs.js";
import { randomBigInt } from "@aztec/foundation/crypto/random";
import { MAX_U64_VALUE } from "@aztec/constants";
// Define a struct that matches the one used in the example app contract,
// for ease of use in the test.
interface SomeStruct {
  a: number | bigint;
  b: AztecAddress;
}

// Extract the ABI type for SomeStruct from the contract artifact.
// Public setter functions are folded into public_dispatch by loadContractArtifact,
// so we pull the type from a migration function's PublicStateProofData<SomeStruct,2>.data field.
const proofDataAbiType = ExampleMigrationAppContractArtifact.functions
  .find((f) => f.name === "migrate_to_public_struct_mode_b")!
  .parameters.find((p) => p.name === "some_struct_standalone_proof_data")!.type;
if (proofDataAbiType.kind !== "struct")
  throw new Error("Expected struct ABI type");
const someStructAbiType = proofDataAbiType.fields.find(
  (f) => f.name === "data",
)!.type;

// Helper function to generate random SomeStruct instances for testing.
async function randomSomeStruct(): Promise<SomeStruct> {
  return {
    a: randomBigInt(MAX_U64_VALUE ** 64n),
    b: await AztecAddress.random(),
  };
}

async function main() {
  console.log("=== Mode B Public State Migration E2E Test ===\n");

  // ============================================================
  // Deploy shared infrastructure
  // ============================================================
  const env = await deploy();

  const { aztecNode: oldAztecNode, migrationWallet: oldUserWallet } =
    env[env.oldRollupVersion];
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
  const oldUser2Manager = await deployAndFundAccount(env, oldAztecNode);
  const newUserManager = await deployAndFundAccount(env, newAztecNode);
  const newUser2Manager = await deployAndFundAccount(env, newAztecNode);

  console.log(`   Old User: ${oldUserManager.address}`);
  console.log(`   Old User2: ${oldUser2Manager.address}`);
  console.log(`   New User: ${newUserManager.address}`);
  console.log(`   New User2: ${newUser2Manager.address}\n`);

  // ============================================================
  // Deploy L2 contracts
  // ============================================================
  console.log("2. Deploying L2 contracts...");

  const oldKeyRegistry = await deployKeyRegistry(env);
  const newArchiveRegistry = await deployArchiveRegistry(
    env,
    oldKeyRegistry.address,
  );
  const { oldApp: oldAppDeployer, newApp: newAppDeployer } =
    await deployAppPair(env, newArchiveRegistry.address);
  const oldApp = oldAppDeployer.address;
  const newApp = newAppDeployer.address;

  const oldAppUser = ExampleMigrationAppContract.at(oldApp, oldUserWallet);
  const newAppUser = ExampleMigrationAppContract.at(newApp, newUserWallet);

  // ============================================================
  // Register migration key
  // ============================================================
  console.log("3. Registering migration key...");

  const oldUserKeyRegistry = MigrationKeyRegistryContract.at(
    oldKeyRegistry.address,
    oldUserWallet,
  );

  const mpk = oldUserWallet.getMigrationPublicKey(oldUserManager.address)!;
  await oldUserKeyRegistry.methods
    .register(mpk.toNoirStruct())
    .send({ from: oldUserManager.address })
    .wait();

  const mpk2 = oldUserWallet.getMigrationPublicKey(oldUser2Manager.address)!;
  await oldUserKeyRegistry.methods
    .register(mpk2.toNoirStruct())
    .send({ from: oldUser2Manager.address })
    .wait();

  // ============================================================
  // Set Public Storage on OLD rollup
  // ============================================================
  console.log("4. Setting public storage on OLD rollup...");

  // Set single struct
  const STRUCT_SINGLE = await randomSomeStruct();
  await oldAppUser.methods
    .init_struct_single(STRUCT_SINGLE)
    .send({ from: oldUserManager.address })
    .wait();
  let structResult: SomeStruct = await oldAppUser.methods
    .get_struct_single()
    .simulate({ from: oldUserManager.address });
  assertEq(structResult, STRUCT_SINGLE, "Struct single");

  // Set struct in map
  const STRUCT_MAP_KEY = Fr.random();
  const STRUCT_MAP = await randomSomeStruct();
  await oldAppUser.methods
    .init_struct_map(STRUCT_MAP_KEY, STRUCT_MAP)
    .send({ from: oldUserManager.address })
    .wait();
  structResult = await oldAppUser.methods
    .get_struct_map(STRUCT_MAP_KEY)
    .simulate({ from: oldUserManager.address });
  assertEq(structResult, STRUCT_MAP, "Struct map");

  // Set owned struct in map
  const OWNED_STRUCT_MAP_OWNER = oldUserManager.address;
  const OWNED_STRUCT_MAP = await randomSomeStruct();
  await oldAppUser.methods
    .init_owned_struct_map(OWNED_STRUCT_MAP)
    .send({ from: OWNED_STRUCT_MAP_OWNER })
    .wait();
  structResult = await oldAppUser.methods
    .get_owned_struct_map(OWNED_STRUCT_MAP_OWNER)
    .simulate({ from: oldUserManager.address });
  assertEq(structResult, OWNED_STRUCT_MAP, "Owned struct map");

  // Set owned struct in nested map
  const OWNED_STRUCT_NESTED_MAP_KEY = Fr.random();
  const OWNED_STRUCT_NESTED_MAP_OWNER = oldUser2Manager.address;
  const OWNED_STRUCT_NESTED_MAP = await randomSomeStruct();
  await oldAppUser.methods
    .init_owned_struct_nested_map(
      OWNED_STRUCT_NESTED_MAP_KEY,
      OWNED_STRUCT_NESTED_MAP,
    )
    .send({ from: OWNED_STRUCT_NESTED_MAP_OWNER })
    .wait();
  structResult = await oldAppUser.methods
    .get_owned_struct_nested_map(
      OWNED_STRUCT_NESTED_MAP_KEY,
      OWNED_STRUCT_NESTED_MAP_OWNER,
    )
    .simulate({ from: OWNED_STRUCT_NESTED_MAP_OWNER });
  assertEq(structResult, OWNED_STRUCT_NESTED_MAP, "Owned struct nested map");

  // ============================================================
  // Bridge archive root + set snapshot height
  // ============================================================
  console.log("5. Bridging archive root and setting snapshot height...");

  const { provenBlockNumber, archiveProof } = await bridgeArchiveRoot(
    env,
    newArchiveRegistry,
  );
  console.log(`   Proven block: ${provenBlockNumber}`);

  await newArchiveRegistry.methods
    .set_snapshot_height(provenBlockNumber)
    .send({ from: newDeployerManager.address })
    .wait();

  // ============================================================
  // Get public data tree witnesses for SomeStruct (2 fields)
  // ============================================================
  console.log("8. Getting public data tree witnesses...");

  let slot = oldAppDeployer.artifact.storageLayout["struct_single"].slot;
  const structSingleProof = await buildPublicDataProof(
    oldAztecNode,
    provenBlockNumber,
    STRUCT_SINGLE,
    oldApp,
    slot,
    someStructAbiType,
  );

  slot = oldAppDeployer.artifact.storageLayout["struct_map"].slot;
  const structMapProof = await buildPublicMapDataProof(
    oldAztecNode,
    provenBlockNumber,
    STRUCT_MAP,
    oldApp,
    slot,
    [STRUCT_MAP_KEY],
    someStructAbiType,
  );

  slot = oldAppDeployer.artifact.storageLayout["owned_struct_map"].slot;
  const ownedStructMapProof = await buildPublicMapDataProof(
    oldAztecNode,
    provenBlockNumber,
    OWNED_STRUCT_MAP,
    oldApp,
    slot,
    [OWNED_STRUCT_MAP_OWNER],
    someStructAbiType,
  );

  slot = oldAppDeployer.artifact.storageLayout["owned_struct_nested_map"].slot;
  const ownedStructNestedMapProof = await buildPublicMapDataProof(
    oldAztecNode,
    provenBlockNumber,
    OWNED_STRUCT_NESTED_MAP,
    oldApp,
    slot,
    [OWNED_STRUCT_NESTED_MAP_KEY, OWNED_STRUCT_NESTED_MAP_OWNER],
    someStructAbiType,
  );

  // ============================================================
  // Migration on NEW rollup
  // ============================================================

  console.log("10. Migration Single Struct on NEW rollup...");
  await newAppUser.methods
    .migrate_to_public_struct_mode_b(structSingleProof, archiveProof)
    .send({ from: newUserManager.address })
    .wait();
  // Verify struct was set on new rollup
  structResult = await newAppUser.methods
    .get_struct_single()
    .simulate({ from: newUserManager.address });
  assertEq(structResult, STRUCT_SINGLE, "Migrated struct single");
  console.log("Single struct migration successful!");

  console.log("11. Migration Struct Map on NEW rollup...");
  await newAppUser.methods
    .migrate_to_public_struct_map_mode_b(
      structMapProof,
      archiveProof,
      STRUCT_MAP_KEY,
    )
    .send({ from: newUserManager.address })
    .wait();
  // Verify struct was set on new rollup
  structResult = await newAppUser.methods
    .get_struct_map(STRUCT_MAP_KEY)
    .simulate({ from: newUserManager.address });
  assertEq(structResult, STRUCT_MAP, "Migrated struct map");
  console.log("Struct map migration successful!");

  console.log("12. Migration Owned Struct Map on NEW rollup...");
  const keyNoteProof = await oldUserWallet.buildKeyNoteProofData(
    oldKeyRegistry.address,
    OWNED_STRUCT_MAP_OWNER,
    provenBlockNumber,
  );
  const oldAccountUser = await oldUserWallet.getMigrationAccount(
    OWNED_STRUCT_MAP_OWNER,
  );
  const ownseStructMapSignature =
    await newUserWallet.signPublicStateMigrationModeB(
      oldAccountUser,
      newUserManager.address,
      new Fr(env.oldRollupVersion),
      new Fr(env.newRollupVersion),
      newApp,
      OWNED_STRUCT_MAP,
      someStructAbiType,
    );
  await newAppUser.methods
    .migrate_to_public_owned_struct_map_mode_b(
      ownedStructMapProof,
      archiveProof,
      OWNED_STRUCT_MAP_OWNER,
      ownseStructMapSignature,
      keyNoteProof,
    )
    .send({ from: newUserManager.address })
    .wait();
  // Verify struct was set on new rollup
  structResult = await newAppUser.methods
    .get_owned_struct_map(newUserManager.address)
    .simulate({ from: newUserManager.address });
  assertEq(structResult, OWNED_STRUCT_MAP, "Migrated owned struct map");
  console.log("Owned struct map migration successful!");

  console.log("13. Migration Owned Struct Nested Map on NEW rollup...");
  const keyNoteProof2 = await oldUserWallet.buildKeyNoteProofData(
    oldKeyRegistry.address,
    OWNED_STRUCT_NESTED_MAP_OWNER,
    provenBlockNumber,
  );
  const oldAccountUser2 = await oldUserWallet.getMigrationAccount(
    OWNED_STRUCT_NESTED_MAP_OWNER,
  );
  const ownedStructNestedMapSignature =
    await newUserWallet.signPublicStateMigrationModeB(
      oldAccountUser2,
      newUser2Manager.address,
      new Fr(env.oldRollupVersion),
      new Fr(env.newRollupVersion),
      newApp,
      OWNED_STRUCT_NESTED_MAP,
      someStructAbiType,
    );
  await newAppUser.methods
    .migrate_to_public_owned_struct_nested_map_mode_b(
      ownedStructNestedMapProof,
      archiveProof,
      OWNED_STRUCT_NESTED_MAP_OWNER,
      ownedStructNestedMapSignature,
      keyNoteProof2,
      OWNED_STRUCT_NESTED_MAP_KEY,
    )
    .send({ from: newUser2Manager.address })
    .wait();
  // Verify struct was set on new rollup
  structResult = await newAppUser.methods
    .get_owned_struct_nested_map(
      OWNED_STRUCT_NESTED_MAP_KEY,
      newUser2Manager.address,
    )
    .simulate({ from: newUser2Manager.address });
  assertEq(
    structResult,
    OWNED_STRUCT_NESTED_MAP,
    "Migrated owned struct nested map",
  );
  console.log("Owned struct nested map migration successful!");

  console.log("\nAll migrations successful!");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
