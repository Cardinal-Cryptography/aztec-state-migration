import type { Fr } from "@aztec/foundation/curves/bn254";
import type { NoteProofData } from "../types.js";
import type { Note, NoteDao } from "@aztec/stdlib/note";

/** MigrationNote proof data with generic migration data. */
export type MigrationNoteProofData<T> = NoteProofData<T>;

/**
 * A Mode A migration note created by `lock_migration_notes_mode_a`.
 * Contains the creator address, migration public key, destination rollup version,
 * and an opaque `migration_data` field carrying the locked value.
 */
export interface MigrationNote {
  note_creator: {
    address: Fr;
  };
  mpk: {
    x: Fr;
    y: Fr;
    is_infinite: boolean;
  };
  destination_rollup: Fr;
  migration_data_hash: Fr;
}

/** Helpers for {@link MigrationNote}. */
// eslint-disable-next-line @typescript-eslint/no-redeclare
export const MigrationNote = {
  /** Decode a raw {@link Note} into a {@link MigrationNote} by mapping `items[0..5]`. */
  fromNote(note: Note): MigrationNote {
    return {
      note_creator: {
        address: note.items[0],
      },
      mpk: {
        x: note.items[1],
        y: note.items[2],
        is_infinite: note.items[3].toBool(),
      },
      destination_rollup: note.items[4],
      migration_data_hash: note.items[5],
    };
  },
};

/** A Mode A migration note paired with its decoded migration data. */
export interface MigrationNoteAndData<T> {
  note: NoteDao;
  dataId: number;
  data: T;
}
