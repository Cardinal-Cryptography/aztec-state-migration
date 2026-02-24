use aztec::protocol::hash::poseidon2_hash;

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
