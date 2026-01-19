#!/bin/bash
set -e

cd solidity
solidity_hash=$(forge test --match-test test_hash -vvv | grep "POSEIDON2_HASH: " | awk '{print $2}' | tr -d '\r')
cd ../noir
noir_hash=$(aztec test test_hash --show-output | grep "POSEIDON2_HASH: " | awk '{print $2}' | tr -d '\r')
if [ "$solidity_hash" = "$noir_hash" ]; then
    echo "Hashes are compatible:"
    echo "hash: $solidity_hash"
else
    echo "Hashes are NOT compatible!"
    echo "Solidity hash: $solidity_hash"
    echo "Noir hash:     $noir_hash"
    exit 1
fi
