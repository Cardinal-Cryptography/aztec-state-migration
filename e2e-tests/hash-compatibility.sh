#!/bin/bash
set -e

cd solidity
solidity_hash_2=$(forge test --match-test test_hash_2 -vvv | grep "POSEIDON2_HASH_2: " | awk '{print $2}' | tr -d '\r')
solidity_hash_3=$(forge test --match-test test_hash_3 -vvv | grep "POSEIDON2_HASH_3: " | awk '{print $2}' | tr -d '\r')
cd ../noir
noir_hash_2=$(aztec test test_hash_2 --show-output | grep "POSEIDON2_HASH_2: " | awk '{print $2}' | tr -d '\r')
noir_hash_3=$(aztec test test_hash_3 --show-output | grep "POSEIDON2_HASH_3: " | awk '{print $2}' | tr -d '\r')

hash_2_compatible=$([[ "$solidity_hash_2" = "$noir_hash_2" ]] && echo "true" || echo "false")
hash_3_compatible=$([[ "$solidity_hash_3" = "$noir_hash_3" ]] && echo "true" || echo "false")

if [ "$hash_2_compatible" = true ] && [ "$hash_3_compatible" = true ]; then
    echo "Hashes are compatible:"
    echo "hash2: $solidity_hash_2"
    echo "hash3: $solidity_hash_3"
    exit 0
elif [ "$hash_2_compatible" = false ]; then
    echo "Hashes are NOT compatible! (hash2)"
    echo "Solidity hash: $solidity_hash_2"
    echo "Noir hash:     $noir_hash_2"
    exit 1
elif [ "$hash_3_compatible" = false ]; then
    echo "Hashes are NOT compatible! (hash3)"
    echo "Solidity hash: $solidity_hash_3"
    echo "Noir hash:     $noir_hash_3"
    exit 1
fi
