import type { Fr } from "@aztec/foundation/curves/bn254";
import type { Note } from "@aztec/stdlib/note";

// ============================================================
// Types of common notes
// ============================================================

/** A note containing a single unsigned integer value (e.g. a balance). */
export interface UintNote {
  value: bigint;
}

/** Helpers for {@link UintNote}. */
export const UintNote = {
  /** Decode a raw {@link Note} into a {@link UintNote} by reading `items[0]` as a bigint. */
  fromNote(note: Note): UintNote {
    return { value: note.items[0].toBigInt() };
  },
};

/** A note containing a single field element. */
export interface FieldNote {
  value: Fr;
}

/** Helpers for {@link FieldNote}. */
export const FieldNote = {
  /** Decode a raw {@link Note} into a {@link FieldNote} by reading `items[0]`. */
  fromNote: (note: Note): FieldNote => ({ value: note.items[0] }),
};

/** A note containing a single token ID field (e.g., an NFT ownership note). */
export interface NFTNote {
  token_id: Fr;
}

/** Helpers for {@link NFTNote}. */
export const NFTNote = {
  /** Decode a raw {@link Note} into an {@link NFTNote} by reading `items[0]` as a Field. */
  fromNote(note: Note): NFTNote {
    return { token_id: note.items[0] };
  },
};
