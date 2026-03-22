import { Fr } from "@aztec/foundation/curves/bn254";
import { buildFullL1ToL2MessageProof } from "aztec-state-migration/mode-b";
import { deploy } from "./deploy.js";
import {
  deployAppPair,
  deployArchiveRegistry,
  bridgeBlock,
  deployAndFundAccount,
  assertEq,
  expectRevert,
  waitForL1ToL2Message,
  produceBlock,
} from "./test-utils.js";
import { ExampleMigrationAppV1Contract } from "./artifacts/ExampleMigrationAppV1.js";
import { ExampleMigrationAppV2Contract } from "./artifacts/ExampleMigrationAppV2.js";
import { getContract } from "viem";
import { InboxAbi } from "@aztec/l1-artifacts";
import { generateClaimSecret } from "@aztec/aztec.js/ethereum";
import { L1ToL2Message, L1Actor, L2Actor } from "@aztec/stdlib/messaging";
import { EthAddress } from "@aztec/foundation/eth-address";

async function main() {
  console.log(
    "=== Mode B: Unconsumed L1-to-L2 Message Migration E2E Test ===\n",
  );

  // ============================================================
  // Step 1: Deploy shared infrastructure
  // ============================================================
  const env = await deploy();

  const {
    aztecNode: oldAztecNode,
    deployerManager: oldDeployerManager,
    deployerWallet: oldDeployerWallet,
  } = env[env.oldRollupVersion];
  const {
    deployerManager: newDeployerManager,
    migrationWallet: newUserWallet,
  } = env[env.newRollupVersion];

  // ============================================================
  // Step 2: Create user wallets
  // ============================================================
  console.log("Step 1. Creating user wallets...");

  const newUserManager = await deployAndFundAccount(
    env,
    env[env.newRollupVersion].aztecNode,
  );
  console.log(`   New User: ${newUserManager.address}\n`);

  // ============================================================
  // Step 3: Deploy L2 contracts
  // ============================================================
  console.log("Step 2. Deploying L2 contracts...");

  const newArchiveRegistry = await deployArchiveRegistry(env);

  const { oldApp, newApp } = await deployAppPair(
    env,
    newArchiveRegistry.address,
  );
  const newAppUser = ExampleMigrationAppV2Contract.at(
    newApp.address,
    newUserWallet,
  );

  console.log(`   old_example_app: ${oldApp.address}`);
  console.log(`   new_example_app: ${newApp.address}`);
  console.log(`   new_archive_registry: ${newArchiveRegistry.address}\n`);

  // ============================================================
  // Step 4: Send L1→L2 message to old app (do NOT consume it)
  // ============================================================
  console.log("Step 3. Sending L1→L2 message to old app (unconsumed)...");

  const MESSAGE_AMOUNT = 42n;
  const [msgSecret, msgSecretHash] = await generateClaimSecret();
  const messageContent = new Fr(MESSAGE_AMOUNT);

  const inboxContract = getContract({
    address: env[env.oldRollupVersion].inboxAddress as `0x${string}`,
    abi: InboxAbi,
    client: env.l1WalletClient,
  });

  const msgTxHash = await inboxContract.write.sendL2Message([
    {
      actor: oldApp.address.toString() as `0x${string}`,
      version: BigInt(env.oldRollupVersion),
    },
    messageContent.toString() as `0x${string}`,
    msgSecretHash.toString() as `0x${string}`,
  ]);
  const msgReceipt = await env.publicClient.waitForTransactionReceipt({
    hash: msgTxHash,
  });

  // Parse MessageSent event to get the leaf index
  const msgSentLog = msgReceipt.logs.find(
    (log) =>
      log.address.toLowerCase() ===
      env[env.oldRollupVersion].inboxAddress.toLowerCase(),
  );
  if (!msgSentLog) throw new Error("MessageSent event not found");
  const msgLeafIndex = BigInt(msgSentLog.data.slice(0, 66));

  const l1Sender = new L1Actor(
    EthAddress.fromString(env.l1WalletClient.account!.address),
    Number(await env.publicClient.getChainId()),
  );
  const l2Recipient = new L2Actor(oldApp.address, env.oldRollupVersion);
  const l1ToL2Message = new L1ToL2Message(
    l1Sender,
    l2Recipient,
    messageContent,
    msgSecretHash,
    new Fr(msgLeafIndex),
  );
  console.log(`   Message hash: ${l1ToL2Message.hash()}`);
  console.log(`   Leaf index: ${msgLeafIndex}`);
  console.log(`   Content (amount): ${MESSAGE_AMOUNT}`);

  // Wait for the message to be included in the old rollup's L1→L2 message tree
  console.log("   Waiting for message inclusion in old rollup...");
  await waitForL1ToL2Message(oldAztecNode, l1ToL2Message.hash(), {
    onPoll: async () => {
      await produceBlock(env, oldAztecNode);
    },
  });
  console.log("   Message included in old rollup.\n");

  // ============================================================
  // Step 3b: Send a second L1→L2 message and CONSUME it on old rollup
  // ============================================================
  console.log("Step 3b. Sending second L1→L2 message and consuming it...");

  const CONSUMED_MSG_AMOUNT = 99n;
  const [consumedSecret, consumedSecretHash] = await generateClaimSecret();
  const consumedContent = new Fr(CONSUMED_MSG_AMOUNT);

  const consumedMsgTxHash = await inboxContract.write.sendL2Message([
    {
      actor: oldApp.address.toString() as `0x${string}`,
      version: BigInt(env.oldRollupVersion),
    },
    consumedContent.toString() as `0x${string}`,
    consumedSecretHash.toString() as `0x${string}`,
  ]);
  const consumedMsgReceipt = await env.publicClient.waitForTransactionReceipt({
    hash: consumedMsgTxHash,
  });

  const consumedMsgSentLog = consumedMsgReceipt.logs.find(
    (log) =>
      log.address.toLowerCase() ===
      env[env.oldRollupVersion].inboxAddress.toLowerCase(),
  );
  if (!consumedMsgSentLog)
    throw new Error("MessageSent event not found for consumed message");
  const consumedMsgLeafIndex = BigInt(consumedMsgSentLog.data.slice(0, 66));

  const consumedL1ToL2Message = new L1ToL2Message(
    l1Sender,
    l2Recipient,
    consumedContent,
    consumedSecretHash,
    new Fr(consumedMsgLeafIndex),
  );
  console.log(`   Consumed message hash: ${consumedL1ToL2Message.hash()}`);

  // Wait for the consumed message to be included
  await waitForL1ToL2Message(oldAztecNode, consumedL1ToL2Message.hash(), {
    onPoll: async () => {
      await produceBlock(env, oldAztecNode);
    },
  });

  // Consume the message on the old rollup
  const oldAppDeployer = ExampleMigrationAppV1Contract.at(
    oldApp.address,
    oldDeployerWallet,
  );
  await oldAppDeployer.methods
    .consume_l1_to_l2_message(
      consumedContent,
      consumedSecret,
      EthAddress.fromString(env.l1WalletClient.account!.address),
      consumedMsgLeafIndex,
    )
    .send({ from: oldDeployerManager.address });
  console.log("   Message consumed on old rollup.\n");

  // ============================================================
  // Step 4: Bridge + set snapshot height
  // ============================================================
  console.log("Step 4. Bridging archive root and setting snapshot height...");

  const { provenBlockNumber, archiveProof, blockHeader } = await bridgeBlock(
    env,
    newArchiveRegistry,
  );
  console.log(`   Bridge complete. Proven block: ${provenBlockNumber}`);

  const setSnapshotTx = await newArchiveRegistry.methods
    .set_snapshot_height(
      provenBlockNumber,
      blockHeader,
      provenBlockNumber,
      archiveProof.archive_sibling_path,
    )
    .send({ from: newDeployerManager.address });

  const { result: storedSnapshot } = await newArchiveRegistry.methods
    .get_snapshot_height()
    .simulate({ from: newDeployerManager.address });
  console.log(`   Stored snapshot height: ${storedSnapshot}\n`);

  // ============================================================
  // Step 6: Migrate unconsumed L1→L2 message (happy path)
  // ============================================================
  console.log("Step 5. Migrating unconsumed L1→L2 message...");

  const messageProof = await buildFullL1ToL2MessageProof(
    oldAztecNode,
    provenBlockNumber,
    oldApp.address,
    l1ToL2Message,
    msgSecret,
  );

  const { result: balanceBefore } = await newAppUser.methods
    .get_balance(newUserManager.address)
    .simulate({ from: newUserManager.address });
  console.log(`   Balance on NEW rollup before: ${balanceBefore}`);

  await newAppUser.methods
    .migrate_l1_to_l2_message_mode_b(messageProof, msgSecret, blockHeader)
    .send({ from: newUserManager.address });

  const { result: balanceAfter } = await newAppUser.methods
    .get_balance(newUserManager.address)
    .simulate({ from: newUserManager.address });
  console.log(`   Balance on NEW rollup after: ${balanceAfter}`);

  assertEq(
    balanceAfter - balanceBefore,
    MESSAGE_AMOUNT,
    "L1-to-L2 message migration: balance mismatch",
  );
  console.log("   L1-to-L2 message migration successful!\n");

  // ============================================================
  // Step 7: Double migration negative test (should fail)
  // ============================================================
  console.log(
    "Step 6. Testing double L1→L2 message migration (should fail)...",
  );

  await expectRevert(
    newAppUser.methods
      .migrate_l1_to_l2_message_mode_b(messageProof, msgSecret, blockHeader)
      .send({ from: newUserManager.address }),
    "Existing nullifier",
  );
  console.log("   Expected failure: message already migrated.\n");

  // ============================================================
  // Step 7: Consumed message migration negative test (should fail)
  // ============================================================
  console.log(
    "Step 7. Testing consumed L1→L2 message migration (should fail)...",
  );

  const consumedMessageProof = await buildFullL1ToL2MessageProof(
    oldAztecNode,
    provenBlockNumber,
    oldApp.address,
    consumedL1ToL2Message,
    consumedSecret,
  );

  await expectRevert(
    newAppUser.methods
      .migrate_l1_to_l2_message_mode_b(
        consumedMessageProof,
        consumedSecret,
        blockHeader,
      )
      .send({ from: newUserManager.address }),
    "Nullifier non-inclusion",
  );
  console.log("   Expected failure: message was consumed on old rollup.\n");

  // ============================================================
  // Summary
  // ============================================================
  console.log("\n=== L1-to-L2 Message Migration Test Summary ===\n");
  console.log(`Snapshot height: ${provenBlockNumber}`);
  console.log(`Message content (amount): ${MESSAGE_AMOUNT}`);
  console.log(`Balance before migration: ${balanceBefore}`);
  console.log(`Balance after migration: ${balanceAfter}`);
  console.log("Double migration: correctly rejected");
  console.log("Consumed message migration: correctly rejected");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
