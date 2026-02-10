use aztec::macros::aztec as aztec_contract;

mod migration_lock_note;
pub mod types;
pub use aztec::protocol_types::constants::{ARCHIVE_HEIGHT, NOTE_HASH_TREE_HEIGHT};
pub use migration_lock_note::MigrationLockNote;

#[aztec_contract]
pub contract Migrator {
    use crate::{migration_lock_note::MigrationLockNote, types::L2Actor};
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        note::note_interface::NoteHash,
        protocol_types::{
            abis::block_header::BlockHeader,
            address::{AztecAddress, EthAddress},
            constants::{ARCHIVE_HEIGHT, NOTE_HASH_TREE_HEIGHT},
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
        // old rollup migrator contract
        old_rollup_migrator: PublicImmutable<L2Actor, Context>,

        // Mapping: proven_block_number -> archive_root
        // Allows users to prove against any registered snapshot
        old_archive_roots: Map<u32, PublicMutable<Field, Context>, Context>,
        // Track the latest registered proven block (for convenience)
        latest_proven_block: PublicMutable<u32, Context>,

        // Migration lock notes created by users (in old rollup)
        migration_locks: Owned<PrivateSet<MigrationLockNote, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(l1_migrator: Option<EthAddress>, old_rollup_migrator: Option<L2Actor>) {
        assert(
            l1_migrator.is_some() == old_rollup_migrator.is_some(),
            "Must provide both L1 migrator and old rollup migrator, or neither",
        );
        if l1_migrator.is_some() {
            self.storage.l1_migrator.initialize(l1_migrator.unwrap());
            self.storage.old_rollup_migrator.initialize(old_rollup_migrator.unwrap());
        }
    }

    // Register old rollup archive roots by consuming L1-L2 message from L1Migrator
    // Can be called multiple times to register new snapshots as users create lock notes
    #[external("public")]
    fn register_old_roots(
        archive_root: Field,
        proven_block_number: u32,
        secret: Field,
        leaf_index: Field,
    ) {
        let old_rollup_version = self.storage.old_rollup_migrator.read().version;
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
            MigrationLockNote::new(note_creator, owner_mpk, destination_rollup, migration_data);
        self.storage.migration_locks.at(note_owner).insert(lock_note).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
    }

    // ============================================================
    // Mode A: Routine Migration (on NEW rollup)
    // ============================================================
    //
    // User flow:
    // 1. On OLD rollup: User calls app contract to nullify original note and create MigrationLockNote
    // 2. On NEW rollup: User calls app contract which calls this function to prove the MigrationLockNote exists
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
        // migration secret key
        msk: Field,
        // MigrationLockNote fields
        lock_note_creator: AztecAddress,
        migration_data: Field,
        // Lock note hashing data
        lock_note_storage_slot: Field,
        lock_note_randomness: Field,
        // Siloing data
        lock_note_nonce: Field,
        // Note hash tree membership proof
        lock_note_hash_leaf_index: Field,
        lock_note_hash_sibling_path: [Field; NOTE_HASH_TREE_HEIGHT],
        // Full block header (to verify note_hash_tree_root is bound to archive)
        archive_block_header: BlockHeader,
        // Archive membership proof (proves block header hash is in archive)
        archive_leaf_index: Field,
        archive_sibling_path: [Field; ARCHIVE_HEIGHT],
    ) {
        // 0. Verify destination_rollup matches current rollup
        let current_rollup = self.context.version();
        // 1. Verify ownership: caller must know msk corresponding to mpk
        let mpk = poseidon2_hash([msk]);
        // 2. Compute the MigrationLockNote hash
        //    Owner is ignored by our #[custom_note] - mpk serves as ownership proof
        let migration_note =
            MigrationLockNote::new(lock_note_creator, mpk, current_rollup, migration_data);
        let migration_note_hash = migration_note.compute_note_hash(
            AztecAddress::zero(),
            lock_note_storage_slot,
            lock_note_randomness,
        );

        // 3. Compute siloed note hash (tied to the old lock contract)
        let siloed_note_hash = compute_siloed_note_hash(
            self.storage.old_rollup_migrator.read().address,
            migration_note_hash,
        );
        // 4. Compute unique note hash (what's actually in the tree)
        let unique_note_hash = compute_unique_note_hash(lock_note_nonce, siloed_note_hash);
        // 5. Extract note_hash_tree_root from block header
        let note_hash_tree_root = archive_block_header.state.partial.note_hash_tree.root;
        // 6. Verify unique_note_hash is in the note_hash_tree
        let computed_note_hash_tree_root = root_from_sibling_path(
            unique_note_hash,
            lock_note_hash_leaf_index,
            lock_note_hash_sibling_path,
        );
        assert(
            computed_note_hash_tree_root == note_hash_tree_root,
            "Lock note not in note hash tree",
        );

        // 7. Compute block header hash
        let archive_block_header_hash = archive_block_header.hash();
        // 8. Compute archive root from merkle proof (verification happens in public part)
        let computed_archive_root = root_from_sibling_path(
            archive_block_header_hash,
            archive_leaf_index,
            archive_sibling_path,
        );

        // 9. Compute and push migration nullifier (prevents double-claiming)
        let migration_nullifier = MigrationLockNote::compute_nullifier(
            migration_note_hash,
            msk,
        );
        self.context.push_nullifier(migration_nullifier);

        // 10. Call public function to verify archive root
        Migrator::at(self.context.this_address())
            .complete_migration(
                archive_block_header.global_variables.block_number,
                computed_archive_root,
            )
            .enqueue(self.context);
    }

    // Verify archive root matches, check destination, and mark note as migrated
    #[external("public")]
    fn complete_migration(archive_block_number: u32, computed_archive_root: Field) {
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
