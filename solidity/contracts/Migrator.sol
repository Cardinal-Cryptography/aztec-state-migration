pragma solidity >=0.8.27;

import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {IPoseidon2} from "poseidon2-evm/IPoseidon2.sol";

contract Migrator {
    IRegistry public immutable ROLLUP_REGISTRY;
    IPoseidon2 public immutable POSEIDON2;

    event Migration(DataStructures.L2Actor sender, DataStructures.L2Actor recipient, bytes32 leaf, uint256 leafIndex);

    constructor(address _rollupRegistry, address _poseidon2) {
        ROLLUP_REGISTRY = IRegistry(_rollupRegistry);
        POSEIDON2 = IPoseidon2(_poseidon2);
    }

    function migrate(
        DataStructures.L2Actor memory oldApp,
        DataStructures.L2Actor memory newApp,
        uint256 innerContentHash,
        uint256 secretHash,
        uint256 incomingCheckpointNumber,
        uint256 incomingLeafIndex,
        bytes32[] calldata incomingPath
    ) external {
        IOutbox outbox = IRollup(address(ROLLUP_REGISTRY.getRollup(oldApp.version))).getOutbox();
        IInbox inbox = IRollup(address(ROLLUP_REGISTRY.getRollup(newApp.version))).getInbox();

        uint256 content = POSEIDON2.hash_2(secretHash, innerContentHash);
        bytes32 incomingContent = bytes32(POSEIDON2.hash_3(uint256(newApp.actor), newApp.version, content));

        DataStructures.L2ToL1Msg memory incomingMessage =
            DataStructures.L2ToL1Msg({sender: oldApp, recipient: getThisL1Actor(), content: incomingContent});
        outbox.consume(incomingMessage, incomingCheckpointNumber, incomingLeafIndex, incomingPath);

        bytes32 outcomingContent = bytes32(POSEIDON2.hash_3(uint256(oldApp.actor), oldApp.version, content));
        (bytes32 leaf, uint256 leafIndex) = inbox.sendL2Message(newApp, outcomingContent, bytes32(secretHash));
        emit Migration(oldApp, newApp, leaf, leafIndex);
    }

    function getThisL1Actor() public view returns (DataStructures.L1Actor memory) {
        return DataStructures.L1Actor({actor: address(this), chainId: block.chainid});
    }
}
