import { TestWallet } from "@aztec/test-wallet/server";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { MigrationKeyRegistryContract } from "../noir/target/artifacts/MigrationKeyRegistry.js";
import { Fr } from "@aztec/foundation/curves/bn254";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import type { AztecAddress } from "@aztec/stdlib/aztec-address";

const AZTEC_NODE_URL = process.env.AZTEC_NODE_URL ?? "http://localhost:8080";

async function assertCount(
  registry: MigrationKeyRegistryContract,
  owner: AztecAddress,
  expected: number,
  label: string,
) {
  const count = await registry.methods
    .get_count(owner)
    .simulate({ from: owner });
  console.log(`   ${label} key count: ${count}`);
  if (Number(count) !== expected) {
    throw new Error(
      `Expected ${label} key count to be ${expected}, got ${count}`,
    );
  }
}

async function main() {
  console.log("=== MigrationKeyRegistry Test ===\n");

  // ============================================================
  // Step 1: Setup client and wallet
  // ============================================================
  console.log("1. Setting up client...");
  const aztecNode = createAztecNodeClient(AZTEC_NODE_URL);
  const wallet = await TestWallet.create(aztecNode);

  const testAccountsData = await getInitialTestAccountsData();
  const aliceManager = await wallet.createSchnorrAccount(
    testAccountsData[0].secret,
    testAccountsData[0].salt,
    testAccountsData[0].signingKey,
  );
  const bobManager = await wallet.createSchnorrAccount(
    testAccountsData[1].secret,
    testAccountsData[1].salt,
    testAccountsData[1].signingKey,
  );
  const alice = aliceManager.address;
  const bob = bobManager.address;
  console.log(`   Alice: ${alice}`);
  console.log(`   Bob: ${bob}\n`);

  // ============================================================
  // Step 2: Deploy MigrationKeyRegistry
  // ============================================================
  console.log("2. Deploying MigrationKeyRegistry...");
  const registry = await MigrationKeyRegistryContract.deploy(wallet)
    .send({ from: alice })
    .deployed();
  console.log(`   Deployed at: ${registry.address}\n`);

  // ============================================================
  // Step 3: Verify no key is registered initially
  // ============================================================
  console.log("3. Verifying initial state...");
  const initialKey = await registry.methods
    .get(alice)
    .simulate({ from: alice });
  console.log(`   Alice's initial mpk_hash: ${initialKey}`);
  if (BigInt(initialKey) !== 0n) {
    throw new Error("Expected initial mpk_hash to be 0");
  }
  await assertCount(registry, alice, 0, "Alice initial");
  console.log("   OK: No key registered initially.\n");

  // ============================================================
  // Step 4: Register a migration key for Alice
  // ============================================================
  console.log("4. Registering migration key for Alice...");
  const msk = new Fr(12345n);
  const mpkHash = await poseidon2Hash([msk]);
  console.log(`   msk: ${msk}`);
  console.log(`   mpk_hash (computed in TS): ${mpkHash}`);

  const registerTx = await registry.methods
    .register(mpkHash)
    .send({ from: alice })
    .wait();
  console.log(`   Register tx: ${registerTx.txHash}\n`);

  // ============================================================
  // Step 5: Query and verify the registered key
  // ============================================================
  console.log("5. Querying registered key...");
  const registeredKey = await registry.methods
    .get(alice)
    .simulate({ from: alice });
  console.log(`   Alice's mpk_hash: ${registeredKey}`);

  if (BigInt(registeredKey) === 0n) {
    throw new Error("Expected mpk_hash to be non-zero after registration");
  }
  if (BigInt(registeredKey) !== mpkHash.toBigInt()) {
    throw new Error(
      `mpk_hash mismatch: expected ${mpkHash.toBigInt()}, got ${BigInt(registeredKey)}`,
    );
  }
  await assertCount(registry, alice, 1, "Alice after register");
  console.log("   OK: Key registered and matches expected hash.\n");

  // ============================================================
  // Step 6: Verify Bob has no key registered
  // ============================================================
  console.log("6. Verifying Bob has no key...");
  const bobKey = await registry.methods.get(bob).simulate({ from: bob });
  console.log(`   Bob's mpk_hash: ${bobKey}`);
  if (BigInt(bobKey) !== 0n) {
    throw new Error("Expected Bob's mpk_hash to be 0");
  }
  await assertCount(registry, bob, 0, "Bob");
  console.log("   OK: Bob has no key registered.\n");

  // ============================================================
  // Step 7: Cancel registration
  // ============================================================
  console.log("7. Cancelling Alice's registration...");
  const cancelTx = await registry.methods
    .cancel()
    .send({ from: alice })
    .wait();
  console.log(`   Cancel tx: ${cancelTx.txHash}`);

  const keyAfterCancel = await registry.methods
    .get(alice)
    .simulate({ from: alice });
  console.log(`   Alice's mpk_hash after cancel: ${keyAfterCancel}`);
  if (BigInt(keyAfterCancel) !== 0n) {
    throw new Error("Expected mpk_hash to be 0 after cancellation");
  }
  await assertCount(registry, alice, 0, "Alice after cancel");
  console.log("   OK: Registration cancelled, old key revoked.\n");

  // ============================================================
  // Step 8: Re-register with a new key
  // ============================================================
  console.log("8. Re-registering Alice with a new key...");
  const newMsk = new Fr(99999n);
  const newMpkHash = await poseidon2Hash([newMsk]);
  console.log(`   New msk: ${newMsk}`);
  console.log(`   New mpk_hash: ${newMpkHash}`);

  const reRegisterTx = await registry.methods
    .register(newMpkHash)
    .send({ from: alice })
    .wait();
  console.log(`   Re-register tx: ${reRegisterTx.txHash}`);

  const reRegisteredKey = await registry.methods
    .get(alice)
    .simulate({ from: alice });
  console.log(`   Alice's new mpk_hash: ${reRegisteredKey}`);
  if (BigInt(reRegisteredKey) !== newMpkHash.toBigInt()) {
    throw new Error(
      `mpk_hash mismatch after re-register: expected ${newMpkHash.toBigInt()}, got ${BigInt(reRegisteredKey)}`,
    );
  }
  await assertCount(registry, alice, 1, "Alice after re-register");
  console.log("   OK: Re-registration successful, exactly 1 active key.\n");

  // ============================================================
  // Summary
  // ============================================================
  console.log("=== MigrationKeyRegistry Test Summary ===");
  console.log(`  Contract: ${registry.address}`);
  console.log(
    `  Alice (${alice}): mpk_hash = ${reRegisteredKey} (re-registered)`,
  );
  console.log(`  Bob (${bob}): not registered`);
  console.log("  All checks passed!");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
