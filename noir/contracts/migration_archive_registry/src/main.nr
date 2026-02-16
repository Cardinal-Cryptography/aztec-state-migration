use aztec::macros::aztec as aztec_contract;

pub use aztec::protocol_types::constants::{
    ARCHIVE_HEIGHT, NOTE_HASH_TREE_HEIGHT, NULLIFIER_TREE_HEIGHT,
};

/// On-chain registry that stores archive roots bridged from the old rollup via L1.
///
/// Provides two verification modes used during migration:
/// - **Mode A** (`verify_migration_mode_a`): checks an archive root against any registered block.
/// - **Mode B** (`verify_migration_mode_b`): checks an archive root against a fixed snapshot height.
#[aztec_contract]
pub contract MigrationArchiveRegistry {
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        protocol_types::{address::{AztecAddress, EthAddress}, hash::poseidon2_hash},
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

        // Mapping: proven_block_number -> archive_root
        old_archive_roots: Map<u32, PublicMutable<Field, Context>, Context>,
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
    // Archive root registration (permissionless)
    // ============================================================

    /// Register an archive root bridged from the old rollup via an L1-to-L2 message.
    ///
    /// Consumes the L1-to-L2 message (preventing replay), stores the archive root
    /// keyed by its proven block number, and updates the latest proven block tracker.
    #[external("public")]
    fn register_archive_root(
        archive_root: Field,
        proven_block_number: u32,
        secret: Field,
        leaf_index: Field,
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

        // Store archive root
        self.storage.old_archive_roots.at(proven_block_number).write(archive_root);

        // Update latest if newer
        let current_latest = self.storage.latest_proven_block.read();
        if proven_block_number as u64 > current_latest as u64 {
            self.storage.latest_proven_block.write(proven_block_number);
        }
    }

    // ============================================================
    // MODE B: Snapshot height configuration
    // ============================================================

    /// Set the snapshot height for Mode B migration. Can only be called once.
    /// Requires that an archive root has already been registered for the given height.
    #[external("public")]
    fn set_snapshot_height(height: u32) {
        // Archive root must be registered for this height
        let archive_root = self.storage.old_archive_roots.at(height).read();
        assert(archive_root != 0, "No archive root registered for this height");

        self.storage.snapshot_height.initialize(height);
    }

    // ============================================================
    // MODE A: Migration verification
    // ============================================================

    /// Verify a Mode A migration by checking that the computed archive root matches
    /// the registered root for the given block number.
    #[external("public")]
    fn verify_migration_mode_a(archive_block_number: u32, computed_archive_root: Field) {
        // Verify archive root matches the registered one for this block
        let stored_archive_root = self.storage.old_archive_roots.at(archive_block_number).read();
        assert(stored_archive_root != 0, "Archive root not registered for this block");
        assert(
            computed_archive_root == stored_archive_root,
            "Archive root mismatch - note not in old rollup",
        );
    }

    // ============================================================
    // MODE B: Snapshot-based verification
    // ============================================================

    /// Verify a Mode B migration by checking that the computed archive root matches
    /// the registered root at the configured snapshot height.
    #[external("public")]
    fn verify_migration_mode_b(computed_archive_root: Field) {
        let snapshot_height = self.storage.snapshot_height.read();

        // Verify archive root
        let stored_archive_root = self.storage.old_archive_roots.at(snapshot_height).read();
        assert(stored_archive_root != 0, "Archive root not registered for snapshot height");
        assert(
            computed_archive_root == stored_archive_root,
            "Archive root mismatch - block header not from old rollup at snapshot height",
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

    /// Return the stored archive root for a given proven block number.
    #[external("utility")]
    unconstrained fn get_old_archive_root(proven_block_number: u32) -> Field {
        self.storage.old_archive_roots.at(proven_block_number).read()
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
}
