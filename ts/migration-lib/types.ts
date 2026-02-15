import type { Fr } from "@aztec/foundation/curves/bn254";
import type { Note, NoteDao, NotesFilter } from "@aztec/stdlib/note";
import type { blockHeaderToNoir } from "./noir-helpers/block-header.js";

/** Minimal interface for a wallet/PXE that can retrieve notes. */
export interface NoteProvider {
  getNotes(filter: NotesFilter): Promise<NoteDao[]>;
}

/** Generic note inclusion proof data. */
export interface NoteProofData<Note> {
  note: Note;
  storage_slot: Fr;
  randomness: Fr;
  nonce: Fr;
  leaf_index: Fr;
  sibling_path: Fr[];
}

/** Nullifier non-inclusion proof data. */
export interface NullifierProofData {
  low_nullifier_value: Fr;
  low_nullifier_next_value: Fr;
  low_nullifier_next_index: Fr;
  low_nullifier_leaf_index: Fr;
  low_nullifier_sibling_path: Fr[];
}

/** Note inclusion and nullifier non-inclusion proof data. */
export type FullProofData<Note> = NoteProofData<Note> & NullifierProofData;

/** Migration note proof data (for migration verification). */
export interface MigrationNoteProofData {
  migration_data: Fr;
  randomness: Fr;
  nonce: Fr;
  leaf_index: Fr;
  sibling_path: Fr[];
}

export const MigrationNoteProofData = {
  fromNoteProofData: (
    p: NoteProofData<MigrationNote>,
  ): MigrationNoteProofData => ({
    migration_data: p.note.migration_data,
    randomness: p.randomness,
    nonce: p.nonce,
    leaf_index: p.leaf_index,
    sibling_path: p.sibling_path,
  }),
};

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

// ============================================================
// Types of common notes
// ============================================================

export type UintNote = {
  value: bigint;
};

export const UintNote = {
  fromNote: (note: Note): UintNote => ({ value: note.items[0].toBigInt() }),
};

export type FieldNote = {
  value: Fr;
};

export const FieldNote = {
  fromNote: (note: Note): FieldNote => ({ value: note.items[0] }),
};

export type KeyNote = {
  mpk_hash: Fr;
};

export const KeyNote = {
  fromNote: (note: Note): KeyNote => ({ mpk_hash: note.items[0] }),
};

export type MigrationNote = {
  note_creator: {
    address: Fr;
  };
  mpk: {
    x: Fr;
    y: Fr;
    is_inifinite: boolean;
  };
  destination_rollup: Fr;
  migration_data: Fr;
};

export const MigrationNote = {
  fromNote: (note: Note): MigrationNote => ({
    note_creator: {
      address: note.items[0],
    },
    mpk: {
      x: note.items[1],
      y: note.items[2],
      is_inifinite: note.items[3].toBool(),
    },
    destination_rollup: note.items[4],
    migration_data: note.items[5],
  }),
};
