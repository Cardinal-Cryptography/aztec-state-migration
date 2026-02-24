use aztec::protocol::hash::poseidon2_hash;

// poseidon2_hash of "migration-note-storage-slot" as ASCII
pub global MIGRATION_NOTE_STORAGE_SLOT: Field =
    0x0294c128d5f7b0748fae26c425756ea918f5dd12d0290b9b7122b906f223d0a0;

// poseidon2_hash of "claim-a" as ASCII
pub global DOM_SEP__CLAIM_A: Field =
    0x1c1a039006ce83af29c6be17585398f89fa06534bcc02b27ceb022d1c8bbcc97;

// poseidon2_hash of "claim-b" as ASCII
pub global DOM_SEP__CLAIM_B: Field =
    0x03f16d1bba391bbe5f63cbc632fd523eed5b257a45c8a52f467a20802a6ef1b9;

// poseidon2_hash of "claim-b-public" as ASCII
pub global DOM_SEP__CLAIM_B_PUBLIC: Field =
    0x0ebf03b524ab55cfc8880ef828a1c08a5b1d2ab56b6d55c9dd5311499b673e8f;

// poseidon2_hash of "public-migration-nullifier" as ASCII
pub global DOM_SEP__PUBLIC_MIGRATION_NULLIFIER: Field =
    0x2c8f77defafd390c3bca3a011ea9631b85664689f69554383079978aa2fdfb40;

fn str_to_fields<let N: u32>(s: str<N>) -> [Field; N] {
    let bytes = s.as_bytes();
    bytes.map(|b: u8| b as Field)
}

#[test]
fn test_constants() {
    // Just a sanity check to make sure the constants are what we expect.
    assert(
        MIGRATION_NOTE_STORAGE_SLOT == poseidon2_hash(str_to_fields("migration-note-storage-slot")),
        "MIGRATION_NOTE_STORAGE_SLOT does not match the expected value",
    );
    assert(
        DOM_SEP__CLAIM_A == poseidon2_hash(str_to_fields("claim-a")),
        "DOM_SEP__CLAIM_A does not match the expected value",
    );
    assert(
        DOM_SEP__CLAIM_B == poseidon2_hash(str_to_fields("claim-b")),
        "DOM_SEP__CLAIM_B does not match the expected value",
    );
    assert(
        DOM_SEP__CLAIM_B_PUBLIC == poseidon2_hash(str_to_fields("claim-b-public")),
        "DOM_SEP__CLAIM_B_PUBLIC does not match the expected value",
    );
    assert(
        DOM_SEP__PUBLIC_MIGRATION_NULLIFIER
            == poseidon2_hash(str_to_fields("public-migration-nullifier")),
        "DOM_SEP__PUBLIC_MIGRATION_NULLIFIER does not match the expected value",
    );
}
