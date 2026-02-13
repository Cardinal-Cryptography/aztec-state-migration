import type { AztecNode } from "@aztec/aztec.js/node";
import type { AztecAddress } from "@aztec/stdlib/aztec-address";
import type { Fr } from "@aztec/foundation/curves/bn254";
import type { GrumpkinScalar, Point } from "@aztec/aztec.js/fields";
import type { TxHash } from "@aztec/stdlib/tx";
import type { NoteDao, NotesFilter } from "@aztec/stdlib/note";
import type {
  PublicClient,
  WalletClient,
  Hex,
  Chain,
  Transport,
  Account,
} from "viem";
import type { MigratorModeAContract } from "../../noir/target/artifacts/MigratorModeA.js";

/** Minimal interface for a wallet/PXE that can retrieve notes. */
export interface NoteProvider {
  getNotes(filter: NotesFilter): Promise<NoteDao[]>;
}

// ============================================================
// Configuration
// ============================================================

export interface MigrationConfig {
  /** Aztec node client for the OLD rollup. */
  oldNode: AztecNode;

  /** Aztec node client for the NEW rollup. */
  newNode: AztecNode;

  /** Viem public client for reading L1 state. */
  l1PublicClient: PublicClient;

  /** Viem wallet client for writing L1 transactions. */
  l1WalletClient: WalletClient<Transport, Chain, Account>;

  /** Deployed L1 Migrator contract address. */
  l1MigratorAddress: Hex;

  /** Deployed L2 Migrator contract on the NEW rollup. */
  newMigrator: MigratorModeAContract;

  /** Version number of the OLD rollup. */
  oldRollupVersion: number;

  /** Version number of the NEW rollup. */
  newRollupVersion: number;

  /** L1 Inbox contract address for the NEW rollup (for parsing MessageSent events). */
  newInboxAddress: string;
}

// ============================================================
// Phase 1: Lock
// ============================================================

export interface LockArgs {
  /** Rollup version of the destination (new) rollup. */
  destinationRollup: number;

  /** Migration public key in Noir-compatible format. */
  mpk: { x: Fr; y: Fr; is_infinite: boolean };
}

export interface PrepareMigrationNoteLockResult {
  /** Scheme arguments to pass into the app's lock function. */
  lockArgs: LockArgs;

  /**
   * Migration secret key. MUST be persisted by the developer.
   * Required in Phase 3 (prepareMigrate) to prove ownership.
   */
  msk: GrumpkinScalar;

  /** Migration public key (full Point, derivable from msk). */
  mpk: Point;
}

// ============================================================
// Phase 2: Bridge
// ============================================================

export interface BridgeOptions {
  /** The sender address for the register_archive_root call on the new rollup. */
  newRollupSender: AztecAddress;

  /** Max poll attempts waiting for the old rollup to prove the lock block. Default: 60. */
  proofPollMaxAttempts?: number;

  /** Milliseconds between proof poll attempts. Default: 2000. */
  proofPollIntervalMs?: number;

  /** Max poll attempts waiting for L1->L2 message sync. Default: 30. */
  messagePollMaxAttempts?: number;

  /** Milliseconds between message poll attempts. Default: 2000. */
  messagePollIntervalMs?: number;

  /** Callback on each proof poll iteration. Can advance the chain or log progress. */
  onProofPoll?: (currentProvenBlock: number) => Promise<void>;

  /** Callback on each L1->L2 message poll iteration. Can advance the chain or log progress. */
  onMessagePoll?: (attempt: number) => Promise<void>;
}

export interface BridgeResult {
  /** The proven block number from the old rollup. */
  provenBlockNumber: number;

  /** The archive root registered on the new rollup's Migrator. */
  provenArchiveRoot: Fr;

  /** Transaction hash of the register_archive_root call on the new rollup. */
  registerTxHash: TxHash;
}

// ============================================================
// Phase 3: Migrate
// ============================================================

export interface PrepareMigrateModeAInput {
  /** Migration secret key (from PrepareMigrationNoteLockResult.msk). */
  msk: GrumpkinScalar;

  /** Address of the app contract on the old rollup that created the lock note. */
  oldAppAddress: AztecAddress;

  /** The user's wallet/PXE on the old rollup (needs getNotes access). */
  oldUserWallet: NoteProvider;

  /** The owner address on the old rollup (for getNotes query). */
  oldOwner: AztecAddress;

  /** Proven block number from BridgeResult. */
  provenBlockNumber: number;
}

export interface MigrateArgs {
  /** Address of the Migrator contract on the new rollup. */
  migratorAddress: AztecAddress;

  /** MigrationArgs struct — archive proof + msk. */
  migrationArgs: {
    msk: GrumpkinScalar;
    archive_block_header: ReturnType<
      typeof import("./noir-helpers/block-header.js").blockHeaderToNoir
    >;
    archive_leaf_index: Fr;
    archive_sibling_path: Fr[];
  };

  /** FullMigrationNote struct — per-note inclusion proof. */
  fullMigrationNote: {
    migration_data: Fr;
    randomness: Fr;
    nonce: Fr;
    leaf_index: Fr;
    sibling_path: Fr[];
  };
}

export interface PrepareMigrateModeAResult {
  /** Scheme arguments to pass into the app's migrate function. */
  migrateArgs: MigrateArgs;

  /** The migration_data field from the lock note (apps may need this for verification). */
  migrationData: Fr;
}
