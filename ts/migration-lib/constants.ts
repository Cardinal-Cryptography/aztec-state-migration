// TODO: Generate these constants from the same source as the Noir

export const MSK_M_GEN = 2137;

export const NSK_MASK_DOMAIN = 1670;

// poseidon2_hash([0x6d6967726174696f6e5f6d6f64655f61]) where input is "migration_mode_a" as ASCII
export const MIGRATION_NOTE_SLOT = 0x28ca34e829f0cda691d3713e01bb3a812dc678348c01617bbe9bd8549bd76edan;

// CLAIM_DOMAIN_A = MIGRATION_NOTE_STORAGE_SLOT
export const CLAIM_DOMAIN_A = MIGRATION_NOTE_SLOT;

// poseidon2_hash([0x6d6967726174696f6e5f6d6f64655f62]) where input is "migration_mode_b" as ASCII
export const CLAIM_DOMAIN_B = 0x18ca708ad6dca829b497a77f901adeefeb108751ceae07b68c22499a1da0e40en;

export const MIGRATION_DATA_FIELD_INDEX = 5;

