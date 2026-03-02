import { Fr } from "@aztec/foundation/curves/bn254";
import { BlockNumber } from "@aztec/foundation/branded-types";
import { blockHeaderToNoir } from "./noir-helpers/block-header.js";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { Note, NoteDao } from "@aztec/stdlib/note";
import { siloNoteHash, computeUniqueNoteHash } from "@aztec/stdlib/hash";
import { type NoteProofData, type ArchiveProofData } from "./types.js";
import { BlockHash } from "@aztec/stdlib/block";

/**
 * Build a {@link NoteProofData} for a single note (note-hash inclusion proof).
 *
 * @param node - Aztec node client to query the note hash tree.
 * @param referenceBlock - Block number at which to prove inclusion.
 * @param noteDao - The note DAO to prove.
 * @param noteMapper - Callback that decodes the raw {@link Note} into the desired shape.
 * @returns Proof data containing the decoded note, storage slot, randomness, nonce, and sibling path.
 */
export async function buildNoteProof<NoteLike>(
  node: AztecNode,
  referenceBlock: BlockNumber | BlockHash,
  noteDao: NoteDao,
  noteMapper: (note: Note) => NoteLike,
): Promise<NoteProofData<NoteLike>> {
  const siloedHash = await siloNoteHash(
    noteDao.contractAddress,
    noteDao.noteHash,
  );
  const uniqueHash = await computeUniqueNoteHash(noteDao.noteNonce, siloedHash);
  const witness = await node.getNoteHashMembershipWitness(
    referenceBlock,
    uniqueHash,
  );
  if (!witness) {
    throw new Error(
      `Could not get note hash membership witness for note ${noteDao.noteHash.toString()}`,
    );
  }
  return {
    data: noteMapper(noteDao.note),
    randomness: noteDao.randomness,
    nonce: noteDao.noteNonce,
    leaf_index: new Fr(witness.leafIndex),
    sibling_path: witness.siblingPath,
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
  blockHash: BlockHash,
): Promise<ArchiveProofData> {
  const [witness, blockHeader] = await Promise.all([
    node.getBlockHashMembershipWitness(blockHash, blockHash),
    node.getBlockHeader(blockHash),
  ]);

  if (!blockHeader) {
    throw new Error(
      `Could not get block header for proven block ${blockHash.toString()}`,
    );
  }

  if (!witness) {
    throw new Error(
      `Could not get archive sibling path for proven block ${blockHash.toString()}`,
    );
  }

  return {
    archive_block_header: blockHeaderToNoir(blockHeader),
    archive_sibling_path: witness.siblingPath,
  };
}

/**
 * Build a Noir-encoded block header for migration calls.
 * Unlike {@link buildArchiveProof}, this does NOT include the archive sibling path
 * since migration circuits no longer need it.
 *
 * @param node - Aztec node client to query the block header.
 * @param blockReference - The block number or block hash to get the header for.
 * @returns Noir-encoded block header.
 */
export async function buildBlockHeader(
  node: AztecNode,
  blockReference: BlockNumber | BlockHash,
) {
  const blockHeader = await node.getBlockHeader(blockReference);
  if (!blockHeader) {
    throw new Error(
      `Could not get block header for block ${blockReference.toString()}`,
    );
  }
  return blockHeaderToNoir(blockHeader);
}
