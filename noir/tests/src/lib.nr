use aztec::protocol_types::{
    constants::GENERATOR_INDEX__NOTE_HASH,
    hash::{poseidon2_hash, poseidon2_hash_with_separator},
};

#[test]
unconstrained fn test_hash_2() {
    let a = 2137;
    let b = 42;

    let hash = poseidon2_hash([a, b]);

    println(f"POSEIDON2_HASH_2: {hash}");
}

#[test]
unconstrained fn test_hash_3() {
    let a = 2137;
    let b = 42;
    let c = 1670;

    let hash = poseidon2_hash([a, b, c]);

    println(f"POSEIDON2_HASH_3: {hash}");
}

/// Verify NFTNote hash matches the defi-wonderland/aztec-standards two-round Poseidon formula:
///   partial = poseidon2([owner, storage_slot, randomness], GENERATOR_INDEX__NOTE_HASH)
///   note_hash = poseidon2([partial, token_id], GENERATOR_INDEX__NOTE_HASH)
#[test]
unconstrained fn test_nft_note_hash() {
    let owner: Field = 0x1234;
    let storage_slot: Field = 3;
    let randomness: Field = 0xabcd;
    let token_id: Field = 42;

    let partial = poseidon2_hash_with_separator(
        [owner, storage_slot, randomness],
        GENERATOR_INDEX__NOTE_HASH,
    );
    let note_hash = poseidon2_hash_with_separator(
        [partial, token_id],
        GENERATOR_INDEX__NOTE_HASH,
    );

    println(f"NFT_NOTE_HASH: {note_hash}");
    println(f"NFT_NOTE_PARTIAL: {partial}");

    // Hardcoded expected values for regression detection.
    // If these change, the NFTNote hash formula drifted from defi-wonderland/aztec-standards.
    assert(
        partial == 0x20e8dc8d929d1cec8d6113a02cb2cf69446c9f2cf684364cb1cc174ada5b1874,
        "NFTNote partial commitment changed",
    );
    assert(
        note_hash == 0x0283a6856f6caa2a11252be4b62ad9e23938f6c13ab3169e540a718c163a9384,
        "NFTNote hash changed",
    );
}
