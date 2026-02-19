// poseidon2_hash of "migration_mode_a" as ASCII
pub global MIGRATION_MODE_A_STORAGE_SLOT: Field =
    0x28ca34e829f0cda691d3713e01bb3a812dc678348c01617bbe9bd8549bd76eda;

// TODO: use a different domain separator
pub global CLAIM_DOMAIN_A: Field = MIGRATION_MODE_A_STORAGE_SLOT;

// poseidon2_hash of "migration_mode_b" as ASCII
pub global CLAIM_DOMAIN_B: Field =
    0x18ca708ad6dca829b497a77f901adeefeb108751ceae07b68c22499a1da0e40e;

// TODO: use a different domain separator
pub global CLAIM_DOMAIN_B_PUBLIC: Field = 0xdeafbeef;
