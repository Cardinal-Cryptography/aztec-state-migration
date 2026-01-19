pragma solidity >=0.8.27;

import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {LibPoseidon2Yul} from "poseidon2-evm/bn254/yul/LibPoseidon2Yul.sol";

contract Migrator {
    IInbox public inbox;
    IOutbox public outbox;
    DataStructures.L2Actor public oldAppActor;

    event Migration(
        uint256 leafIndex
    );

    constructor(address _inbox, address _outbox, DataStructures.L2Actor memory _oldAppActor) {
        inbox = IInbox(_inbox);
        outbox = IOutbox(_outbox);
        oldAppActor = _oldAppActor;
    }

    function migrate(DataStructures.L2Actor memory newAppActor, bytes32 innerContentHash, bytes32 _secretHash, uint256 _checkpointNumber, uint256 _leafIndex, bytes32[] calldata _path) external {
        DataStructures.L1Actor memory migratorActor = DataStructures.L1Actor({
            actor: address(this),
            chainId: block.chainid
        });
        bytes32 content = bytes32(LibPoseidon2Yul.hash_2(uint256(innerContentHash), uint256(_secretHash)));
        DataStructures.L2ToL1Msg memory message = DataStructures.L2ToL1Msg({
            sender: oldAppActor,
            recipient: migratorActor,
            content: content
        });
        outbox.consume(message, _checkpointNumber, _leafIndex, _path);

        (, uint256 leafIndex) = inbox.sendL2Message(newAppActor, content, _secretHash);
        emit Migration(leafIndex);
    }
}
