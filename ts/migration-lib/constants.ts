// TODO: Generate these constants from the same source as the Noir

/** Domain separator used to derive the master migration secret key via `sha512ToGrumpkinScalar`. */
export const MSK_M_GEN = 2137;

/** Domain separator for masking the nullifier secret key during cross-rollup migration. */
export const NSK_MASK_DOMAIN = 1670;

/**
 * Storage slot for migration notes on the old rollup.
 * Computed as `poseidon2_hash([0x6d6967726174696f6e5f6d6f64655f61])` ("migration_mode_a" in ASCII).
 */
export const MIGRATION_NOTE_SLOT =
  0x28ca34e829f0cda691d3713e01bb3a812dc678348c01617bbe9bd8549bd76edan;

/**
 * Domain separator for Mode A (cooperative lock-and-migrate) claim signatures.
 * Equal to {@link MIGRATION_NOTE_SLOT}.
 */
export const CLAIM_DOMAIN_A = MIGRATION_NOTE_SLOT;

/**
 * Domain separator for Mode B (emergency snapshot) claim signatures.
 * Computed as `poseidon2_hash([0x6d6967726174696f6e5f6d6f64655f62])` ("migration_mode_b" in ASCII).
 */
export const CLAIM_DOMAIN_B =
  0x18ca708ad6dca829b497a77f901adeefeb108751ceae07b68c22499a1da0e40en;

/** Zero-based index of the `migration_data` field inside a `MigrationNote`. */
export const MIGRATION_DATA_FIELD_INDEX = 5;
