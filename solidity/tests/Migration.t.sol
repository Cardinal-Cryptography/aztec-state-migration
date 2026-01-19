pragma solidity >=0.8.27;
 
import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {LibPoseidon2Yul} from "poseidon2-evm/bn254/yul/LibPoseidon2Yul.sol";
 
contract MigrationTest is Test {
    function test_hash() public pure {
        bytes32 a = bytes32(uint256(2137));
        bytes32 b = bytes32(uint256(42));
        bytes32 hash = bytes32(LibPoseidon2Yul.hash_2(uint256(a), uint256(b)));
        string memory hashStr = vm.toString(hash);
        console.log("POSEIDON2_HASH: %s", hashStr);
    }
}
