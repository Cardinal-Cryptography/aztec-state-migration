import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { MigrationKeyRegistryContract } from "aztec-state-migration/noir-contracts";
import { Fq, Fr } from "@aztec/foundation/curves/bn254";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";
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

async function main() {
  console.log("=== MigrationKeyRegistry Test (Immutable) ===\n");

  // ============================================================
  // Step 1: Setup client and wallet
  // ============================================================
  console.log("1. Setting up client...");
  const aztecNode = createAztecNodeClient(AZTEC_NODE_URL);
  const wallet = await EmbeddedWallet.create(aztecNode, { ephemeral: true });

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
  const registry = await MigrationKeyRegistryContract.deploy(wallet).send({
    from: alice,
  });
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
    .send({ from: alice });
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
  console.log("   OK: Key registered and matches expected value.\n");

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
  console.log("   OK: Bob has no key registered.\n");

  // ============================================================
  // Step 7: Verify second registration fails (immutability)
  // ============================================================
  console.log("7. Verifying second registration fails...");
  const msk2 = Fq.random();
  const mpk2 = await generatePublicKey(msk2);
  try {
    await registry.methods.register(mpk2.toNoirStruct()).send({ from: alice });
    throw new Error("Expected second registration to fail, but it succeeded");
  } catch (e) {
    const err = e as Error;
    if (
      err.message.includes("duplicate nullifier") ||
      err.message.includes("Existing nullifier")
    ) {
      console.log(
        "   OK: Second registration correctly rejected (existing nullifier).\n",
      );
    } else {
      throw new Error(
        `Unexpected error on second registration: ${err.message}`,
      );
    }
  }

  // ============================================================
  // Step 8: Verify key is unchanged after failed second registration
  // ============================================================
  console.log("8. Verifying key unchanged after failed registration...");
  const keyAfterFailedRegister = toPoint(
    await registry.methods.get(alice).simulate({ from: alice }),
  );
  if (!keyAfterFailedRegister.equals(mpk)) {
    throw new Error("Key changed after failed second registration");
  }
  console.log("   OK: Key unchanged.\n");

  // ============================================================
  // Summary
  // ============================================================
  console.log("=== MigrationKeyRegistry Test Summary ===");
  console.log(`  Contract: ${registry.address}`);
  console.log(
    `  Alice (${alice}): mpk = ${pointStr(registeredKey)} (immutable)`,
  );
  console.log(`  Bob (${bob}): not registered`);
  console.log("  All checks passed!");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
