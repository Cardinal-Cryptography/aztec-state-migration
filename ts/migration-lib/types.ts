import type { Fr } from "@aztec/foundation/curves/bn254";
import type { blockHeaderToNoir } from "./noir-helpers/block-header.js";
import { SchnorrSignature } from "@aztec/foundation/crypto/schnorr";

/** Generic note inclusion proof data. */
export interface NoteProofData<Note> {
  data: Note;
  randomness: Fr;
  nonce: Fr;
  leaf_index: Fr;
  sibling_path: Fr[];
}

// ============================================================
// Archive proof
// ============================================================

/** Archive membership proof: block header + archive sibling path. */
export interface ArchiveProofData {
  archive_block_header: ReturnType<typeof blockHeaderToNoir>;
  archive_sibling_path: Fr[];
}

// ============================================================
// Migration Signature
// ============================================================

/** Represents a migration signature. */
export interface MigrationSignature {
  bytes: (number | bigint)[];
}

export const MigrationSignature = {
  fromBuffer: (buf: Buffer): MigrationSignature => ({
    bytes: [...buf],
  }),
  fromSchnorrSignature: (sig: SchnorrSignature): MigrationSignature => ({
    bytes: [...sig.toBuffer()],
  }),
};

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
