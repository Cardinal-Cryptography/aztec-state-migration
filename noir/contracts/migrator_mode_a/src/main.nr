use aztec::macros::aztec as aztec_contract;

mod migration_note;
pub mod mode_a;

#[aztec_contract]
pub contract MigratorModeA {
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        protocol_types::{address::EthAddress, hash::poseidon2_hash},
        state_vars::{
            map::Map, public_immutable::PublicImmutable,
            public_mutable::PublicMutable,
        },
    };

    #[storage]
    struct Storage<Context> {
        // L1 Migrator address
        l1_migrator: PublicImmutable<EthAddress, Context>,
        // old rollup version
        old_rollup_version: PublicImmutable<Field, Context>,

        // Mapping: proven_block_number -> archive_root
        // Allows users to prove against any registered snapshot
        old_archive_roots: Map<u32, PublicMutable<Field, Context>, Context>,
        // Track the latest registered proven block (for convenience)
        latest_proven_block: PublicMutable<u32, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(l1_migrator: EthAddress, old_rollup_version: Field) {
            self.storage.l1_migrator.initialize(l1_migrator);
            self.storage.old_rollup_version.initialize(old_rollup_version);
    }

    // Register old rollup archive root by consuming L1-L2 message from L1Migrator
    // Can be called multiple times to register new snapshots as users create lock notes
    #[external("public")]
    fn register_archive_root(
        archive_root: Field,
        proven_block_number: u32,
        secret: Field,
        leaf_index: Field,
    ) {
        let old_rollup_version = self.storage.old_rollup_version.read();
        // Verify the L1-L2 message content matches
        // Content was: poseidon2(oldVersion, archiveRoot, provenBlockNumber)
        let content = poseidon2_hash([
            old_rollup_version,
            archive_root,
            proven_block_number as Field,
        ]);

        // Consume L1-L2 message from L1Migrator
        self.context.consume_l1_to_l2_message(
            content,
            secret,
            self.storage.l1_migrator.read(),
            leaf_index,
        );

        // Store archive root indexed by proven block number
        self.storage.old_archive_roots.at(proven_block_number).write(archive_root);

        // Update latest if this is newer
        let current_latest = self.storage.latest_proven_block.read();
        if proven_block_number as u64 > current_latest as u64 {
            self.storage.latest_proven_block.write(proven_block_number);
        }
    }

    // Verify archive root matches, check destination, and mark note as migrated
    #[external("public")]
    fn verify_archive_root(archive_block_number: u32, computed_archive_root: Field) {
        // Verify archive root matches the registered one for this block
        let stored_archive_root = self.storage.old_archive_roots.at(archive_block_number).read();
        assert(stored_archive_root != 0, "Archive root not registered for this block");
        assert(
            computed_archive_root == stored_archive_root,
            "Archive root mismatch - note not in old rollup",
        );
    }

    // ============================================================
    // View functions
    // ============================================================

    #[external("utility")]
    unconstrained fn get_old_archive_root(proven_block_number: u32) -> Field {
        self.storage.old_archive_roots.at(proven_block_number).read()
    }

    #[external("utility")]
    unconstrained fn get_latest_proven_block() -> u32 {
        self.storage.latest_proven_block.read()
    }
}
