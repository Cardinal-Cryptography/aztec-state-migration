import { BlockNumber } from "@aztec/foundation/branded-types";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { NoteDao } from "@aztec/stdlib/note";
import { PrivateEvent } from "@aztec/aztec.js/wallet";
import { MigrationNote, MigrationNoteProofData } from "./types.js";
import { buildNoteProof } from "../index.js";
import { BlockHash } from "@aztec/stdlib/block";

/**
 * Build a {@link MigrationNoteProofData} for a Mode A migration note.
 *
 * Proves inclusion of the {@link MigrationNote} in the note hash tree, then
 * replaces its `data` field with the actual migration data decoded from the
 * corresponding {@link PrivateEvent} (since the note itself only stores a hash).
 *
 * @param node - Aztec node client to query the note hash tree.
 * @param blockReference - Block number or hash at which to prove inclusion.
 * @param noteDao - The migration note DAO to prove.
 * @param migrationData - The decoded migration data for this note.
 * @typeParam T - The shape of the migration data (e.g. `bigint` for token amounts).
 */
export async function buildMigrationNoteProof<T>(
  node: AztecNode,
  blockReference: BlockNumber | BlockHash,
  noteDao: NoteDao,
  migrationData: T,
): Promise<MigrationNoteProofData<T>> {
  const noteProof = await buildNoteProof(
    node,
    blockReference,
    noteDao,
    MigrationNote.fromNote,
  );
  return {
    ...noteProof,
    data: migrationData,
  };
}
