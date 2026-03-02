import { Fr } from "@aztec/foundation/curves/bn254";
import { toHex, decodeEventLog, parseAbi } from "viem";
import { poll } from "./polling.js";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { AztecAddress } from "@aztec/stdlib/aztec-address";
import type {
  PublicClient,
  WalletClient,
  Hex,
  Chain,
  Transport,
  Account,
} from "viem";
import type { L1MigrationResult } from "./types.js";
import { BlockNumber } from "@aztec/foundation/branded-types";

const L1MigratorAbi = parseAbi([
  "function migrateArchiveRoot(uint256 oldVersion, (bytes32 actor, uint256 version) l2Migrator) external returns (bytes32 leaf, uint256 leafIndex)",
  "event ArchiveRootMigrated(uint256 indexed oldVersion, uint256 indexed newVersion, bytes32 indexed l2Migrator, bytes32 archiveRoot, uint256 provenBlockNumber, bytes32 messageLeaf, uint256 messageLeafIndex)",
]);

const InboxAbi = parseAbi([
  "event MessageSent(uint256 indexed checkpointNumber, uint256 index, bytes32 indexed hash, bytes16 rollingHash)",
]);

/**
 * Wait for a block to be proven on the old rollup.
 * Returns the current proven block number once it reaches `blockNumber`.
 */
export async function waitForBlockProof(
  aztecNode: AztecNode,
  blockNumber: number,
  opts?: {
    maxAttempts?: number;
    intervalMs?: number;
    onPoll?: (currentProven: number) => Promise<void>;
  },
): Promise<number> {
  const { maxAttempts = 60, intervalMs = 2000, onPoll } = opts ?? {};

  return poll({
    check: async () => {
      const proven = await aztecNode.getProvenBlockNumber();
      return proven >= blockNumber ? proven : undefined;
    },
    maxAttempts,
    intervalMs,
    onPoll,
    timeoutMessage: `Block ${blockNumber} not proven after ${maxAttempts} attempts`,
  });
}

/**
 * Call L1 migrateArchiveRoot and parse ArchiveRootMigrated + MessageSent events.
 * Does NOT wait for the L1→L2 message to sync or register on the new rollup.
 */
export async function migrateArchiveRootOnL1(
  l1WalletClient: WalletClient<Transport, Chain, Account>,
  l1PublicClient: PublicClient,
  params: {
    l1MigratorAddress: Hex;
    oldRollupVersion: number;
    newArchiveRegistryAddress: AztecAddress;
    newRollupVersion: number;
    newInboxAddress: string;
  },
): Promise<L1MigrationResult> {
  // Call L1 migrateArchiveRoot
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

  // Parse ArchiveRootMigrated event
  const archiveRootLog = receipt.logs.find((log) => {
    try {
      const decoded = decodeEventLog({
        abi: L1MigratorAbi,
        data: log.data,
        topics: log.topics,
      });
      return decoded.eventName === "ArchiveRootMigrated";
    } catch {
      return false;
    }
  });
  if (!archiveRootLog) {
    throw new Error(
      "ArchiveRootMigrated event not found in L1 transaction receipt",
    );
  }

  const archiveEvent = decodeEventLog({
    abi: L1MigratorAbi,
    data: archiveRootLog.data,
    topics: archiveRootLog.topics,
  });
  const eventArgs = archiveEvent.args as {
    archiveRoot: `0x${string}`;
    provenBlockNumber: bigint;
  };

  const provenArchiveRoot = Fr.fromHexString(eventArgs.archiveRoot);
  const provenBlockNumber = BlockNumber.fromBigInt(eventArgs.provenBlockNumber);

  // Parse MessageSent event from Inbox
  const inboxLogs = receipt.logs.filter(
    (log) => log.address.toLowerCase() === params.newInboxAddress.toLowerCase(),
  );
  if (inboxLogs.length === 0) {
    throw new Error("No MessageSent event found from Inbox contract");
  }
  const messageSentEvent = decodeEventLog({
    abi: InboxAbi,
    data: inboxLogs[0].data,
    topics: inboxLogs[0].topics,
  });
  const l1ToL2LeafIndex = (messageSentEvent.args as { index: bigint }).index;
  const l1ToL2MessageHash = new Fr(
    BigInt((messageSentEvent.args as { hash: `0x${string}` }).hash),
  );

  return {
    provenBlockNumber,
    provenArchiveRoot,
    l1ToL2LeafIndex,
    l1ToL2MessageHash,
  };
}

/**
 * Wait for an L1→L2 message to be synced on the new rollup.
 */
export async function waitForL1ToL2Message(
  aztecNode: AztecNode,
  messageHash: Fr,
  opts?: {
    maxAttempts?: number;
    intervalMs?: number;
    onPoll?: (attempt: number) => Promise<void>;
  },
): Promise<void> {
  const { maxAttempts = 30, intervalMs = 2000, onPoll } = opts ?? {};

  await poll({
    check: async () => {
      const messageBlock = await aztecNode.getL1ToL2MessageBlock(messageHash);
      if (!messageBlock) {
        return undefined;
      }
      const provenBlockNumber = await aztecNode.getProvenBlockNumber();
      return provenBlockNumber >= messageBlock ? messageBlock : undefined;
    },
    maxAttempts,
    intervalMs,
    onPoll,
    timeoutMessage: `L1->L2 message not synced after ${maxAttempts} attempts`,
  });
}
