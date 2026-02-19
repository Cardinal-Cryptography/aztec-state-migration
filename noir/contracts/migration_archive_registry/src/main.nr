use aztec::macros::aztec as aztec_contract;

pub use aztec::protocol_types::constants::{
    ARCHIVE_HEIGHT, NOTE_HASH_TREE_HEIGHT, NULLIFIER_TREE_HEIGHT,
};

/// On-chain registry that stores block hashes bridged from the old rollup via L1.
///
/// Provides two verification modes used during migration:
/// - **Mode A** (`verify_migration_mode_a`): checks a block hash against any registered block.
/// - **Mode B** (`verify_migration_mode_b`): checks a block hash against a fixed snapshot.
#[aztec_contract]
pub contract MigrationArchiveRegistry {
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        protocol_types::{
            abis::block_header::BlockHeader,
            address::{AztecAddress, EthAddress},
            constants::ARCHIVE_HEIGHT,
            hash::poseidon2_hash,
            merkle_tree::root::root_from_sibling_path,
            traits::{Hash, ToField},
        },
        state_vars::{map::Map, public_immutable::PublicImmutable, public_mutable::PublicMutable},
    };

    #[storage]
    struct Storage<Context> {
        // L1 Migrator address (for L1-to-L2 message consumption)
        l1_migrator: PublicImmutable<EthAddress, Context>,
        // Old rollup version (for archive root content verification)
        old_rollup_version: PublicImmutable<Field, Context>,
        // Old rollup MigrationKeyRegistry address (for siloing MigrationKeyNote hashes)
        old_key_registry: PublicImmutable<AztecAddress, Context>,
        // Snapshot height H: the block at which Mode B migration is anchored
        snapshot_height: PublicImmutable<u32, Context>,
        // Precomputed hash of the snapshot header for efficient Mode B verification
        snapshot_block_hash: PublicImmutable<Field, Context>,

        // Mapping: block_number -> block_hash (hash of the block header)
        block_hashes: Map<u32, PublicMutable<Field, Context>, Context>,
        // Track the latest registered proven block
        latest_proven_block: PublicMutable<u32, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(
        l1_migrator: EthAddress,
        old_rollup_version: Field,
        old_key_registry: AztecAddress,
    ) {
        self.storage.l1_migrator.initialize(l1_migrator);
        self.storage.old_rollup_version.initialize(old_rollup_version);
        self.storage.old_key_registry.initialize(old_key_registry);
    }

    // ============================================================
    // Block registration (permissionless)
    // ============================================================

    /// Register a block hash derived from an archive root bridged via an L1-to-L2 message.
    ///
    /// Consumes the L1-to-L2 message (preventing replay), verifies the block header
    /// is part of the archive tree, stores the block hash, and updates the latest
    /// proven block tracker.
    #[external("public")]
    fn register_block(
        archive_root: Field,
        proven_block_number: u32,
        secret: Field,
        leaf_index: Field,
        block_header: BlockHeader,
        archive_sibling_path: [Field; ARCHIVE_HEIGHT],
    ) {
        let old_rollup_version = self.storage.old_rollup_version.read();
        // Content: poseidon2(oldVersion, archiveRoot, provenBlockNumber)
        let content = poseidon2_hash([
            old_rollup_version,
            archive_root,
            proven_block_number as Field,
        ]);

        // Consume L1-to-L2 message
        self.context.consume_l1_to_l2_message(
            content,
            secret,
            self.storage.l1_migrator.read(),
            leaf_index,
        );

        // Compute block hash and verify it's in the archive tree
        let block_number = block_header.global_variables.block_number;
        let block_hash = block_header.hash();
        let computed_archive_root =
            root_from_sibling_path(block_hash, block_number.to_field(), archive_sibling_path);
        assert(computed_archive_root == archive_root, "Block header not in archive tree");

        // The block must be within the proven range
        assert(
            block_number as u64 <= proven_block_number as u64,
            "Block number exceeds proven checkpoint",
        );

        // Store block hash
        let block_number_u32 = block_number as u32;
        self.storage.block_hashes.at(block_number_u32).write(block_hash);

        // Update latest if newer
        let current_latest = self.storage.latest_proven_block.read();
        if block_number_u32 as u64 > current_latest as u64 {
            self.storage.latest_proven_block.write(block_number_u32);
        }
    }

    // ============================================================
    // MODE B: Snapshot height configuration
    // ============================================================

    /// Set the snapshot height for Mode B migration. Can only be called once.
    /// Verifies the snapshot block header against a registered reference block.
    ///
    /// If `height == reference_block_number`, the snapshot block IS the registered block.
    /// If `height < reference_block_number`, verifies the snapshot block header via
    /// a Merkle proof against the reference block's `last_archive` root.
    #[external("public")]
    fn set_snapshot_height(
        height: u32,
        snapshot_block_header: BlockHeader,
        reference_block_number: u32,
        reference_block_header: BlockHeader,
        archive_sibling_path: [Field; ARCHIVE_HEIGHT],
    ) {
        // 1. Verify reference block header is registered
        let stored_ref_hash = self.storage.block_hashes.at(reference_block_number).read();
        assert(stored_ref_hash != 0, "Reference block not registered");
        assert(
            reference_block_header.hash() == stored_ref_hash,
            "Reference block header hash mismatch",
        );

        // 2. Verify snapshot block header
        let snapshot_block_hash = snapshot_block_header.hash();
        if height == reference_block_number {
            // Snapshot IS the registered block
            assert(
                snapshot_block_hash == stored_ref_hash,
                "Snapshot header does not match registered block",
            );
        } else {
            assert(
                (height as u64) < (reference_block_number as u64),
                "Snapshot height must be less than reference block",
            );
            // Verify snapshot block is in reference block's archive
            let archive_root = reference_block_header.last_archive.root;
            let computed_root =
                root_from_sibling_path(snapshot_block_hash, height as Field, archive_sibling_path);
            assert(
                computed_root == archive_root,
                "Snapshot block not in reference block's archive",
            );
        }

        // 3. Store snapshot
        self.storage.snapshot_height.initialize(height);
        self.storage.snapshot_block_hash.initialize(snapshot_block_hash);
    }

    // ============================================================
    // MODE A: Migration verification
    // ============================================================

    /// Verify a Mode A migration by checking that the block hash matches
    /// the registered hash for the given block number.
    #[external("public")]
    fn verify_migration_mode_a(block_number: u32, block_hash: Field) {
        let stored_hash = self.storage.block_hashes.at(block_number).read();
        assert(stored_hash != 0, "Block hash not registered for this block");
        assert(block_hash == stored_hash, "Block hash mismatch - block header not from old rollup");
    }

    // ============================================================
    // MODE B: Snapshot-based verification
    // ============================================================

    /// Verify a Mode B migration by checking that the block hash matches
    /// the stored snapshot block hash.
    #[external("public")]
    fn verify_migration_mode_b(block_hash: Field) {
        let stored_hash = self.storage.snapshot_block_hash.read();
        assert(stored_hash != 0, "Snapshot not set");
        assert(
            block_hash == stored_hash,
            "Block hash mismatch - block header not from old rollup at snapshot height",
        );
    }

    // ============================================================
    // View functions
    // ============================================================

    /// Return the old rollup's MigrationKeyRegistry address (private call for siloing).
    #[external("private")]
    fn get_old_key_registry() -> AztecAddress {
        self.storage.old_key_registry.read()
    }

    /// Return the stored block hash for a given block number.
    #[external("utility")]
    unconstrained fn get_block_hash(block_number: u32) -> Field {
        self.storage.block_hashes.at(block_number).read()
    }

    /// Return the highest proven block number that has been registered.
    #[external("utility")]
    unconstrained fn get_latest_proven_block() -> u32 {
        self.storage.latest_proven_block.read()
    }

    /// Return the configured Mode B snapshot height.
    #[external("utility")]
    unconstrained fn get_snapshot_height() -> u32 {
        self.storage.snapshot_height.read()
    }

    /// Return the stored snapshot block hash.
    #[external("utility")]
    unconstrained fn get_snapshot_block_hash() -> Field {
        self.storage.snapshot_block_hash.read()
    }
}
