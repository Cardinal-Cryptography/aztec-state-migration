import { TestWallet } from "@aztec/test-wallet/server";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { MigrationKeyRegistryContract } from "../noir/target/artifacts/MigrationKeyRegistry.js";
import { Fq, Fr } from "@aztec/foundation/curves/bn254";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import type { AztecAddress } from "@aztec/stdlib/aztec-address";
import { generatePublicKey } from "@aztec/aztec.js/keys";
import { Point } from "@aztec/foundation/curves/grumpkin";

const AZTEC_NODE_URL = process.env.AZTEC_NODE_URL ?? "http://localhost:8080";

/** simulate() returns a plain {x, y, is_infinite} object – convert to a Point instance. */
function toPoint(obj: any): Point {
  return new Point(
    Fr.fromPlainObject(obj.x),
    Fr.fromPlainObject(obj.y),
    obj.is_infinite,
  );
}

/** Point.toString() throws for infinite points – use this for safe logging. */
function pointStr(p: Point): string {
  return p.isZero() ? "<infinity>" : p.toString();
}

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
  const initialKey = toPoint(
    await registry.methods.get(alice).simulate({ from: alice }),
  );
  console.log(`   Alice's initial mpk: ${pointStr(initialKey)}`);
  if (!initialKey.isZero()) {
    throw new Error("Expected initial mpk to be zero (point at infinity)");
  }
  await assertCount(registry, alice, 0, "Alice initial");
  console.log("   OK: No key registered initially.\n");

  // ============================================================
  // Step 4: Register a migration key for Alice
  // ============================================================
  console.log("4. Registering migration key for Alice...");
  const msk = Fq.random();
  const mpk = await generatePublicKey(msk);
  console.log(`   msk: ${msk}`);
  console.log(`   mpk (computed in TS): ${mpk}`);

  const registerTx = await registry.methods
    .register(mpk.toNoirStruct())
    .send({ from: alice })
    .wait();
  console.log(`   Register tx: ${registerTx.txHash}\n`);

  // ============================================================
  // Step 5: Query and verify the registered key
  // ============================================================
  console.log("5. Querying registered key...");
  const registeredKey = toPoint(
    await registry.methods.get(alice).simulate({ from: alice }),
  );
  console.log(`   Alice's mpk: ${pointStr(registeredKey)}`);

  if (registeredKey.isZero()) {
    throw new Error("Expected mpk to be non-zero after registration");
  }
  if (!registeredKey.equals(mpk)) {
    throw new Error(
      `mpk mismatch: expected ${pointStr(mpk)}, got ${pointStr(registeredKey)}`,
    );
  }
  await assertCount(registry, alice, 1, "Alice after register");
  console.log("   OK: Key registered and matches expected hash.\n");

  // ============================================================
  // Step 6: Verify Bob has no key registered
  // ============================================================
  console.log("6. Verifying Bob has no key...");
  const bobKey = toPoint(
    await registry.methods.get(bob).simulate({ from: bob }),
  );
  console.log(`   Bob's mpk: ${pointStr(bobKey)}`);
  if (!bobKey.isZero()) {
    throw new Error("Expected Bob's mpk to be zero");
  }
  await assertCount(registry, bob, 0, "Bob");
  console.log("   OK: Bob has no key registered.\n");

  // ============================================================
  // Step 7: Cancel registration
  // ============================================================
  console.log("7. Cancelling Alice's registration...");
  const cancelTx = await registry.methods.cancel().send({ from: alice }).wait();
  console.log(`   Cancel tx: ${cancelTx.txHash}`);

  const keyAfterCancel = toPoint(
    await registry.methods.get(alice).simulate({ from: alice }),
  );
  console.log(`   Alice's mpk after cancel: ${pointStr(keyAfterCancel)}`);
  if (!keyAfterCancel.isZero()) {
    throw new Error("Expected mpk to be zero after cancellation");
  }
  await assertCount(registry, alice, 0, "Alice after cancel");
  console.log("   OK: Registration cancelled, old key revoked.\n");

  // ============================================================
  // Step 8: Re-register with a new key
  // ============================================================
  console.log("8. Re-registering Alice with a new key...");
  const newMsk = Fq.random();
  const newMpk = await generatePublicKey(newMsk);
  console.log(`   New msk: ${newMsk}`);
  console.log(`   New mpk: ${newMpk}`);

  const reRegisterTx = await registry.methods
    .register(newMpk.toNoirStruct())
    .send({ from: alice })
    .wait();
  console.log(`   Re-register tx: ${reRegisterTx.txHash}`);

  const reRegisteredKey = toPoint(
    await registry.methods.get(alice).simulate({ from: alice }),
  );
  console.log(`   Alice's new mpk: ${pointStr(reRegisteredKey)}`);
  if (reRegisteredKey.isZero()) {
    throw new Error("Expected mpk to be non-zero after re-registration");
  }
  await assertCount(registry, alice, 1, "Alice after re-register");
  console.log("   OK: Re-registration successful, exactly 1 active key.\n");

  // ============================================================
  // Summary
  // ============================================================
  console.log("=== MigrationKeyRegistry Test Summary ===");
  console.log(`  Contract: ${registry.address}`);
  console.log(
    `  Alice (${alice}): mpk = ${pointStr(reRegisteredKey)} (re-registered)`,
  );
  console.log(`  Bob (${bob}): not registered`);
  console.log("  All checks passed!");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
