import { ExampleMigrationAppV1Contract } from "./artifacts/ExampleMigrationAppV1.js";
import { ExampleMigrationAppV2Contract } from "./artifacts/ExampleMigrationAppV2.js";
import { TokenMigrationAppV1Contract } from "./artifacts/TokenMigrationAppV1.js";
import { TokenMigrationAppV2Contract } from "./artifacts/TokenMigrationAppV2.js";
import { NftMigrationAppV1Contract } from "./artifacts/NftMigrationAppV1.js";
import { NftMigrationAppV2Contract } from "./artifacts/NftMigrationAppV2.js";
import {
  MigrationArchiveRegistryContract,
  MigrationKeyRegistryContract,
} from "aztec-state-migration/noir-contracts";
import { Fq, Fr } from "@aztec/foundation/curves/bn254";
import { BlockNumber } from "@aztec/foundation/branded-types";
import { EthAddress } from "@aztec/foundation/eth-address";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { buildArchiveProof } from "aztec-state-migration";
import type { ArchiveProofData } from "aztec-state-migration";
import { blockHeaderToNoir } from "aztec-state-migration";
import type { DeploymentResult } from "./deploy-types.js";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { AccountManager } from "@aztec/aztec.js/wallet";
import { AztecNode } from "@aztec/aztec.js/node";
import { FeeJuicePaymentMethodWithClaim } from "@aztec/aztec.js/fee";
import { createLogger } from "@aztec/foundation/log";
import {
  L1FeeJuicePortalManager,
  L2AmountClaim,
} from "@aztec/aztec.js/ethereum";
import { GrumpkinScalar } from "@aztec/aztec.js/fields";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import {
  Account,
  Chain,
  Hex,
  parseAbi,
  PublicClient,
  Transport,
  WalletClient,
  toHex,
  decodeEventLog,
} from "viem";

export async function assertPrivateNftOwnership(
  contract: { methods: { get_private_nfts: (...args: any[]) => any } },
  owner: AztecAddress,
  tokenId: bigint,
  shouldOwn: boolean,
  from: AztecAddress,
) {
  const [nftIds, _hasMore] = await contract.methods
    .get_private_nfts(owner, 0)
    .simulate({ from });
  const owns = nftIds.some((id: bigint) => id === tokenId);
  if (shouldOwn && !owns) {
    throw new Error(`Expected ${owner} to privately own NFT ${tokenId}`);
  }
  if (!shouldOwn && owns) {
    throw new Error(`Expected ${owner} NOT to privately own NFT ${tokenId}`);
  }
}

export async function expectRevert(
  promise: Promise<any>,
  expectedErrorStr?: string,
) {
  let resolvedValue: any;

  try {
    resolvedValue = await promise;
  } catch (e) {
    // Case 1: Promise rejected (e.g. .simulate(), or .send() that throws)
    const err = e as Error;
    if (expectedErrorStr && !err.message.includes(expectedErrorStr)) {
      throw new Error(
        `Expected error to include "${expectedErrorStr}", but got: ${err.message}`,
      );
    }
    console.log(`   Expected failure (thrown): ${err.message.slice(0, 100)}`);
    return;
  }

  // Case 2: .send() returned a TxReceipt with revert status
  if (
    resolvedValue &&
    typeof resolvedValue.hasExecutionReverted === "function" &&
    resolvedValue.hasExecutionReverted()
  ) {
    if (
      expectedErrorStr &&
      resolvedValue.error &&
      !resolvedValue.error.includes(expectedErrorStr)
    ) {
      throw new Error(
        `Expected error to include "${expectedErrorStr}", but got: ${resolvedValue.error}`,
      );
    }
    console.log(
      `   Expected failure (receipt): ${resolvedValue.error?.slice(0, 100) || "reverted"}`,
    );
    return;
  }

  // Case 3: No error at all — test should fail
  throw new Error("Expected transaction to fail, but it succeeded");
}

// ============================================================
// Contract deployment helpers
// ============================================================

/**
 * Deploy ExampleMigrationApp on both old and new rollups.
 * The new app is linked to the old app's address for migration verification.
 */
export async function deployAppPair(
  env: DeploymentResult,
  newArchiveRegistryAddress: AztecAddress,
  oldAppAddress?: AztecAddress,
) {
  const old_r = env[env.oldRollupVersion];
  const new_r = env[env.newRollupVersion];
  const oldApp = await ExampleMigrationAppV1Contract.deploy(
    old_r.deployerWallet,
  ).send({ from: old_r.deployerManager.address });
  const oldAppInstance = (
    await old_r.deployerWallet.getContractMetadata(oldApp.address)
  ).instance;
  old_r.migrationWallet.registerContract(oldAppInstance!, oldApp.artifact);
  old_r.migrationWallet.registerSender(
    old_r.deployerManager.address,
    "old_deployer",
  );

  const effectiveOldAppAddress = oldAppAddress ?? oldApp.address;

  const newApp = await ExampleMigrationAppV2Contract.deploy(
    new_r.deployerWallet,
    newArchiveRegistryAddress,
    effectiveOldAppAddress,
  ).send({ from: new_r.deployerManager.address });

  const newAppInstance = (
    await new_r.deployerWallet.getContractMetadata(newApp.address)
  ).instance;
  new_r.migrationWallet.registerContract(newAppInstance!, newApp.artifact);
  new_r.migrationWallet.registerSender(
    new_r.deployerManager.address,
    "new_deployer",
  );

  return { oldApp, newApp };
}

/**
 * Deploy TokenMigrationApp on both old and new rollups.
 * The new app is linked to the old app's address for migration verification.
 */
export async function deployTokenAppPair(
  env: DeploymentResult,
  newArchiveRegistryAddress: AztecAddress,
  tokenConfig?: {
    name?: string;
    symbol?: string;
    decimals?: number;
    oldAppAddress?: AztecAddress;
  },
) {
  const old_r = env[env.oldRollupVersion];
  const new_r = env[env.newRollupVersion];

  const name = tokenConfig?.name ?? "TestToken";
  const symbol = tokenConfig?.symbol ?? "TST";
  const decimals = tokenConfig?.decimals ?? 18;

  const oldApp = await TokenMigrationAppV1Contract.deploy(
    old_r.deployerWallet,
    name,
    symbol,
    decimals,
    old_r.deployerManager.address,
  ).send({ from: old_r.deployerManager.address });

  const oldAppInstance = (
    await old_r.deployerWallet.getContractMetadata(oldApp.address)
  ).instance;
  old_r.migrationWallet.registerContract(oldAppInstance!, oldApp.artifact);
  old_r.migrationWallet.registerSender(
    old_r.deployerManager.address,
    "old_deployer",
  );

  const effectiveOldAppAddress = tokenConfig?.oldAppAddress ?? oldApp.address;

  const newApp = await TokenMigrationAppV2Contract.deploy(
    new_r.deployerWallet,
    name,
    symbol,
    decimals,
    new_r.deployerManager.address,
    newArchiveRegistryAddress,
    effectiveOldAppAddress,
  ).send({ from: new_r.deployerManager.address });

  const newAppInstance = (
    await new_r.deployerWallet.getContractMetadata(newApp.address)
  ).instance;
  new_r.migrationWallet.registerContract(newAppInstance!, newApp.artifact);
  new_r.migrationWallet.registerSender(
    new_r.deployerManager.address,
    "new_deployer",
  );

  return { oldApp, newApp };
}

/**
 * Deploy NftMigrationApp on both old and new rollups.
 * The new app is linked to the old app's address for migration verification.
 */
export async function deployNftAppPair(
  env: DeploymentResult,
  newArchiveRegistryAddress: AztecAddress,
  oldAppAddress?: AztecAddress,
) {
  const old_r = env[env.oldRollupVersion];
  const new_r = env[env.newRollupVersion];

  const oldApp = await NftMigrationAppV1Contract.deploy(
    old_r.deployerWallet,
    old_r.deployerManager.address,
  ).send({ from: old_r.deployerManager.address });

  const oldAppInstance = (
    await old_r.deployerWallet.getContractMetadata(oldApp.address)
  ).instance;
  old_r.migrationWallet.registerContract(oldAppInstance!, oldApp.artifact);
  old_r.migrationWallet.registerSender(
    old_r.deployerManager.address,
    "old_deployer",
  );

  const effectiveOldAppAddress = oldAppAddress ?? oldApp.address;

  const newApp = await NftMigrationAppV2Contract.deploy(
    new_r.deployerWallet,
    new_r.deployerManager.address,
    newArchiveRegistryAddress,
    effectiveOldAppAddress,
  ).send({ from: new_r.deployerManager.address });

  const newAppInstance = (
    await new_r.deployerWallet.getContractMetadata(newApp.address)
  ).instance;
  new_r.migrationWallet.registerContract(newAppInstance!, newApp.artifact);
  new_r.migrationWallet.registerSender(
    new_r.deployerManager.address,
    "new_deployer",
  );

  return { oldApp, newApp };
}

/**
 * Deploy MigrationArchiveRegistry on the new rollup.
 * Pass `keyRegistryAddress` for Mode B, omit (defaults to ZERO) for Mode A.
 */
export async function deployArchiveRegistry(
  env: DeploymentResult,
  keyRegistryAddress?: AztecAddress,
) {
  const old_r = env[env.oldRollupVersion];
  const new_r = env[env.newRollupVersion];
  const registry = await MigrationArchiveRegistryContract.deploy(
    new_r.deployerWallet,
    EthAddress.fromString(env.l1MigratorAddress),
    env.oldRollupVersion,
    keyRegistryAddress ?? AztecAddress.ZERO,
  ).send({ from: new_r.deployerManager.address });
  const archiveInstance = (
    await new_r.deployerWallet.getContractMetadata(registry.address)
  ).instance;
  new_r.migrationWallet.registerContract(archiveInstance!, registry.artifact);

  return registry;
}

/**
 * Deploy MigrationKeyRegistry on the old rollup (Mode B only).
 */
export async function deployKeyRegistry(env: DeploymentResult) {
  const old_r = env[env.oldRollupVersion];
  const registry = await MigrationKeyRegistryContract.deploy(
    old_r.deployerWallet,
  ).send({ from: old_r.deployerManager.address });

  const keyRegistryInstance = (
    await old_r.deployerWallet.getContractMetadata(registry.address)
  ).instance;
  old_r.migrationWallet.registerContract(
    keyRegistryInstance!,
    registry.artifact,
  );

  return registry;
}

/**
 * Deploy account with fee juice claim. The L1→L2 message may not be available
 * immediately — the sandbox only includes L1→L2 messages when L2 blocks are
 * produced. Uses Deployer wallet and address to deploy this account.
 */
export async function deployAndFundAccount(
  env: DeploymentResult,
  aztecNode: AztecNode,
  accountData?: { secret?: Fr; salt?: Fr; signingKey?: Fq },
): Promise<AccountManager> {
  const rollup = env[await aztecNode.getVersion()];

  const {
    secret = Fr.random(),
    salt = Fr.random(),
    signingKey = Fq.random(),
  } = accountData ?? {};

  const accountManager = await rollup.migrationWallet.createSchnorrAccount(
    secret,
    salt,
    signingKey,
  );

  const claim = await fundAccount(env, aztecNode, accountManager.address);
  await waitForL1ToL2Message(aztecNode, Fr.fromHexString(claim.messageHash), {
    onPoll: async () => {
      await produceBlock(env, aztecNode);
    },
    intervalMs: 10,
  });
  const deployMethod = await accountManager.getDeployMethod();
  await deployMethod.send({
    from: AztecAddress.ZERO,
    fee: {
      paymentMethod: new FeeJuicePaymentMethodWithClaim(
        accountManager.address,
        claim,
      ),
    },
  });
  return accountManager;
}

// ============================================================
// Bridge helpers
// ============================================================

export interface BridgeResult {
  provenBlockNumber: BlockNumber;
  provenArchiveRoot: Fr;
  archiveProof: ArchiveProofData;
  /** Noir-encoded block header for migration calls (no sibling path). */
  blockHeader: ReturnType<typeof blockHeaderToNoir>;
}

// ============================================================
// L1 ABIs (exported for event parsing in tests)
// ============================================================
export const L1MigratorAbi = parseAbi([
  "constructor(address _registry, address _poseidon2)",
  "function migrateArchiveRoot(uint256 oldVersion, (bytes32 actor, uint256 version) l2Migrator) external returns (bytes32 leaf, uint256 leafIndex)",
  "function getArchiveInfo(uint256 version) external view returns (bytes32 archiveRoot, uint256 provenBlockNumber)",
  "function REGISTRY() external view returns (address)",
  "function POSEIDON2() external view returns (address)",
  "function SECRET_HASH_FOR_ZERO() external view returns (bytes32)",
  "event ArchiveRootMigrated(uint256 indexed oldVersion, uint256 indexed newVersion, bytes32 indexed l2Migrator, bytes32 archiveRoot, uint256 provenBlockNumber, bytes32 messageLeaf, uint256 messageLeafIndex)",
]);

export const InboxAbi = parseAbi([
  "event MessageSent(uint256 indexed checkpointNumber, uint256 index, bytes32 indexed hash, bytes16 rollingHash)",
]);

/**
 * Full bridge sequence: wait for proof → L1 migrate → wait for L1→L2 message → register block on new rollup.
 */
export async function bridgeBlock(
  env: DeploymentResult,
  archiveRegistry: MigrationArchiveRegistryContract,
): Promise<BridgeResult> {
  const old_r = env[env.oldRollupVersion];
  const new_r = env[env.newRollupVersion];
  const blockNumber = await old_r.aztecNode.getBlockNumber();
  const onPoll = () => produceBlock(env, new_r.aztecNode);

  // Step 1: Wait for block proof
  await waitUntil(
    async () => {
      const proven = await old_r.aztecNode.getProvenBlockNumber();
      return proven >= blockNumber ? proven : undefined;
    },
    { intervalMs: 100, onPoll },
  );

  // Step 2: L1 migrateArchiveRoot
  const l1 = await migrateArchiveRootOnL1(
    env.l1WalletClient,
    env.publicClient,
    {
      l1MigratorAddress: env.l1MigratorAddress,
      oldRollupVersion: env.oldRollupVersion,
      newArchiveRegistryAddress: archiveRegistry.address,
      newRollupVersion: env.newRollupVersion,
      newInboxAddress: new_r.inboxAddress,
    },
  );

  // Step 3: Wait for L1→L2 message
  await waitForL1ToL2Message(new_r.aztecNode, l1.l1ToL2MessageHash, {
    intervalMs: 10,
    onPoll,
  });

  const provenBlockNumber = BlockNumber(l1.provenBlockNumber);

  const blockHeader = await old_r.aztecNode.getBlockHeader(provenBlockNumber);
  if (!blockHeader) {
    throw new Error(
      `Could not fetch block header for block ${provenBlockNumber}`,
    );
  }
  const blockHash = await blockHeader.hash();
  const archiveProof = await buildArchiveProof(old_r.aztecNode, blockHash);

  // Step 4a: Consume L1-to-L2 message (stores trusted archive root)
  await archiveRegistry.methods
    .consume_l1_to_l2_message(
      l1.provenArchiveRoot,
      l1.provenBlockNumber,
      Fr.ZERO,
      new Fr(l1.l1ToL2LeafIndex),
    )
    .send({ from: new_r.deployerManager.address });

  // Step 4b: Register block (verifies block header against stored archive root)
  await archiveRegistry.methods
    .register_block(
      l1.provenBlockNumber,
      archiveProof.archive_block_header,
      archiveProof.archive_sibling_path,
    )
    .send({ from: new_r.deployerManager.address });

  return {
    provenBlockNumber,
    provenArchiveRoot: l1.provenArchiveRoot,
    archiveProof,
    blockHeader: archiveProof.archive_block_header,
  };
}

async function migrateArchiveRootOnL1(
  l1WalletClient: WalletClient<Transport, Chain, Account>,
  l1PublicClient: PublicClient,
  params: {
    l1MigratorAddress: Hex;
    oldRollupVersion: number;
    newArchiveRegistryAddress: AztecAddress;
    newRollupVersion: number;
    newInboxAddress: string;
  },
) {
  const txHash = await l1WalletClient.writeContract({
    address: params.l1MigratorAddress,
    abi: L1MigratorAbi,
    functionName: "migrateArchiveRoot",
    args: [
      BigInt(params.oldRollupVersion),
      {
        actor: toHex(params.newArchiveRegistryAddress.toBigInt(), { size: 32 }),
        version: BigInt(params.newRollupVersion),
      },
    ],
  });
  const receipt = await l1PublicClient.waitForTransactionReceipt({
    hash: txHash,
  });

  const archiveArgs = findEvent(
    receipt.logs,
    L1MigratorAbi,
    "ArchiveRootMigrated",
  ) as {
    archiveRoot: `0x${string}`;
    provenBlockNumber: bigint;
  };
  const msgArgs = findEvent(
    receipt.logs,
    InboxAbi,
    "MessageSent",
    params.newInboxAddress,
  ) as {
    index: bigint;
    hash: `0x${string}`;
  };

  return {
    provenBlockNumber: BlockNumber.fromBigInt(archiveArgs.provenBlockNumber),
    provenArchiveRoot: Fr.fromHexString(archiveArgs.archiveRoot),
    l1ToL2LeafIndex: msgArgs.index,
    l1ToL2MessageHash: new Fr(BigInt(msgArgs.hash)),
  };
}

// ============================================================
// Other helpers
// ============================================================

export function assertEq(actual: any, expected: any, msg: string) {
  const fmt = (v: any) =>
    typeof v === "object"
      ? JSON.stringify(
          v,
          (_k, val) => (typeof val === "bigint" ? val.toString() : val),
          2,
        )
      : String(v);
  if (actual !== expected && fmt(actual) !== fmt(expected)) {
    throw new Error(
      `Mismatch: ${msg}\n  Expected: ${fmt(expected)}\n  Actual:   ${fmt(actual)}`,
    );
  }
}

async function fundAccount(
  env: DeploymentResult,
  node: AztecNode,
  to: AztecAddress,
): Promise<L2AmountClaim> {
  const logger = createLogger("deploy");
  const portal = await L1FeeJuicePortalManager.new(
    node,
    env.l1ExtendedClient,
    logger,
  );
  const oldPortal = await L1FeeJuicePortalManager.new(
    env[env.oldRollupVersion].aztecNode,
    env.l1ExtendedClient,
    logger,
  );
  const mintAmount = await oldPortal.getTokenManager().getMintAmount();
  await oldPortal.getTokenManager().mint(env.l1ExtendedClient.account.address);
  return await portal.bridgeTokensPublic(to, mintAmount, false);
}

async function produceBlock(env: DeploymentResult, aztecNode: AztecNode) {
  const rollup = env[await aztecNode.getVersion()];

  const wallet = await EmbeddedWallet.create(aztecNode, { ephemeral: true });
  const accountsData = await getInitialTestAccountsData();
  await wallet.createSchnorrAccount(
    accountsData[0].secret,
    accountsData[0].salt,
    accountsData[0].signingKey,
  );

  const accountManager = await wallet.createSchnorrAccount(
    Fr.random(),
    Fr.random(),
    GrumpkinScalar.random(),
  );
  const deployMethod = await accountManager.getDeployMethod();
  await deployMethod.send({ from: rollup.deployerManager.address });
}

async function waitForL1ToL2Message(
  aztecNode: AztecNode,
  messageHash: Fr,
  opts?: {
    maxAttempts?: number;
    intervalMs?: number;
    onPoll?: () => Promise<void>;
  },
): Promise<void> {
  await waitUntil(
    async () => {
      const messageBlock = await aztecNode.getL1ToL2MessageBlock(messageHash);
      if (!messageBlock) return undefined;
      const proven = await aztecNode.getProvenBlockNumber();
      return proven >= messageBlock ? messageBlock : undefined;
    },
    {
      maxAttempts: opts?.maxAttempts ?? 30,
      intervalMs: opts?.intervalMs ?? 2000,
      onPoll: opts?.onPoll,
    },
  );
}

async function waitUntil<T>(
  check: () => Promise<T | undefined>,
  {
    maxAttempts = 60,
    intervalMs = 2000,
    onPoll,
  }: {
    maxAttempts?: number;
    intervalMs?: number;
    onPoll?: () => Promise<void>;
  } = {},
): Promise<T> {
  for (let i = 1; i <= maxAttempts; i++) {
    const result = await check();
    if (result !== undefined) return result;
    if (onPoll) await onPoll();
    if (i < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(`waitUntil timed out after ${maxAttempts} attempts`);
}

function findEvent<TAbi extends readonly unknown[]>(
  logs: {
    data: `0x${string}`;
    topics: [`0x${string}`, ...`0x${string}`[]] | [];
    address: string;
  }[],
  abi: TAbi,
  eventName: string,
  filterAddress?: string,
) {
  const filtered = filterAddress
    ? logs.filter(
        (l) => l.address.toLowerCase() === filterAddress.toLowerCase(),
      )
    : logs;
  for (const log of filtered) {
    try {
      const decoded = decodeEventLog({
        abi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === eventName) return decoded.args;
    } catch {
      /* not this event */
    }
  }
  throw new Error(`Event "${eventName}" not found in logs`);
}
