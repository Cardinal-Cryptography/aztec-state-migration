// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27;

import {console} from "forge-std/console.sol";
import {Test} from "forge-std/Test.sol";
import {LibPoseidon2Yul} from "poseidon2-evm/bn254/yul/LibPoseidon2Yul.sol";

// solhint-disable comprehensive-interface
contract MigrationTest is Test {
    function test_hash_2() public pure {
        bytes32 a = bytes32(uint256(2137));
        bytes32 b = bytes32(uint256(42));
        bytes32 hash = bytes32(LibPoseidon2Yul.hash_2(uint256(a), uint256(b)));
        string memory hashStr = vm.toString(hash);
        console.log("POSEIDON2_HASH_2: %s", hashStr);
    }

    function test_hash_3() public pure {
        bytes32 a = bytes32(uint256(2137));
        bytes32 b = bytes32(uint256(42));
        bytes32 c = bytes32(uint256(1670));
        bytes32 hash = bytes32(LibPoseidon2Yul.hash_3(uint256(a), uint256(b), uint256(c)));
        string memory hashStr = vm.toString(hash);
        console.log("POSEIDON2_HASH_3: %s", hashStr);
    }
}
