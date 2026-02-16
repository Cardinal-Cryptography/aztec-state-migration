import type { Fr } from "@aztec/foundation/curves/bn254";
import type { Note, NoteDao, NotesFilter } from "@aztec/stdlib/note";
import type { blockHeaderToNoir } from "./noir-helpers/block-header.js";
import { Point } from "@aztec/foundation/schemas";

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

/** Helpers for {@link MigrationNoteProofData}. */
export const MigrationNoteProofData = {
  /**
   * Convert a generic {@link NoteProofData} (keyed by a {@link MigrationNote}) into the
   * flattened proof shape expected by the Noir migration verifier.
   *
   * @param p - A note proof whose `note` field is a decoded {@link MigrationNote}.
   * @returns A {@link MigrationNoteProofData} ready to pass into a contract call.
   */
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
export interface ArchiveProofData {
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

/** A note containing a single unsigned integer value (e.g. a balance). */
export type UintNote = {
  value: bigint;
};

/** Helpers for {@link UintNote}. */
export const UintNote = {
  /** Decode a raw {@link Note} into a {@link UintNote} by reading `items[0]` as a bigint. */
  fromNote: (note: Note): UintNote => ({ value: note.items[0].toBigInt() }),
};

/** A note containing a single field element. */
export type FieldNote = {
  value: Fr;
};

/** Helpers for {@link FieldNote}. */
export const FieldNote = {
  /** Decode a raw {@link Note} into a {@link FieldNote} by reading `items[0]`. */
  fromNote: (note: Note): FieldNote => ({ value: note.items[0] }),
};

/** A note storing a migration public key hash (from MigrationKeyRegistry). */
export type KeyNote = {
  mpk: {
    x: Fr;
    y: Fr;
    is_infinite: boolean;
  };
};

/** Helpers for {@link KeyNote}. */
export const KeyNote = {
  /** Decode a raw {@link Note} into a {@link KeyNote} by reading `items[0]` as the `mpk`. */
  fromNote: (note: Note): KeyNote => ({
    mpk: {
      x: note.items[0],
      y: note.items[1],
      is_infinite: note.items[2].toBool(),
    },
  }),
};

/**
 * A Mode A migration note created by `lock_migration_notes_mode_a`.
 * Contains the creator address, migration public key, destination rollup version,
 * and an opaque `migration_data` field carrying the locked value.
 */
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

/** Helpers for {@link MigrationNote}. */
export const MigrationNote = {
  /** Decode a raw {@link Note} into a {@link MigrationNote} by mapping `items[0..5]`. */
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
