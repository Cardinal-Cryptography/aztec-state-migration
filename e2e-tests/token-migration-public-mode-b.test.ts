import { Fr } from "@aztec/foundation/curves/bn254";
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
import {
  TokenMigrationAppV2Contract,
  TokenMigrationAppV2ContractArtifact,
} from "./artifacts/TokenMigrationAppV2.js";
import { MigrationKeyRegistryContract } from "../ts/aztec-state-migration/noir-contracts/MigrationKeyRegistry.js";
import { buildPublicMapDataProof } from "../ts/aztec-state-migration/mode-b/proofs.js";

// Extract ABI type for the balance proof data from the contract artifact
const proofDataAbiType = TokenMigrationAppV2ContractArtifact.functions
  .find((f) => f.name === "migrate_public_balance_mode_b")!
  .parameters.find((p) => p.name === "proof_data")!.type;
if (proofDataAbiType.kind !== "struct")
  throw new Error("Expected struct ABI type for proof_data");
const balanceAbiType = proofDataAbiType.fields.find(
  (f) => f.name === "data",
)!.type;

async function main() {
  console.log("=== Token Mode B Public State Migration E2E Test ===\n");

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
  const { oldApp, newApp } = await deployTokenAppPair(
    env,
    newArchiveRegistry.address,
  );
  const newAppUser = TokenMigrationAppV2Contract.at(
    newApp.address,
    newUserWallet,
  );

  console.log(`   old_token_app: ${oldApp.address}`);
  console.log(`   new_token_app: ${newApp.address}\n`);

  // ============================================================
  // Step 3: Mint public tokens on OLD rollup
  // ============================================================
  console.log("Step 3. Minting public tokens on OLD rollup...");

  const MINT_AMOUNT = 1000n;
  await oldApp.methods
    .mint_to_public(oldUserManager.address, MINT_AMOUNT)
    .send({ from: oldDeployerManager.address });

  const oldPublicBalance = await oldApp.methods
    .balance_of_public(oldUserManager.address)
    .simulate({ from: oldDeployerManager.address });
  assertEq(oldPublicBalance, MINT_AMOUNT, "Old public balance after mint");

  const oldTotalSupply = await oldApp.methods
    .total_supply()
    .simulate({ from: oldDeployerManager.address });
  assertEq(oldTotalSupply, MINT_AMOUNT, "Old total supply after mint");
  console.log(
    `   Minted ${MINT_AMOUNT}, balance: ${oldPublicBalance}, total_supply: ${oldTotalSupply}\n`,
  );

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

  const slot = oldApp.artifact.storageLayout["public_balances"].slot;
  const publicBalanceProof = await buildPublicMapDataProof(
    oldAztecNode,
    provenBlockNumber,
    MINT_AMOUNT,
    oldApp.address,
    slot,
    [oldUserManager.address],
    balanceAbiType,
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
  const signature = await newUserWallet.signPublicStateMigrationModeB(
    oldMigrationSigner,
    newUserManager.address,
    new Fr(env.oldRollupVersion),
    new Fr(env.newRollupVersion),
    newApp.address,
    MINT_AMOUNT,
    balanceAbiType,
  );

  // ============================================================
  // Step 9: Call migrate_public_balance_mode_b on NEW rollup
  // ============================================================
  console.log("Step 9. Calling migrate_public_balance_mode_b on NEW rollup...");

  await newAppUser.methods
    .migrate_public_balance_mode_b(
      publicBalanceProof,
      blockHeader,
      oldUserManager.address,
      signature,
      keyNoteProof,
    )
    .send({ from: newUserManager.address });

  const newPublicBalance = await newApp.methods
    .balance_of_public(newUserManager.address)
    .simulate({ from: newDeployerManager.address });
  assertEq(newPublicBalance, MINT_AMOUNT, "New public balance after migrate");

  const newTotalSupply = await newApp.methods
    .total_supply()
    .simulate({ from: newDeployerManager.address });
  assertEq(newTotalSupply, MINT_AMOUNT, "New total supply after migrate");

  console.log(
    `   Public balance on NEW rollup: ${newPublicBalance}, total_supply: ${newTotalSupply}`,
  );
  console.log("   Public balance Mode B migration successful!\n");

  // ============================================================
  // Step 10: Double migration negative test
  // ============================================================
  console.log("Step 10. Testing double migration (should fail)...");
  await expectRevert(
    newAppUser.methods
      .migrate_public_balance_mode_b(
        publicBalanceProof,
        blockHeader,
        oldUserManager.address,
        signature,
        keyNoteProof,
      )
      .send({ from: newUserManager.address }),
  );
  console.log("   Double migration correctly rejected!\n");

  // ============================================================
  // Summary
  // ============================================================
  console.log("=== Token Public Mode B Migration Test Summary ===\n");
  console.log(`Snapshot height: ${provenBlockNumber}`);
  console.log(`Migrated amount: ${MINT_AMOUNT}`);
  console.log(`New rollup public balance: ${newPublicBalance}`);
  console.log(`New rollup total supply: ${newTotalSupply}`);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
