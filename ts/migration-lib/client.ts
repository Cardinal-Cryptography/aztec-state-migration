import { GrumpkinScalar } from "@aztec/aztec.js/fields";
import { generatePublicKey } from "@aztec/aztec.js/keys";
import { Fr } from "@aztec/foundation/curves/bn254";
import { BlockNumber } from "@aztec/foundation/branded-types";
import { poseidon2Hash, poseidon2HashWithSeparator } from "@aztec/foundation/crypto/poseidon";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import { GeneratorIndex } from "@aztec/constants";
import { toHex, decodeEventLog, parseAbi } from "viem";

import { blockHeaderToNoir } from "./noir-helpers/block-header.js";
import { pointToNoir } from "./noir-helpers/point.js";
import { poll } from "./polling.js";

import type {
  MigrationConfig,
  PrepareMigrationNoteLockResult,
  BridgeOptions,
  BridgeResult,
  PrepareMigrateModeAInput,
  PrepareMigrateModeAResult,
} from "./types.js";

const L1MigratorAbi = parseAbi([
  "function migrateArchiveRoot(uint256 oldVersion, (bytes32 actor, uint256 version) l2Migrator) external returns (bytes32 leaf, uint256 leafIndex)",
  "function getArchiveInfo(uint256 version) external view returns (bytes32 archiveRoot, uint256 provenCheckpointNumber)",
  "event ArchiveRootMigrated(uint256 indexed oldVersion, uint256 indexed newVersion, bytes32 indexed l2Migrator, bytes32 archiveRoot, uint256 provenCheckpointNumber, bytes32 messageLeaf, uint256 messageLeafIndex)",
]);

const InboxAbi = parseAbi([
  "event MessageSent(uint256 indexed checkpointNumber, uint256 index, bytes32 indexed hash, bytes16 rollingHash)",
]);

/**
 * SDK client for Aztec cross-rollup state migration.
 *
 * Uses the "prepare pattern": methods return scheme-level arguments that the
 * developer composes with app-specific arguments to build contract calls.
 *
 * Mode A Flow:
 *   1. prepareMigrationNoteLock()  → scheme args for the lock call on the old rollup
 *   2. bridge()       → fully orchestrates L1 bridge (proof wait, L1 tx, message sync, registration)
 *   3. prepareMigrateModeA() → scheme args for the migrate call on the new rollup
 */
export class MigrationClient {
  private readonly config: Readonly<MigrationConfig>;

  constructor(config: MigrationConfig) {
    this.config = Object.freeze({ ...config });
  }

  // ================================================================
  // Mode A Phase 1: Lock (old rollup)
  // ================================================================

  /**
   * Generate a migration keypair and prepare scheme arguments for the lock call.
   * Does NOT send any transactions.
   */
  async prepareMigrationNoteLock(msk_m?: GrumpkinScalar): Promise<PrepareMigrationNoteLockResult> {
    const msk = msk_m ?? GrumpkinScalar.random();
    const mpk = await generatePublicKey(msk);

    return {
      lockArgs: {
        destinationRollup: this.config.newRollupVersion,
        mpk: pointToNoir(mpk),
      },
      msk,
      mpk,
    };
  }

  // ================================================================
  // Phase 2: Bridge (L1)
  // ================================================================

  /**
   * Fully orchestrate the L1 bridge phase:
   *   1. Wait for the lock block to be proven on the old rollup
   *   2. Call L1 migrateArchiveRoot
   *   3. Parse ArchiveRootMigrated + MessageSent events
   *   4. Wait for L1->L2 message sync on the new rollup
   *   5. Register archive root on the new rollup's Migrator
   */
  async bridge(
    lockBlockNumber: number,
    options: BridgeOptions,
  ): Promise<BridgeResult> {
    const {
      newRollupSender,
      proofPollMaxAttempts = 60,
      proofPollIntervalMs = 2000,
      messagePollMaxAttempts = 30,
      messagePollIntervalMs = 2000,
      onProofPoll,
      onMessagePoll,
    } = options;

    // 1. Wait for proof
    await poll({
      check: async () => {
        const proven = await this.config.oldNode.getProvenBlockNumber();
        return proven >= lockBlockNumber ? proven : undefined;
      },
      maxAttempts: proofPollMaxAttempts,
      intervalMs: proofPollIntervalMs,
      onPoll: async (attempt) => {
        if (onProofPoll) {
          const current = await this.config.oldNode.getProvenBlockNumber();
          await onProofPoll(current);
        }
      },
      timeoutMessage: `Block ${lockBlockNumber} not proven after ${proofPollMaxAttempts} attempts`,
    });

    // 2. Call L1 migrateArchiveRoot
    const migrateRootsTxHash = await this.config.l1WalletClient.writeContract({
      address: this.config.l1MigratorAddress,
      abi: L1MigratorAbi,
      functionName: "migrateArchiveRoot",
      args: [
        BigInt(this.config.oldRollupVersion),
        {
          actor: toHex(this.config.newMigrator.address.toBigInt(), {
            size: 32,
          }),
          version: BigInt(this.config.newRollupVersion),
        },
      ],
    });
    const receipt = await this.config.l1PublicClient.waitForTransactionReceipt({
      hash: migrateRootsTxHash,
    });

    // 3. Parse ArchiveRootMigrated event
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
      oldVersion: bigint;
      newVersion: bigint;
      l2Migrator: `0x${string}`;
      archiveRoot: `0x${string}`;
      provenCheckpointNumber: bigint;
      messageLeaf: `0x${string}`;
      messageLeafIndex: bigint;
    };

    const provenArchiveRoot = Fr.fromHexString(eventArgs.archiveRoot);
    const provenBlockNumber = Number(eventArgs.provenCheckpointNumber);

    // Parse MessageSent event from Inbox
    const inboxLogs = receipt.logs.filter(
      (log) =>
        log.address.toLowerCase() ===
        this.config.newInboxAddress.toLowerCase(),
    );
    if (inboxLogs.length === 0) {
      throw new Error("No MessageSent event found from Inbox contract");
    }
    const messageSentEvent = decodeEventLog({
      abi: InboxAbi,
      data: inboxLogs[0].data,
      topics: inboxLogs[0].topics,
    });
    const l1ToL2LeafIndex = (
      messageSentEvent.args as { index: bigint }
    ).index;
    const l1ToL2MessageHash = new Fr(
      BigInt((messageSentEvent.args as { hash: `0x${string}` }).hash),
    );

    // 4. Wait for L1->L2 message sync
    await poll({
      check: async () => {
        const block =
          await this.config.newNode.getL1ToL2MessageBlock(l1ToL2MessageHash);
        return block !== undefined ? block : undefined;
      },
      maxAttempts: messagePollMaxAttempts,
      intervalMs: messagePollIntervalMs,
      onPoll: onMessagePoll,
      timeoutMessage: `L1->L2 message not synced after ${messagePollMaxAttempts} attempts`,
    });

    // 5. Register archive root on new Migrator
    const registerTx = await this.config.newMigrator.methods
      .register_archive_root(
        provenArchiveRoot,
        provenBlockNumber,
        Fr.ZERO,
        new Fr(l1ToL2LeafIndex),
      )
      .send({ from: newRollupSender })
      .wait();

    return {
      provenBlockNumber,
      provenArchiveRoot,
      registerTxHash: registerTx.txHash,
    };
  }

  // ================================================================
  // Mode A Phase 3: Migrate (new rollup)
  // ================================================================

  /**
   * Fetch merkle proofs and construct MigrationArgs for the migrate call.
   * Does NOT send any transactions.
   */
  async prepareMigrateModeA(
    input: PrepareMigrateModeAInput,
  ): Promise<PrepareMigrateModeAResult> {
    const {
      msk,
      oldAppAddress,
      oldUserWallet,
      oldOwner,
      provenBlockNumber,
      newRecipient,
      newAppAddress,
    } = input;

    // 1. Get the MigrationNote from the old PXE
    // Notes are emitted by the app contract (migration_lock_mode_a runs in app context)
    // Must match MIGRATION_NOTE_STORAGE_SLOT in migration_mode_a.nr
    // poseidon2_hash([0x6d6967726174696f6e5f6d6f64655f61]) where input is "migration_mode_a" as ASCII
    const MIGRATION_NOTE_SLOT = new Fr(0x28ca34e829f0cda691d3713e01bb3a812dc678348c01617bbe9bd8549bd76edan);
    const lockNotes = await oldUserWallet.getNotes({
      owner: oldOwner,
      contractAddress: oldAppAddress,
      storageSlot: MIGRATION_NOTE_SLOT,
    });
    if (lockNotes.length === 0) {
      throw new Error(
        "No migration notes found in PXE for the specified owner and app",
      );
    }
    const lockNote = lockNotes[0];

    // 2. Use the note's leaf index directly from PXE (NoteDao.index)
    // This is critical: the lock tx creates multiple notes (balance change + migration),
    // so we must use the migration note's specific leaf index, not just the first note hash.
    const lockNoteLeafIndex = lockNote.index;

    // 3. Fetch merkle sibling paths and block header in parallel
    const [noteHashSiblingPath, archiveSiblingPath, blockHeader] =
      await Promise.all([
        this.config.oldNode.getNoteHashSiblingPath(
          BlockNumber(provenBlockNumber),
          lockNoteLeafIndex,
        ),
        this.config.oldNode.getArchiveSiblingPath(
          BlockNumber(provenBlockNumber),
          BigInt(provenBlockNumber),
        ),
        this.config.oldNode.getBlockHeader(BlockNumber(provenBlockNumber)),
      ]);

    if (!blockHeader) {
      throw new Error(
        `Could not get block header for proven block ${provenBlockNumber}`,
      );
    }

    // 4. Extract migration data and derive mpk
    // MigrationNote fields: [note_creator, mpk.x, mpk.y, mpk.is_infinite, destination_rollup, migration_data]
    const migrationData = lockNote.note.items[5];
    const mpk = await generatePublicKey(msk);

    // 5. Compute the migration note hash (must match Noir's compute_note_hash)
    // In the Noir circuit, note_creator = old_app_address, destination_rollup = current_rollup (new)
    const noteHash = await poseidon2HashWithSeparator(
      [
        oldAppAddress,
        mpk.x,
        mpk.y,
        this.config.newRollupVersion,
        migrationData,
        MIGRATION_NOTE_SLOT,
        lockNote.randomness,
      ],
      GeneratorIndex.NOTE_HASH,
    );

    // 6. Build domain-separated message and sign with Schnorr
    // Must match: poseidon2_hash([CLAIM_DOMAIN_A, old_rollup, current_rollup, notes_hash, recipient, new_app_address])
    const notesHash = await poseidon2Hash([noteHash]);
    const oldRollupVersion = new Fr(blockHeader.globalVariables.version);
    const msg = await poseidon2Hash([
      MIGRATION_NOTE_SLOT, // CLAIM_DOMAIN_A = MIGRATION_NOTE_STORAGE_SLOT
      oldRollupVersion,
      new Fr(this.config.newRollupVersion),
      notesHash,
      newRecipient,
      newAppAddress,
    ]);
    const msgBytes = msg.toBuffer(); // 32 bytes big-endian
    const schnorr = new Schnorr();
    const signature = await schnorr.constructSignature(msgBytes, msk);

    // 7. Assemble MigrationArgs + FullMigrationNote
    const migrationArgs = {
      mpk: pointToNoir(mpk),
      signature: [...signature.toBuffer()],
      archive_block_header: blockHeaderToNoir(blockHeader),
      archive_leaf_index: new Fr(BigInt(provenBlockNumber)),
      archive_sibling_path: archiveSiblingPath.toFields(),
    };

    const fullMigrationNote = {
      migration_data: migrationData,
      randomness: lockNote.randomness,
      nonce: lockNote.noteNonce,
      leaf_index: new Fr(lockNoteLeafIndex),
      sibling_path: noteHashSiblingPath.toFields(),
    };

    return {
      migrateArgs: {
        migratorAddress: this.config.newMigrator.address,
        migrationArgs,
        fullMigrationNote,
      },
      migrationData,
    };
  }
}
