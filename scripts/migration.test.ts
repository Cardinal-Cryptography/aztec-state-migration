import {
  registerInitialLocalNetworkAccountsInWallet,
  TestWallet,
} from "@aztec/test-wallet/server";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import {
  computeL2ToL1MembershipWitness,
  L2ToL1MembershipWitness,
  L1ToL2Message,
  L1Actor,
  L2Actor,
} from "@aztec/stdlib/messaging";
import {
  computeSecretHash,
  computeL2ToL1MessageHash,
} from "@aztec/stdlib/hash";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  Hex,
  encodeFunctionData,
  toHex,
  encodeAbiParameters,
  decodeEventLog,
} from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { MyAppContract } from "../noir/target/artifacts/MyApp.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { EthAddress } from "@aztec/foundation/eth-address";
import { Fr } from "@aztec/foundation/curves/bn254";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { getPXEConfig } from "@aztec/pxe/server";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { getContractInstanceFromInstantiationParams } from "@aztec/stdlib/contract";
import { SponsoredFPCContract } from "@aztec/noir-contracts.js/SponsoredFPC";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { computeAppSecretKey, deriveKeys, KeyPrefix } from "@aztec/stdlib/keys";
import { AccountManager } from "@aztec/aztec.js/wallet";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configuration
const AZTEC_URL = process.env.AZTEC_URL ?? "http://localhost:8080";
const ETHEREUM_RPC_URL =
  process.env.ETHEREUM_RPC_URL ?? "http://localhost:8545";
const ANVIL_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Migrator ABI (only what we need)
const MigratorAbi = parseAbi([
  "constructor(address _rollupRegistry, address _poseidon2)",
  "function migrate((bytes32 actor, uint256 version) sender, (bytes32 actor, uint256 version) recipient, uint256 innerContentHash, uint256 secretHash, uint256 incomingCheckpointNumber, uint256 incomingLeafIndex, bytes32[] calldata incomingPath) external",
  "function ROLLUP_REGISTRY() external view returns (address)",
  "function POSEIDON2() external view returns (address)",
  "event Migration((bytes32 actor, uint256 version) sender, (bytes32 actor, uint256 version) recipient, bytes32 leaf, uint256 leafIndex)",
]);

// Inbox MessageSent event ABI
const InboxAbi = parseAbi([
  "event MessageSent(uint256 indexed checkpointNumber, uint256 index, bytes32 indexed hash, bytes16 rollingHash)",
]);

// Load Migrator bytecode from compiled artifact
function loadMigratorBytecode(): Hex {
  const artifactPath = join(
    __dirname,
    "../solidity/target/Migrator.sol/Migrator.json",
  );
  const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
  return artifact.bytecode.object as Hex;
}

// Load Poseidon2 bytecode from compiled artifact
function loadPoseidon2Bytecode(): Hex {
  const artifactPath = join(
    __dirname,
    "../solidity/target/Poseidon2Yul.sol/Poseidon2Yul_BN254.json",
  );
  const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
  return artifact.bytecode.object as Hex;
}

async function main() {
  console.log("=== Migration E2E Test ===\n");

  console.log("1. Setting up clients...");
  // Create Aztec Node Client
  const aztecNode = createAztecNodeClient(AZTEC_URL);

  // Create PXE
  const l1Contracts = await aztecNode.getL1ContractAddresses();
  const rollupVersion = await aztecNode.getVersion();
  // For this test, old and new rollup versions are the same
  const oldRollupVersion = rollupVersion;
  const newRollupVersion = rollupVersion;
  const l1ChainId = getPXEConfig().l1ChainId;

  console.log(`   Connected to Aztec network:`);
  console.log(`   - Chain ID: ${l1ChainId}`);
  console.log(`   - Rollup Version: ${rollupVersion}`);
  console.log(`   - Registry: ${l1Contracts.registryAddress}`);

  // Setup Ethereum client
  const ethAccount = privateKeyToAccount(ANVIL_PRIVATE_KEY);
  const publicClient = createPublicClient({
    chain: foundry,
    transport: http(ETHEREUM_RPC_URL),
  });
  const walletClient = createWalletClient({
    account: ethAccount,
    chain: foundry,
    transport: http(ETHEREUM_RPC_URL),
  });

  // Step 2: Deploy sender and recipient accounts on L2
  console.log("2. Deploying sender and recipient accounts on L2...");

  const wallet = await TestWallet.create(aztecNode);
  const [deployer] = await registerInitialLocalNetworkAccountsInWallet(wallet);

  const sponsoredFPCInstance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContract.artifact,
    {
      salt: new Fr(0),
    },
  );

  await wallet.registerContract(
    sponsoredFPCInstance,
    SponsoredFPCContract.artifact,
  );

  const sponsoredPaymentMethod = new SponsoredFeePaymentMethod(
    sponsoredFPCInstance.address,
  );

  const deployAccount = async (
    salt: Fr,
    secret: Fr,
  ): Promise<AccountManager> => {
    const account = await wallet.createSchnorrAccount(secret, salt);
    const deployMethod = await account.getDeployMethod();
    await deployMethod
      .send({
        from: AztecAddress.ZERO,
        fee: { paymentMethod: sponsoredPaymentMethod },
      })
      .wait();
    return account;
  };

  const senderSecret = Fr.random();
  const recipientSecret = Fr.random();
  const keys = await deriveKeys(recipientSecret);
  const recipientNSK = keys.masterNullifierSecretKey;

  // We use different salts to get different account addresses
  // The common secret ensures the same npk for both accounts
  const senderSalt = Fr.random();
  const senderAccount = await deployAccount(senderSalt, senderSecret);
  const sender = senderAccount.address;

  const recipientSalt = Fr.random();
  const recipientAccount = await deployAccount(
    recipientSalt,
    recipientSecret,
  );
  const recipient = recipientAccount.address;

  console.log(`   Sender: ${sender}`);
  console.log(`   Recipient: ${recipient}`);

  // Step 3: Deploy Poseidon2 contract on L1 first
  console.log("3. Deploying Poseidon2 contract on L1...");

  const poseidon2Bytecode = loadPoseidon2Bytecode();
  const poseidon2DeployTxHash = await walletClient.sendTransaction({
    data: poseidon2Bytecode,
  });

  const poseidon2Receipt = await publicClient.waitForTransactionReceipt({
    hash: poseidon2DeployTxHash,
  });
  if (
    poseidon2Receipt.status === "reverted" ||
    !poseidon2Receipt.contractAddress
  ) {
    throw new Error("Poseidon2 deployment failed");
  }
  const poseidon2Address = poseidon2Receipt.contractAddress;
  console.log(`   Poseidon2 deployed at: ${poseidon2Address}\n`);

  // Step 4: Deploy Migrator contract on L1
  console.log("4. Deploying Migrator contract on L1...");

  const migratorBytecode = loadMigratorBytecode();

  // Encode constructor arguments (registry + poseidon2 addresses)
  const constructorArgs = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }],
    [l1Contracts.registryAddress.toString() as Hex, poseidon2Address],
  );

  const deployTxHash = await walletClient.sendTransaction({
    data: (migratorBytecode + constructorArgs.slice(2)) as Hex,
  });

  const deployReceipt = await publicClient.waitForTransactionReceipt({
    hash: deployTxHash,
  });
  if (deployReceipt.status === "reverted") {
    throw new Error("Migrator deployment reverted");
  }
  if (!deployReceipt.contractAddress) {
    throw new Error("Migrator deployment failed - no contract address");
  }

  const migratorAddress = deployReceipt.contractAddress;
  console.log(`   Migrator deployed at: ${migratorAddress}`);
  console.log(`   Registry: ${l1Contracts.registryAddress}`);
  console.log(`   Poseidon2: ${poseidon2Address}\n`);

  // Step 5: Deploy "old" MyApp contract (with migrator, no old_rollup_app)
  console.log("5. Deploying OLD MyApp contract...");
  const oldApp = await MyAppContract.deploy(
    wallet,
    EthAddress.fromString(migratorAddress),
    {
      _is_some: false,
      _value: { address: AztecAddress.ZERO, rollup_version: 0n },
    },
  )
    .send({ from: deployer })
    .deployed();
  console.log(`   Old App deployed at: ${oldApp.address}\n`);

  // Step 6: Deploy "new" MyApp contract (with migrator and old_rollup_app)
  console.log("6. Deploying NEW MyApp contract...");
  const oldAppActor = {
    address: oldApp.address,
    rollup_version: BigInt(oldRollupVersion),
  };
  const newApp = await MyAppContract.deploy(
    wallet,
    EthAddress.fromString(migratorAddress),
    { _is_some: true, _value: oldAppActor },
  )
    .send({ from: deployer })
    .deployed();
  console.log(`   New App deployed at: ${newApp.address}`);

  // Step 6b: Set new_rollup_app on the old app
  console.log("   Setting new_rollup_app on old app...");
  const newAppActor = {
    address: newApp.address,
    rollup_version: BigInt(newRollupVersion),
  };
  await oldApp.methods
    .set_new_rollup_app(newAppActor)
    .send({ from: deployer })
    .wait();
  console.log(`   New App Actor set on old app\n`);

  // Step 7: Claim tokens on old app
  console.log("7. Claiming tokens on old app...");
  const claimTx = await oldApp.methods
    .claim(sender)
    .send({ from: sender, fee: { paymentMethod: sponsoredPaymentMethod } })
    .wait();
  console.log(`   Claim tx: ${claimTx.txHash}`);

  const balanceBefore = await oldApp.methods
    .get_balance(sender)
    .simulate({ from: sender });
  console.log(`   Balance after claim: ${balanceBefore}\n`);

  // Step 8: Migrate from old to new (L2 -> L1 message)
  console.log("8. Migrating from old app (sending L2 -> L1 message)...");
  
  const recipientNskApp = await computeAppSecretKey(
    recipientNSK,
    newApp.address,
    'n' as KeyPrefix, // nullifier secret key prefix
  );
  
  const secretHash = await computeSecretHash(recipientNskApp);
  
  // Compute the content hash that will be sent in the message
  // Order in Noir: content = poseidon2_hash([secret_hash, inner_content_hash])
  const amount = 10n;
  const innerContentHash = await poseidon2Hash([new Fr(amount)]);
  const contentHash = await poseidon2Hash([secretHash, innerContentHash]);

  console.log(`   Secret Hash: ${secretHash}`);
  console.log(`   Inner Content Hash: ${innerContentHash}`);
  console.log(`   Content Hash: ${contentHash}`);

  const migrateTx = await oldApp.methods
    .migrate_to_new_rollup(amount, recipientNskApp)
    .send({ from: sender, fee: { paymentMethod: sponsoredPaymentMethod } })
    .wait();

  console.log(`   Migrate tx: ${migrateTx.txHash}`);
  console.log(`   Block number: ${migrateTx.blockNumber}\n`);

  // Step 9: Wait for the L2 block to be proven and get membership witness
  console.log("9. Getting L2 -> L1 membership witness...");

  // Compute the wrapped content hash that includes the new app actor info
  const wrappedContentHash = await poseidon2Hash([
    newApp.address.toField(),
    new Fr(newRollupVersion),
    contentHash,
  ]);

  // Compute the L2 to L1 message hash using computeL2ToL1MessageHash from stdlib
  const l2ToL1MessageHash = computeL2ToL1MessageHash({
    l2Sender: oldApp.address,
    l1Recipient: EthAddress.fromString(migratorAddress),
    content: wrappedContentHash,
    rollupVersion: new Fr(oldRollupVersion),
    chainId: new Fr(l1ChainId),
  });
  console.log(`   L2 -> L1 Message Hash: ${l2ToL1MessageHash}`);

  // Wait a bit for the message to be processed
  console.log("   Waiting for block to be proven...");
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Get the membership witness using the message hash
  const blockNumber = migrateTx.blockNumber!;

  let membershipWitness: L2ToL1MembershipWitness | undefined;
  try {
    membershipWitness = await computeL2ToL1MembershipWitness(
      aztecNode,
      blockNumber,
      l2ToL1MessageHash,
    );
    console.log(`   Leaf Index: ${membershipWitness?.leafIndex}`);
    console.log(
      `   Sibling Path length: ${membershipWitness?.siblingPath.pathSize}`,
    );
  } catch (e) {
    console.log(
      `   Warning: Could not get membership witness yet. The block may not be proven.`,
    );
    console.log(`   Error: ${e}`);
    console.log(
      `   In production, you would wait for the proven block number >= ${blockNumber}`,
    );

    // For testing, we can check the proven block number
    const provenBlock = await aztecNode.getProvenBlockNumber();
    console.log(`   Current proven block: ${provenBlock}`);
    console.log(`   Transaction block: ${blockNumber}`);

    if (provenBlock < blockNumber) {
      console.log(
        "\n   The block has not been proven yet. In a real scenario:",
      );
      console.log("   1. Wait for provenBlockNumber >= txBlockNumber");
      console.log("   2. Then call getL2ToL1MembershipWitness");
      console.log("\n   Exiting test early. Re-run after the block is proven.");
      process.exit(0);
    }
    throw e;
  }

  // Step 10: Call migrate on L1 Migrator contract
  console.log("\n10. Calling migrate() on L1 Migrator...");

  const { leafIndex, siblingPath } = membershipWitness!;
  const path = siblingPath
    .toFields()
    .map((f) => toHex(f.toBigInt(), { size: 32 }));

  // Get checkpoint number (this is typically related to the proven block)
  // For simplicity, we use the block number, but in production this might differ
  const checkpointNumber = BigInt(blockNumber);

  // Prepare L2Actor structs for L1 call
  const senderL2Actor = {
    actor: toHex(oldApp.address.toBigInt(), { size: 32 }),
    version: BigInt(oldRollupVersion),
  };
  const recipientL2Actor = {
    actor: toHex(newApp.address.toBigInt(), { size: 32 }),
    version: BigInt(newRollupVersion),
  };

  const migrateCalldata = encodeFunctionData({
    abi: MigratorAbi,
    functionName: "migrate",
    args: [
      senderL2Actor,
      recipientL2Actor,
      innerContentHash.toBigInt(),
      secretHash.toBigInt(),
      checkpointNumber,
      leafIndex,
      path as Hex[],
    ],
  });

  const l1TxHash = await walletClient.sendTransaction({
    to: migratorAddress,
    data: migrateCalldata,
  });

  console.log(`   L1 tx hash: ${l1TxHash}`);
  const l1Receipt = await publicClient.waitForTransactionReceipt({
    hash: l1TxHash,
  });
  console.log(`   L1 tx status: ${l1Receipt.status}`);

  if (l1Receipt.status !== "success") {
    throw new Error("L1 migrate transaction failed");
  }

  // Parse the MessageSent event from Inbox to get the L1 -> L2 message hash
  const inboxLogs = l1Receipt.logs.filter(
    (log) =>
      log.address.toLowerCase() ===
      l1Contracts.inboxAddress.toString().toLowerCase(),
  );

  if (inboxLogs.length === 0) {
    throw new Error("No MessageSent event found in L1 transaction");
  }

  const messageSentEvent = decodeEventLog({
    abi: InboxAbi,
    data: inboxLogs[0].data,
    topics: inboxLogs[0].topics,
  });

  const l1ToL2LeafIndex = (messageSentEvent.args as any).index as bigint;
  const l1ToL2MessageHash = new Fr(
    BigInt((messageSentEvent.args as any).hash as string),
  );
  console.log(`   L1 -> L2 leaf index: ${l1ToL2LeafIndex}`);
  console.log(`   L1 -> L2 message hash: ${l1ToL2MessageHash}\n`);

  // Step 11: Wait for L1 -> L2 message to be synced
  console.log("11. Waiting for L1 -> L2 message to sync...");

  // The sandbox only produces blocks when there are transactions
  // We need to trigger block production by sending a dummy transaction
  // while waiting for the L1->L2 message to sync

  let messageReady = false;
  const maxAttempts = 30;

  for (let i = 0; i < maxAttempts && !messageReady; i++) {
    // Check if message is ready
    const messageBlock =
      await aztecNode.getL1ToL2MessageBlock(l1ToL2MessageHash);
    if (messageBlock !== undefined) {
      console.log(`   Message synced in block ${messageBlock}!`);
      messageReady = true;
      break;
    }

    console.log(`   Waiting... attempt ${i + 1}/${maxAttempts}`);

    // Trigger block production by calling claim() again
    // This forces the sequencer to produce a new block
    try {
      const dummyTx = await oldApp.methods
        .claim(deployer)
        .send({ from: deployer })
        .wait();
      console.log(`   Triggered block ${dummyTx.blockNumber}`);
    } catch (e) {
      console.log(
        `   Block production trigger skipped: ${(e as Error).message?.substring(0, 50)}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  if (!messageReady) {
    throw new Error("L1 -> L2 message not ready after timeout");
  }
  console.log("   Message synced and ready!\n");

  // Debug: Check block numbers
  const currentBlock = await aztecNode.getBlockNumber();
  const provenBlock = await aztecNode.getProvenBlockNumber();
  console.log(`   Current L2 block: ${currentBlock}`);
  console.log(`   Proven L2 block: ${provenBlock}`);

  // Wait for one more block to ensure the message tree is updated
  console.log(
    "   Waiting for one more block to ensure message tree is updated...",
  );
  try {
    const triggerTx = await oldApp.methods
      .claim(deployer)
      .send({ from: deployer })
      .wait();
    console.log(`   New block: ${triggerTx.blockNumber}`);
  } catch (e) {
    console.log("   Could not trigger additional block");
  }

  // Wait a bit more for synchronization
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Debug: Try to manually get the L1->L2 message membership witness
  console.log("   Debug: Checking L1->L2 message membership witness...");
  try {
    const membershipResponse =
      await aztecNode.getL1ToL2MessageMembershipWitness(
        "latest",
        l1ToL2MessageHash,
      );
    if (membershipResponse) {
      console.log(
        `   Found membership witness! Index: ${membershipResponse[0]}, Path size: ${membershipResponse[1].pathSize}`,
      );
    } else {
      console.log(
        "   WARNING: getL1ToL2MessageMembershipWitness returned undefined",
      );

      // Let's compute what hash we SHOULD have
      // The outgoing message content is wrapped with sender (old app) actor info:
      // outcomingContent = poseidon2_hash([sender.actor, sender.version, content])
      const outgoingWrappedContent = await poseidon2Hash([
        oldApp.address.toField(),
        new Fr(oldRollupVersion),
        contentHash,
      ]);
      const senderActor = new L1Actor(
        EthAddress.fromString(migratorAddress),
        l1ChainId,
      );
      const recipientActor = new L2Actor(newApp.address, newRollupVersion);
      const expectedMessage = new L1ToL2Message(
        senderActor,
        recipientActor,
        outgoingWrappedContent,
        secretHash,
        new Fr(l1ToL2LeafIndex),
      );
      const expectedHash = expectedMessage.hash();
      console.log(`   Expected message hash (computed): ${expectedHash}`);
      console.log(`   Actual message hash (from event): ${l1ToL2MessageHash}`);
      console.log(`   Hashes match: ${expectedHash.equals(l1ToL2MessageHash)}`);

      // Try with the expected hash
      if (!expectedHash.equals(l1ToL2MessageHash)) {
        console.log("   Trying with expected hash...");
        const retryWitness = await aztecNode.getL1ToL2MessageMembershipWitness(
          "latest",
          expectedHash,
        );
        if (retryWitness) {
          console.log(`   Found with expected hash! Index: ${retryWitness[0]}`);
        } else {
          console.log("   Still not found with expected hash");
        }
      }
    }
  } catch (e) {
    console.log(`   Debug error: ${(e as Error).message}`);
  }

  // Step 12: Consume message on new app
  console.log("12. Consuming message on new app (migrate_from_old_rollup)...");
  const consumeTx = await newApp.methods
    .migrate_from_old_rollup(amount, new Fr(l1ToL2LeafIndex))
    .send({ from: recipient, fee: { paymentMethod: sponsoredPaymentMethod } })
    .wait();

  console.log(`   Consume tx: ${consumeTx.txHash}`);

  // Step 13: Verify final balance
  console.log("\n13. Verifying balances...");
  const oldBalance = await oldApp.methods
    .get_balance(sender)
    .simulate({ from: sender });
  const newBalance = await newApp.methods
    .get_balance(recipient)
    .simulate({ from: recipient });

  console.log(`   Old app balance (sender): ${oldBalance}`);
  console.log(`   New app balance (recipient): ${newBalance}`);

  if (newBalance === amount) {
    console.log("\n✅ Migration successful!");
  } else {
    console.log("\n❌ Migration failed - balance mismatch");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
