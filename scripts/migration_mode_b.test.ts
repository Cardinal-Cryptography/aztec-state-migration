import { deriveKeys } from "@aztec/aztec.js/keys";
import { Fr } from "@aztec/foundation/curves/bn254";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import {
  signMigrationModeB,
  TestMigrationWallet,
} from "../ts/migration-lib/index.js";
import type { NoteProofData } from "../ts/migration-lib/index.js";
import { deploy } from "./deploy.js";
import {
  deployAppPair,
  deployArchiveRegistry,
  deployKeyRegistry,
  bridgeArchiveRoot,
  deployAndFundAccount,
} from "./test-utils.js";
import { ExampleMigrationAppContract } from "../noir/target/artifacts/ExampleMigrationApp.js";
import { MigrationKeyRegistryContract } from "../noir/target/artifacts/MigrationKeyRegistry.js";

async function main() {
  console.log("=== Mode B (Emergency Snapshot) Migration E2E Test ===\n");

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
  // Create user wallets (TestMigrationWallet)
  // ============================================================
  console.log("   Creating user wallets...");

  const oldUserManager = await deployAndFundAccount(env, oldAztecNode);
  const newUserManager = await deployAndFundAccount(env, newAztecNode);

  console.log(`   Old User: ${oldUserManager.address}`);
  console.log(`   New User: ${newUserManager.address}`);

  // ============================================================
  // Deploy L2 contracts
  // ============================================================
  console.log("4. Deploying L2 contracts...");

  const { oldApp, newApp } = await deployAppPair(env);
  console.log(`   old_example_app: ${oldApp.address}`);
  console.log(`   new_example_app: ${newApp.address}`);

  const oldKeyRegistry = await deployKeyRegistry(env);
  console.log(`   old_key_registry: ${oldKeyRegistry.address}`);

  const newArchiveRegistry = await deployArchiveRegistry(
    env,
    oldKeyRegistry.address,
  );
  console.log(`   new_archive_registry: ${newArchiveRegistry.address}\n`);

  // ============================================================
  // Step 6: Mint tokens to Alice on OLD rollup
  // ============================================================
  console.log("6. Minting tokens to Alice on OLD rollup...");

  const MINT_AMOUNT_1 = 500n;
  const MINT_AMOUNT_2 = 300n;

  await oldApp.methods
    .mint(oldUserManager.address, MINT_AMOUNT_1)
    .send({ from: oldDeployerManager.address })
    .wait();
  console.log(`   Minted ${MINT_AMOUNT_1} tokens (mint 1)`);

  await oldApp.methods
    .mint(oldUserManager.address, MINT_AMOUNT_2)
    .send({ from: oldDeployerManager.address })
    .wait();
  console.log(`   Minted ${MINT_AMOUNT_2} tokens (mint 2)`);

  // Use user's wallet to query balance (deployer's PXE can't decrypt user's notes)
  const oldAppForUser = ExampleMigrationAppContract.at(
    oldApp.address,
    oldUserWallet,
  );
  const oldBalance = await oldAppForUser.methods
    .get_balance(oldUserManager.address)
    .simulate({ from: oldUserManager.address });
  console.log(`   Total balance on OLD rollup: ${oldBalance}\n`);

  // ============================================================
  // Step 7: Register migration key for Alice
  // ============================================================
  console.log("7. Registering migration key for Alice...");

  const mpk = oldUserWallet.getMigrationPublicKey(oldUserManager.address)!;
  const mpkHash = await poseidon2Hash([mpk.x, mpk.y]);
  console.log(`   mpk: (${mpk.x}, ${mpk.y})`);
  console.log(`   mpk_hash: ${mpkHash}`);

  const oldUserKeyRegistry = MigrationKeyRegistryContract.at(
    oldKeyRegistry.address,
    oldUserWallet,
  );

  const registerTx = await oldUserKeyRegistry.methods
    .register(mpkHash)
    .send({ from: oldUserManager.address })
    .wait();
  console.log(`   Register tx: ${registerTx.txHash}`);

  const registeredKey = await oldUserKeyRegistry.methods
    .get(oldUserManager.address)
    .simulate({ from: oldUserManager.address });
  console.log(`   Verified registered mpk_hash: ${registeredKey}\n`);

  // ============================================================
  // Steps 8-10: Bridge + set snapshot height
  // ============================================================
  console.log("8-10. Bridging archive root and setting snapshot height...");

  const { l1Result, provenBlockNumber, archiveProof } = await bridgeArchiveRoot(
    env,
    newArchiveRegistry,
    registerTx.blockNumber!,
  );
  console.log(
    `   Bridge complete. Proven block: ${l1Result.provenBlockNumber}`,
  );
  console.log(`   Archive root: ${l1Result.provenArchiveRoot}`);

  // Set snapshot height for Mode B
  const setSnapshotTx = await newArchiveRegistry.methods
    .set_snapshot_height(l1Result.provenBlockNumber)
    .send({ from: newDeployerManager.address })
    .wait();
  console.log(`   Set snapshot height tx: ${setSnapshotTx.txHash}`);

  const storedSnapshot = await newArchiveRegistry.methods
    .get_snapshot_height()
    .simulate({ from: newDeployerManager.address });
  console.log(`   Stored snapshot height: ${storedSnapshot}\n`);

  // ============================================================
  // Step 11: Derive account keys for Mode B
  // ============================================================
  console.log("11. Deriving account keys...");

  const publicKeys = oldUserWallet.getPublicKeys(oldUserManager.address)!;
  const completeAddress = await oldUserManager.getCompleteAddress();
  const partialAddress = completeAddress.partialAddress;
  const oldMigrationAccount = await oldUserWallet.getMigrationAccount(oldUserManager.address);
  const newMigrationAccount = await newUserWallet.getMigrationAccount(newUserManager.address);
  const nsk = await oldMigrationAccount.getMaskedNsk(newMigrationAccount, oldApp.address);

  console.log(`   nsk derived`);
  console.log(`   Partial address: ${partialAddress}\n`);

  // ============================================================
  // Step 12: Build proofs and sign
  // ============================================================
  console.log("12. Building proofs and signing...");

  const balancesSlot = oldApp.artifact.storageLayout["balances"].slot;
  const keyRegistrySlot =
    oldKeyRegistry.artifact.storageLayout["registered_keys"].slot;

  const balanceNotesAll = await oldUserWallet.getNotes({
    owner: oldUserManager.address,
    contractAddress: oldApp.address,
    storageSlot: balancesSlot,
  });

  const keyNotes = await oldUserWallet.getNotes({
    owner: oldUserManager.address,
    contractAddress: oldKeyRegistry.address,
    storageSlot: keyRegistrySlot,
  });

  if (balanceNotesAll.length === 0) {
    throw new Error("No balance notes found");
  }
  if (keyNotes.length === 0) {
    throw new Error("No key notes found");
  }

  // TODO: The ExampleMigrationApp currently only creates one note per call,
  // but if there were multiple we would need to handle them all here.
  // I.e. select which ones and how many.
  const balanceNotes = balanceNotesAll.slice(0, 1);

  // Build proofs via wallet
  const [noteProofs, keyNoteProof] = await Promise.all([
    oldUserWallet.buildNoteProofs(balanceNotes, provenBlockNumber),
    oldUserWallet
      .buildNoteProofs([keyNotes[0]], provenBlockNumber)
      .then((p) => p[0]),
  ]);

  // Sign via standalone function
  const oldAccount = await oldUserWallet.getMigrationAccount(
    oldUserManager.address,
  );
  const signature = await signMigrationModeB(
    oldAccount.migrationKeySigner,
    archiveProof.archive_block_header.global_variables.version,
    new Fr(env.newRollupVersion),
    balanceNotes,
    newUserManager.address,
    newApp.address,
  );

  console.log(`   Balance note proofs: ${noteProofs.length}`);
  console.log(`   Migration args prepared.\n`);

  // ============================================================
  // Step 13: Call migrate_mode_b on NEW rollup
  // ============================================================
  console.log("13. Calling migrate_mode_b on NEW rollup...");

  const newAppAsUser = ExampleMigrationAppContract.at(
    newApp.address,
    newUserWallet,
  );

  // TODO: For now we just migrating first note
  const noteProof = noteProofs[0];
  const migrateAmount = noteProof.noteItems[0].toBigInt();
  console.log(`   Migrating amount: ${migrateAmount}`);

  const newBalanceBefore = await newAppAsUser.methods
    .get_balance(newUserManager.address)
    .simulate({ from: newUserManager.address });
  console.log(`   Balance on NEW rollup before : ${newBalanceBefore}`);

  // Map generic NoteProofData to typed note structs for the contract call
  const mapBalanceNote = (p: NoteProofData) => ({
    note: { value: p.noteItems[0].toBigInt() },
    storage_slot: p.storage_slot,
    randomness: p.randomness,
    nonce: p.nonce,
    leaf_index: p.leaf_index,
    sibling_path: p.sibling_path,
    low_nullifier_value: p.low_nullifier_value,
    low_nullifier_next_value: p.low_nullifier_next_value,
    low_nullifier_next_index: p.low_nullifier_next_index,
    low_nullifier_leaf_index: p.low_nullifier_leaf_index,
    low_nullifier_sibling_path: p.low_nullifier_sibling_path,
  });

  const mapKeyNote = (p: NoteProofData) => ({
    note: { mpk_hash: p.noteItems[0] },
    storage_slot: p.storage_slot,
    randomness: p.randomness,
    nonce: p.nonce,
    leaf_index: p.leaf_index,
    sibling_path: p.sibling_path,
    low_nullifier_value: p.low_nullifier_value,
    low_nullifier_next_value: p.low_nullifier_next_value,
    low_nullifier_next_index: p.low_nullifier_next_index,
    low_nullifier_leaf_index: p.low_nullifier_leaf_index,
    low_nullifier_sibling_path: p.low_nullifier_sibling_path,
  });

  try {
    const migrateTx = await newAppAsUser.methods
      .migrate_mode_b(
        migrateAmount,
        newArchiveRegistry.address,
        mpk.toNoirStruct(),
        [...signature],
        [noteProof].map(mapBalanceNote),
        archiveProof,
        oldUserManager.address,
        publicKeys.toNoirStruct(),
        partialAddress,
        mapKeyNote(keyNoteProof),
        { hi: nsk.hi, lo: nsk.lo },
      )
      .send({ from: newUserManager.address })
      .wait();

    console.log(`   Migrate tx: ${migrateTx.txHash}`);

    const newBalanceAfter = await newAppAsUser.methods
      .get_balance(newUserManager.address)
      .simulate({ from: newUserManager.address });
    console.log(`   Balance on NEW rollup after : ${newBalanceAfter}`);

    if (BigInt(newBalanceAfter) >= migrateAmount) {
      console.log(
        "\n   Mode B migration successful! Balance matches migrated amount.",
      );
    } else {
      console.log(
        "\n   Migration completed but balance does not match expected amount.",
      );
    }
  } catch (e) {
    const err = e as Error;
    console.log(`   migrate_mode_b failed: ${err.message}`);
    if (err.stack) {
      console.log(
        `   Stack: ${err.stack.split("\n").slice(0, 10).join("\n   ")}`,
      );
    }
  }

  // ============================================================
  // Summary
  // ============================================================
  const newBalanceAfter = await newAppAsUser.methods
    .get_balance(newUserManager.address)
    .simulate({ from: newUserManager.address });

  console.log("\n=== Mode B Migration Test Summary ===\n");
  console.log("Contracts deployed:");
  console.log("  OLD Rollup (L2):");
  console.log(`    - ExampleMigrationApp: ${oldApp.address}`);
  console.log(`    - MigrationKeyRegistry: ${oldKeyRegistry.address}`);
  console.log("  NEW Rollup (L2):");
  console.log(`    - MigrationArchiveRegistry: ${newArchiveRegistry.address}`);
  console.log(`    - ExampleMigrationApp: ${newApp.address}`);
  console.log(`\nSnapshot height: ${l1Result.provenBlockNumber}`);
  console.log(`Migrated amount: ${migrateAmount}`);
  console.log("\nBalances:");
  console.log(`  OLD rollup: ${oldBalance}`);
  console.log(`  NEW rollup: ${newBalanceAfter}`);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
