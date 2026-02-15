import type { Fr } from "@aztec/foundation/curves/bn254";
import type { NoteDao, NotesFilter } from "@aztec/stdlib/note";
import type { blockHeaderToNoir } from "./noir-helpers/block-header.js";

/** Minimal interface for a wallet/PXE that can retrieve notes. */
export interface NoteProvider {
  getNotes(filter: NotesFilter): Promise<NoteDao[]>;
}

// ============================================================
// MigrationNote proof (Mode A)
// ============================================================

export interface MigrationNoteProofData {
  migration_data: Fr;
  randomness: Fr;
  nonce: Fr;
  leaf_index: Fr;
  sibling_path: Fr[];
}


// ============================================================
// Note proof (Mode B)
// ============================================================

/** Generic note proof data: inclusion + non-nullification. */
export interface NoteProofData {
  /** Raw note field values from NoteDao.note.items. Caller maps to typed note struct. */
  noteItems: Fr[];
  storage_slot: Fr;
  randomness: Fr;
  nonce: Fr;
  leaf_index: Fr;
  sibling_path: Fr[];
  low_nullifier_value: Fr;
  low_nullifier_next_value: Fr;
  low_nullifier_next_index: Fr;
  low_nullifier_leaf_index: Fr;
  low_nullifier_sibling_path: Fr[];
}

// ============================================================
// Archive proof
// ============================================================

/** Archive membership proof: block header + archive sibling path. */
export interface ArchiveProof {
  archive_block_header: ReturnType<typeof blockHeaderToNoir>;
  archive_leaf_index: Fr;
  archive_sibling_path: Fr[];
}

// ============================================================
// L1 bridge result
// ============================================================

/** Result of calling migrateArchiveRoot on L1. */
export interface L1MigrationResult {
  /** The proven block number from the old rollup. */
  provenBlockNumber: number;
  /** The archive root that was migrated. */
  provenArchiveRoot: Fr;
  /** Leaf index of the L1→L2 message in the Inbox tree. */
  l1ToL2LeafIndex: bigint;
  /** Hash of the L1→L2 message (for polling sync status). */
  l1ToL2MessageHash: Fr;
}
