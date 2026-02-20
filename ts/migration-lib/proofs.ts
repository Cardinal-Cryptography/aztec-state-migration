import { Fr } from "@aztec/foundation/curves/bn254";
import { BlockNumber } from "@aztec/foundation/branded-types";
import { blockHeaderToNoir } from "./noir-helpers/block-header.js";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { Note, NoteDao } from "@aztec/stdlib/note";
import { type NoteProofData, type ArchiveProofData } from "./types.js";

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
    data: noteMapper(noteDao.note),
    randomness: noteDao.randomness,
    nonce: noteDao.noteNonce,
    leaf_index: new Fr(leafIndex),
    sibling_path: siblingPath.toFields(),
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
    archive_sibling_path: archiveSiblingPath.toFields(),
  };
}

/**
 * Build a Noir-encoded block header for migration calls.
 * Unlike {@link buildArchiveProof}, this does NOT include the archive sibling path
 * since migration circuits no longer need it.
 *
 * @param node - Aztec node client to query the block header.
 * @param blockNumber - The block number to get the header for.
 * @returns Noir-encoded block header.
 */
export async function buildBlockHeader(
  node: AztecNode,
  blockNumber: BlockNumber,
) {
  const blockHeader = await node.getBlockHeader(blockNumber);
  if (!blockHeader) {
    throw new Error(`Could not get block header for block ${blockNumber}`);
  }
  return blockHeaderToNoir(blockHeader);
}
