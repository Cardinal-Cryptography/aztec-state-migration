import { Fr } from "@aztec/foundation/curves/bn254";
import { BlockNumber } from "@aztec/foundation/branded-types";
import { blockHeaderToNoir } from "./noir-helpers/block-header.js";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { Note, NoteDao } from "@aztec/stdlib/note";
import type { NoteProofData, ArchiveProof, MigrationNoteProofData } from "./types.js";
import { MIGRATION_DATA_FIELD_INDEX } from "./constants.js";

export async function buildMigrationNoteProof(
  node: AztecNode,
  blockNumber: number,
  migrationNote: NoteDao,
): Promise<MigrationNoteProofData> {
  const leafIndex = migrationNote.index;
  const siblingPath = await node.getNoteHashSiblingPath(
    BlockNumber(blockNumber),
    leafIndex,
  );

  return {
    migration_data: migrationNote.note.items[MIGRATION_DATA_FIELD_INDEX],
    randomness: migrationNote.randomness,
    nonce: migrationNote.noteNonce,
    leaf_index: new Fr(migrationNote.index),
    sibling_path: siblingPath.toFields(),
  };
}

/**
 * Build a NoteProofData for a single note: inclusion proof + non-nullification proof.
 */
export async function buildNoteProof<NoteLike>(
  node: AztecNode,
  blockNumber: BlockNumber,
  noteDao: NoteDao,
  noteMapper: (note: Note) => NoteLike,
): Promise<NoteProofData<NoteLike>> {
  const leafIndex = noteDao.index;

  const [siblingPath, lowNullifierWitness] = await Promise.all([
    node.getNoteHashSiblingPath(blockNumber, leafIndex),
    node.getLowNullifierMembershipWitness(
      blockNumber,
      noteDao.siloedNullifier,
    ),
  ]);

  if (!lowNullifierWitness) {
    throw new Error("Could not get low nullifier witness for note");
  }

  return {
    note: noteMapper(noteDao.note),
    storage_slot: noteDao.storageSlot,
    randomness: noteDao.randomness,
    nonce: noteDao.noteNonce,
    leaf_index: new Fr(leafIndex),
    sibling_path: siblingPath.toFields(),
    low_nullifier_value: new Fr(lowNullifierWitness.leafPreimage.getKey()),
    low_nullifier_next_value: new Fr(
      lowNullifierWitness.leafPreimage.getNextKey(),
    ),
    low_nullifier_next_index: new Fr(
      lowNullifierWitness.leafPreimage.getNextIndex(),
    ),
    low_nullifier_leaf_index: new Fr(lowNullifierWitness.index),
    low_nullifier_sibling_path: lowNullifierWitness.siblingPath.toFields(),
  };
}

/**
 * Build an archive membership proof (block header + archive sibling path).
 */
export async function buildArchiveProof(
  node: AztecNode,
  blockNumber: BlockNumber,
): Promise<ArchiveProof> {
  const [archiveSiblingPath, blockHeader] = await Promise.all([
    node.getArchiveSiblingPath(blockNumber, BigInt(blockNumber)),
    node.getBlockHeader(blockNumber),
  ]);

  if (!blockHeader) {
    throw new Error(
      `Could not get block header for proven block ${blockNumber}`,
    );
  }

  return {
    archive_block_header: blockHeaderToNoir(blockHeader),
    archive_leaf_index: new Fr(BigInt(blockNumber)),
    archive_sibling_path: archiveSiblingPath.toFields(),
  };
}
