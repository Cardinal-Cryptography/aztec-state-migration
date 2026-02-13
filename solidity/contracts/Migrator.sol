// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27;

import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IPoseidon2} from "poseidon2-evm/IPoseidon2.sol";

/// @title Migrator
/// @notice Migrates old rollup archive roots to new rollup apps for efficient state migration
/// @dev Users can then prove note membership against the old archive root on the new rollup
// solhint-disable comprehensive-interface
contract Migrator {
    // This is poseidon2_hash([DOM_SEP__SECRET_HASH, 0]) so that L2 can consume with secret=0
    // This matches Noir's compute_secret_hash(0) where DOM_SEP__SECRET_HASH = 20
    bytes32 public constant SECRET_HASH_FOR_ZERO = 0x001dc7b0244cb71a4609d526300ba6771064bd046848666f7bfe577053d630c5;

    IRegistry public immutable REGISTRY;
    IPoseidon2 public immutable POSEIDON2;


    /// @notice Emitted when archive roots are migrated to a new rollup
    event ArchiveRootMigrated(
        uint256 indexed oldVersion,
        uint256 indexed newVersion,
        bytes32 indexed l2Migrator,
        bytes32 archiveRoot,
        uint256 provenBlockNumber,
        bytes32 messageLeaf,
        uint256 messageLeafIndex
    );

    constructor(address _registry, address _poseidon2) {
        REGISTRY = IRegistry(_registry);
        POSEIDON2 = IPoseidon2(_poseidon2);
    }

    /// @notice Send old rollup's archive root to a new rollup app via L1→L2 message
    /// @param oldVersion The old rollup version to read archive root from
    /// @param l2Migrator The L2 migrator on new rollup that will store the roots
    /// @return leaf The L1→L2 message leaf hash
    /// @return leafIndex The index in the L1→L2 message tree
    function migrateArchiveRoot(
        uint256 oldVersion,
        DataStructures.L2Actor calldata l2Migrator
    ) external returns (bytes32 leaf, uint256 leafIndex) {
        IRollup oldRollup = IRollup(address(REGISTRY.getRollup(oldVersion)));
        IRollup newRollup = IRollup(address(REGISTRY.getRollup(l2Migrator.version)));

        // Get the proven archive root from old rollup
        uint256 provenCheckpointNumber = oldRollup.getProvenCheckpointNumber();
        bytes32 archiveRoot = oldRollup.archiveAt(provenCheckpointNumber);

        // Content: poseidon2(oldVersion, archiveRoot, provenCheckpointNumber)
        // This allows the L2 contract to verify the message authenticity
        bytes32 content = bytes32(
            POSEIDON2.hash_3(oldVersion, uint256(archiveRoot), provenCheckpointNumber)
        );

        // Send to new rollup via L1→L2 message
        // Use SECRET_HASH_FOR_ZERO so L2 can consume with secret=0
        IInbox inbox = newRollup.getInbox();
        (leaf, leafIndex) = inbox.sendL2Message(l2Migrator, content, SECRET_HASH_FOR_ZERO);

        emit ArchiveRootMigrated(
            oldVersion,
            l2Migrator.version,
            l2Migrator.actor,
            archiveRoot,
            provenCheckpointNumber,
            leaf,
            leafIndex
        );
    }

    /// @notice Send archive root at a specific block height to a new rollup app via L1→L2 message
    /// @param oldVersion The old rollup version to read archive root from
    /// @param blockNumber The block number to read the archive root at (must be <= proven checkpoint)
    /// @param l2Migrator The L2 migrator on new rollup that will store the roots
    /// @return leaf The L1→L2 message leaf hash
    /// @return leafIndex The index in the L1→L2 message tree
    function migrateArchiveRootAtBlock(
        uint256 oldVersion,
        uint256 blockNumber,
        DataStructures.L2Actor calldata l2Migrator
    ) external returns (bytes32 leaf, uint256 leafIndex) {
        IRollup oldRollup = IRollup(address(REGISTRY.getRollup(oldVersion)));
        IRollup newRollup = IRollup(address(REGISTRY.getRollup(l2Migrator.version)));

        // Ensure the requested block is finalized
        uint256 provenCheckpointNumber = oldRollup.getProvenCheckpointNumber();
        require(blockNumber <= provenCheckpointNumber, "Block not yet proven");

        bytes32 archiveRoot = oldRollup.archiveAt(blockNumber);

        bytes32 content = bytes32(
            POSEIDON2.hash_3(oldVersion, uint256(archiveRoot), blockNumber)
        );

        IInbox inbox = newRollup.getInbox();
        (leaf, leafIndex) = inbox.sendL2Message(l2Migrator, content, SECRET_HASH_FOR_ZERO);

        emit ArchiveRootMigrated(
            oldVersion,
            l2Migrator.version,
            l2Migrator.actor,
            archiveRoot,
            blockNumber,
            leaf,
            leafIndex
        );
    }

    /// @notice Get archive root info from a rollup version (view function for off-chain use)
    /// @param version The rollup version to query
    /// @return archiveRoot The current archive root
    /// @return provenCheckpointNumber The last proven checkpoint number
    function getArchiveInfo(uint256 version)
        external
        view
        returns (bytes32 archiveRoot, uint256 provenCheckpointNumber)
    {
        IRollup rollup = IRollup(address(REGISTRY.getRollup(version)));
        provenCheckpointNumber = rollup.getProvenCheckpointNumber();
        archiveRoot = rollup.archiveAt(provenCheckpointNumber);
    }
}
