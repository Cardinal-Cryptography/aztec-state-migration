import { Fr } from "@aztec/foundation/curves/bn254";
import { BlockNumber } from "@aztec/foundation/branded-types";
import { blockHeaderToNoir } from "./noir-helpers/block-header.js";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { Note, NoteDao } from "@aztec/stdlib/note";
import type {
  NoteProofData,
  ArchiveProofData,
  NullifierProofData,
} from "./types.js";

/**
 * Build a {@link NoteProofData} for a single note (note-hash inclusion proof).
 *
 * @param node - Aztec node client to query the note hash tree.
 * @param blockNumber - Block number at which to prove inclusion.
 * @param noteDao - The note DAO to prove.
 * @param noteMapper - Callback that decodes the raw {@link Note} into the desired shape.
 * @returns Proof data containing the decoded note, storage slot, randomness, nonce, and sibling path.
 */
export async function buildNoteProof<NoteLike>(
  node: AztecNode,
  blockNumber: BlockNumber,
  noteDao: NoteDao,
  noteMapper: (note: Note) => NoteLike,
): Promise<NoteProofData<NoteLike>> {
  const leafIndex = noteDao.index;
  const siblingPath = await node.getNoteHashSiblingPath(blockNumber, leafIndex);
  return {
    note: noteMapper(noteDao.note),
    randomness: noteDao.randomness,
    nonce: noteDao.noteNonce,
    leaf_index: new Fr(leafIndex),
    sibling_path: siblingPath.toFields(),
  };
}

/**
 * Build a {@link NullifierProofData} proving that a note has **not** been nullified.
 * Queries the low-nullifier membership witness from the nullifier tree.
 *
 * @param node - Aztec node client to query the nullifier tree.
 * @param blockNumber - Block number at which to prove non-inclusion.
 * @param noteDao - The note DAO whose siloed nullifier is checked.
 * @returns Low-nullifier witness data for the Noir non-inclusion check.
 */
export async function buildNullifierProof(
  node: AztecNode,
  blockNumber: BlockNumber,
  noteDao: NoteDao,
): Promise<NullifierProofData> {
  const lowNullifierWitness = await node.getLowNullifierMembershipWitness(
    blockNumber,
    noteDao.siloedNullifier,
  );
  if (!lowNullifierWitness) {
    throw new Error("Could not get low nullifier witness for note");
  }
  return {
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
 * Build an {@link ArchiveProofData} — a block header together with its archive sibling path.
 * Used to prove that a particular block is part of the old rollup's archive tree.
 *
 * @param node - Aztec node client to query the archive tree and block header.
 * @param blockNumber - The proven block number to build the proof for.
 * @returns Archive proof containing the Noir-encoded block header and Merkle path.
 */
export async function buildArchiveProof(
  node: AztecNode,
  blockNumber: BlockNumber,
): Promise<ArchiveProofData> {
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
