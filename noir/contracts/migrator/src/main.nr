use aztec::macros::aztec;

mod migration_lock_note;
pub use migration_lock_note::MigrationLockNote;

// Aztec protocol tree heights
pub global NOTE_HASH_TREE_HEIGHT: u32 = 42;
pub global ARCHIVE_TREE_HEIGHT: u32 = 30;

// Domain separator for migration nullifiers
pub global MIGRATION_DOMAIN: Field = 0x4d494752415445; // "MIGRATE" in hex

#[aztec]
pub contract Migrator {
    use crate::{ARCHIVE_TREE_HEIGHT, MIGRATION_DOMAIN, NOTE_HASH_TREE_HEIGHT};
    use crate::migration_lock_note::MigrationLockNote;
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        note::note_interface::NoteHash,
        protocol_types::{
            abis::block_header::BlockHeader,
            address::{AztecAddress, EthAddress},
            hash::{compute_siloed_note_hash, compute_unique_note_hash, poseidon2_hash},
            merkle_tree::root::root_from_sibling_path,
            traits::Hash,
        },
        state_vars::{
            map::Map, owned::Owned, private_set::PrivateSet, public_immutable::PublicImmutable,
            public_mutable::PublicMutable,
        },
    };
    use aztec::messages::message_delivery::MessageDelivery;

    #[storage]
    struct Storage<Context> {
        // L1 Migrator address
        l1_migrator: PublicImmutable<EthAddress, Context>,
        // old rollup version
        old_rollup_version: PublicImmutable<Field, Context>,

        // Mapping: proven_block_number -> archive_root
        // Allows users to prove against any registered snapshot
        old_archive_roots: Map<Field, PublicMutable<Field, Context>, Context>,
        // Track the latest registered proven block (for convenience)
        latest_proven_block: PublicMutable<Field, Context>,

        // Migration lock notes created by users (in current rollup)
        migration_locks: Owned<PrivateSet<MigrationLockNote, Context>, Context>,

        // Track migrated note hashes (from old rollup) to prevent double-claiming
        // Key: poseidon2(MIGRATION_DOMAIN, migration_data, owner_mpk)
        migrated_notes: Map<Field, PublicMutable<bool, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(l1_migrator: EthAddress, old_version: Field) {
        self.storage.l1_migrator.initialize(l1_migrator);
        self.storage.old_rollup_version.initialize(old_version);
    }

    // Register old rollup archive roots by consuming L1-L2 message from L1Migrator
    // Can be called multiple times to register new snapshots as users create lock notes
    #[external("public")]
    fn register_old_roots(
        old_rollup_version: Field,
        archive_root: Field,
        proven_block_number: Field,
        secret: Field,
        leaf_index: Field,
    ) {
        // Verify the L1-L2 message content matches
        // Content was: poseidon2(oldVersion, archiveRoot, provenBlockNumber)
        let content = poseidon2_hash([old_rollup_version, archive_root, proven_block_number]);

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

    // ============================================================
    // Mode A: Routine Migration (on OLD rollup)
    // ============================================================

    #[external("private")]
    fn lock_migration_note(
        note_owner: AztecAddress,
        destination_rollup: Field,
        owner_msk: Field,
        migration_data: Field,
    ) {
        let note_creator = self.context.msg_sender().unwrap();
        let owner_mpk = poseidon2_hash([owner_msk]);
        let lock_note =
            MigrationLockNote::new(note_creator, owner_mpk, migration_data, destination_rollup);
        self.storage.migration_locks.at(note_owner).insert(lock_note).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
    }

    // ============================================================
    // Mode A: Routine Migration (on NEW rollup)
    // ============================================================
    //
    // User flow:
    // 1. On OLD rollup: User calls lock contract to nullify original note and create MigrationLockNote
    // 2. On NEW rollup: User calls this function to prove the MigrationLockNote exists
    //
    // MigrationLockNote structure:
    //   - owner_msk: Point      (migration secret key - for ownership proof)
    //   - migration_data: Field (e.g. hash of original note data)
    //   - destination_rollup: Field (must match current rollup)
    //
    // Verification chain:
    //   lock_note_hash -> (merkle proof) -> note_hash_tree_root
    //       -> (part of) -> block_header
    //           -> (hash to) -> block_header_hash
    //               -> (merkle proof) -> archive_root (trusted from L1)
    #[external("private")]
    fn migrate_via_proof(
        // Owner's migration secret key
        owner_msk: Field,
        // MigrationLockNote fields
        note_creator: AztecAddress,
        migration_data: Field,
        destination_rollup: Field,
        // Lock note hashing data
        lock_note_storage_slot: Field,
        lock_note_randomness: Field,
        // Note owner address (included in note hash by #[note] macro)
        note_owner: AztecAddress,
        // Siloing data (old lock contract address)
        old_lock_contract_address: AztecAddress,
        nonce: Field,
        // Note hash tree membership proof
        note_hash_leaf_index: Field,
        note_hash_sibling_path: [Field; NOTE_HASH_TREE_HEIGHT],
        // Full block header (to verify note_hash_tree_root is bound to archive)
        block_header: BlockHeader,
        // Archive membership proof (proves block header hash is in archive)
        archive_leaf_index: Field,
        archive_sibling_path: [Field; ARCHIVE_TREE_HEIGHT],
        // Which registered archive root to verify against
        proven_block_number: Field,
    ) {
        // 0. Verify destination_rollup matches current rollup
        let current_rollup = self.context.version();
        assert(destination_rollup == current_rollup, "Destination rollup mismatch");

        // 1. Verify ownership: caller must know owner_msk corresponding to owner_mpk
        let owner_mpk = poseidon2_hash([owner_msk]);

        // 2. Compute the MigrationLockNote hash
        let migration_note =
            MigrationLockNote::new(note_creator, owner_mpk, migration_data, destination_rollup);
        let migration_note_hash = migration_note.compute_note_hash(
            note_owner,
            lock_note_storage_slot,
            lock_note_randomness,
        );

        // 3. Compute siloed note hash (tied to the old lock contract)
        let siloed_note_hash =
            compute_siloed_note_hash(old_lock_contract_address, migration_note_hash);

        // 4. Compute unique note hash (what's actually in the tree)
        let unique_note_hash = compute_unique_note_hash(nonce, siloed_note_hash);

        // 5. Extract note_hash_tree_root from block header
        let note_hash_tree_root = block_header.state.partial.note_hash_tree.root;

        // 6. Verify unique_note_hash is in the note_hash_tree
        let computed_note_hash_tree_root = root_from_sibling_path(
            unique_note_hash,
            note_hash_leaf_index,
            note_hash_sibling_path,
        );
        assert(
            computed_note_hash_tree_root == note_hash_tree_root,
            "Lock note not in note hash tree",
        );

        // 7. Compute block header hash (binds note_hash_tree_root to archive)
        let block_header_hash = block_header.hash();

        // 8. Compute archive root from merkle proof (verification happens in public part)
        let computed_archive_root =
            root_from_sibling_path(block_header_hash, archive_leaf_index, archive_sibling_path);

        // 9. Compute migration nullifier (same across Mode A and Mode B)
        //    nullifier = poseidon2(MIGRATION_DOMAIN, migration_data, owner_mpk)
        let migration_nullifier = poseidon2_hash([MIGRATION_DOMAIN, migration_data, owner_mpk]);

        // 10. Call public function to verify archive root and mark as migrated
        Migrator::at(self.context.this_address()).complete_migration(
            migration_nullifier,
            proven_block_number,
            computed_archive_root,
        ).enqueue(self.context);
    }

    // Verify archive root matches, check destination, and mark note as migrated
    #[external("public")]
    fn complete_migration(
        migration_nullifier: Field,
        proven_block_number: Field,
        computed_archive_root: Field,
    ) {
        // Verify archive root matches the registered one for this block
        let stored_archive_root = self.storage.old_archive_roots.at(proven_block_number).read();
        assert(stored_archive_root != 0, "Archive root not registered for this block");
        assert(
            computed_archive_root == stored_archive_root,
            "Archive root mismatch - note not in old rollup",
        );

        // Prevent double migration using consistent nullifier
        assert(
            !self.storage.migrated_notes.at(migration_nullifier).read(),
            "Note already migrated",
        );
        self.storage.migrated_notes.at(migration_nullifier).write(true);
    }

    // ============================================================
    // View functions
    // ============================================================

    #[external("utility")]
    unconstrained fn get_old_archive_root(proven_block_number: Field) -> Field {
        self.storage.old_archive_roots.at(proven_block_number).read()
    }

    #[external("utility")]
    unconstrained fn get_latest_proven_block() -> Field {
        self.storage.latest_proven_block.read()
    }

    #[external("utility")]
    unconstrained fn is_migration_nullifier_used(migration_nullifier: Field) -> bool {
        self.storage.migrated_notes.at(migration_nullifier).read()
    }
}
