import { Fr } from "@aztec/foundation/curves/bn254";

/**
 * The migration note storage slot.
 * poseidon2_hash of "migration-note-storage-slot" as ASCII
 */
export const MIGRATION_NOTE_STORAGE_SLOT = Fr.fromHexString(
  "0x0294c128d5f7b0748fae26c425756ea918f5dd12d0290b9b7122b906f223d0a0",
);

/**
 * Domain separator for the cooperative lock-and-migrate claim.
 * poseidon2_hash of "claim-a" as ASCII
 */
export const DOM_SEP__CLAIM_A = Fr.fromHexString(
  "0x1c1a039006ce83af29c6be17585398f89fa06534bcc02b27ceb022d1c8bbcc97",
);

/**
 * Domain separator for the emergency snapshot migration claim.
 * poseidon2_hash of "claim-b" as ASCII
 */
export const DOM_SEP__CLAIM_B = Fr.fromHexString(
  "0x03f16d1bba391bbe5f63cbc632fd523eed5b257a45c8a52f467a20802a6ef1b9",
);

/**
 * Domain separator for the public state migration claim.
 * poseidon2_hash of "claim-b-public" as ASCII
 */
export const DOM_SEP__CLAIM_B_PUBLIC = Fr.fromHexString(
  "0x0ebf03b524ab55cfc8880ef828a1c08a5b1d2ab56b6d55c9dd5311499b673e8f",
);

/**
 * Domain separator for the public state migration nullifier.
 * poseidon2_hash of "public-migration-nullifier" as ASCII
 */
export const DOM_SEP__PUBLIC_MIGRATION_NULLIFIER = Fr.fromHexString(
  "0x2c8f77defafd390c3bca3a011ea9631b85664689f69554383079978aa2fdfb40",
);

/**
 * Domain separator used to derive the master migration secret key via `sha512ToGrumpkinScalar`.
 * poseidon2_hash of "migration-secret-key" as ASCII
 */
export const DOM_SEP__MSK_M_GEN = Fr.fromHexString(
  "0x2f92f9f19f1d3ffbe610b6bfc1c4a8103ed9cea7748cda0c6b248eb7ba25f962",
);
