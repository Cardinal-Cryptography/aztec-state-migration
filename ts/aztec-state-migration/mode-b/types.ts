import { type Fr } from "@aztec/foundation/curves/bn254";
import { NoteProofData } from "../types.js";
import { Note } from "@aztec/stdlib/note";

// ============================================================
// Note migration
// ============================================================

/** Nullifier non-inclusion proof data. */
export interface NonNullificationProofData {
  low_nullifier_value: Fr;
  low_nullifier_next_value: Fr;
  low_nullifier_next_index: Fr;
  low_nullifier_leaf_index: Fr;
  low_nullifier_sibling_path: Fr[];
}

/** Note inclusion and nullifier non-inclusion proof data. */
export interface FullProofData<Note> {
  note_proof_data: NoteProofData<Note>;
  non_nullification_proof_data: NonNullificationProofData;
}

// ============================================================
// Key note
// ============================================================

/** A note storing a migration public key hash (from MigrationKeyRegistry). */
export interface KeyNote {
  mpk: {
    x: Fr;
    y: Fr;
    is_infinite: boolean;
  };
}

/** Helpers for {@link KeyNote}. */
// eslint-disable-next-line @typescript-eslint/no-redeclare
export const KeyNote = {
  /** Decode a raw {@link Note} into a {@link KeyNote} by reading `items[0]` as the `mpk`. */
  fromNote(note: Note): KeyNote {
    return {
      mpk: {
        x: note.items[0],
        y: note.items[1],
        is_infinite: note.items[2].toBool(),
      },
    };
  },
};

// ============================================================
// Public data migration
// ============================================================

/**
 * Membership proof for a single public data tree leaf (one storage slot).
 *
 * Maps directly to the Noir `PublicDataSlotProof` struct consumed by
 * `migrate_public_state_mode_b` and friends.
 */
export interface PublicDataSlotProof {
  next_slot: Fr;
  next_index: Fr;
  leaf_index: Fr;
  sibling_path: Fr[];
}

/**
 * Public state proof bundle: the data value together with a slot proof for
 * each of its packed fields.
 *
 * Maps to Noir's `PublicStateProofData<T, N>` where `N = slot_proof_data.length`.
 *
 * @typeParam T - The TypeScript shape of the public state value (e.g. `SomeStruct`).
 */
export interface PublicDataProof<T> {
  data: T;
  slot_proof_data: PublicDataSlotProof[];
}
