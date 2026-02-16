use aztec::macros::aztec;

/// Example migration-aware token contract.
///
/// Supports both Mode A (routine lock-and-claim) and Mode B (emergency snapshot) migration.
///
/// Mode A: Users call `lock_for_migration()` on old rollup, then `migrate()` on new rollup.
/// Mode B: Users prove note existence + non-nullification at snapshot height H.
#[aztec]
pub contract ExampleMigrationApp {
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        messages::message_delivery::MessageDelivery,
        protocol_types::{
            abis::block_header::BlockHeader, address::AztecAddress, hash::poseidon2_hash,
            traits::Serialize,
        },
        state_vars::{
            map::Map, owned::Owned, public_immutable::PublicImmutable,
            public_mutable::PublicMutable,
        },
    };
    use balance_set::balance_set::BalanceSet;
    use migrator::{ARCHIVE_HEIGHT, Migrator, NOTE_HASH_TREE_HEIGHT};
    use migrator_mode_b::{MigratorModeB, NULLIFIER_TREE_HEIGHT};

    #[storage]
    struct Storage<Context> {
        old_rollup_app_address: PublicImmutable<AztecAddress, Context>,
        // Token balances (using Aztec's BalanceSet for private balances)
        balances: Owned<BalanceSet<Context>, Context>,
        // Public token balances
        public_balances: Map<AztecAddress, PublicMutable<u128, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(old_rollup_app_address: Option<AztecAddress>) {
        if old_rollup_app_address.is_some() {
            self.storage.old_rollup_app_address.initialize(old_rollup_app_address.unwrap());
        }
    }

    // ============================================================
    // Standard token operations
    // ============================================================

    /// Mint tokens to an account (for testing)
    #[external("private")]
    fn mint(to: AztecAddress, amount: u128) {
        self.storage.balances.at(to).add(amount).deliver(MessageDelivery.CONSTRAINED_ONCHAIN);
    }

    /// Get balance (view function)
    #[external("utility")]
    unconstrained fn get_balance(account: AztecAddress) -> u128 {
        self.storage.balances.at(account).balance_of()
    }

    // ============================================================
    // Public balance operations
    // ============================================================

    /// Mint tokens to a public balance (for testing)
    #[external("private")]
    fn mint_public(to: AztecAddress, amount: u128) {
        ExampleMigrationApp::at(self.context.this_address())
            ._increment_public_balance(to, amount)
            .enqueue(self.context);
    }

    /// Get public balance (view function)
    #[external("utility")]
    unconstrained fn get_public_balance(account: AztecAddress) -> u128 {
        self.storage.public_balances.at(account).read()
    }

    #[external("public")]
    fn _increment_public_balance(owner: AztecAddress, amount: u128) {
        assert(
            self.context.msg_sender().unwrap() == self.context.this_address(),
            "Only callable internally",
        );
        let current = self.storage.public_balances.at(owner).read();
        self.storage.public_balances.at(owner).write(current + amount);
    }

    #[external("public")]
    fn _decrement_public_balance(owner: AztecAddress, amount: u128) {
        assert(
            self.context.msg_sender().unwrap() == self.context.this_address(),
            "Only callable internally",
        );
        let current = self.storage.public_balances.at(owner).read();
        assert(current >= amount, "Insufficient public balance");
        self.storage.public_balances.at(owner).write(current - amount);
    }

    // ============================================================
    // Mode A: Lock for Migration (on OLD rollup)
    // ============================================================

    /// Lock a token note for migration to a new rollup.
    ///
    /// This function:
    /// 1. Takes a UintNote from the caller's balance
    /// 2. Nullifies the original note (preventing double-spend)
    /// 3. Creates a MigrationNote that can be proven on the destination rollup
    #[external("private")]
    fn lock_for_migration(
        migrator_address: AztecAddress,
        amount: u128,
        destination_rollup: Field,
        owner_msk: Field,
    ) {
        let note_owner = self.context.msg_sender().unwrap();

        // 1. Subtract from balance (this nullifies notes internally)
        //    The BalanceSet handles note selection and nullification
        //    We don't need to deliver since we're locking, not transferring
        let _ = self.storage.balances.at(note_owner).sub(amount);

        // 2. Compute migration data
        let serialized = amount.serialize();
        let migration_data = poseidon2_hash(serialized);

        // 3. Call Migrator contract to create and store the MigrationNote
        let _ = self.call(Migrator::at(migrator_address).lock_migration_note(
            note_owner,
            destination_rollup,
            owner_msk,
            migration_data,
        ));

        // The lock note is now in the note hash tree and can be proven
        // on the new rollup using migrate_via_proof()
    }

    /// Lock a public token balance for migration to a new rollup.
    ///
    /// This function:
    /// 1. Creates a MigrationNote (identical to private lock) in the Migrator
    /// 2. Enqueues a public function to decrement the user's public balance
    ///
    /// The MigrationNote is the same as for private locks, so the claim circuit is unchanged.
    #[external("private")]
    fn lock_public_for_migration(
        migrator_address: AztecAddress,
        amount: u128,
        destination_rollup: Field,
        owner_msk: Field,
    ) {
        let note_owner = self.context.msg_sender().unwrap();

        // 1. Compute migration data (same as private lock)
        let serialized = amount.serialize();
        let migration_data = poseidon2_hash(serialized);

        // 2. Call Migrator contract to create and store the MigrationNote
        let _ = self.call(Migrator::at(migrator_address).lock_migration_note(
            note_owner,
            destination_rollup,
            owner_msk,
            migration_data,
        ));

        // 3. Enqueue public balance decrement (executes after private phase)
        //    If this fails (insufficient balance), the entire tx reverts including the MigrationNote
        ExampleMigrationApp::at(self.context.this_address())
            ._decrement_public_balance(note_owner, amount)
            .enqueue(self.context);
    }

    // ============================================================
    // Mode A: Migrate via Proof (on NEW rollup)
    // ============================================================

    #[external("private")]
    fn migrate(
        migrator_address: AztecAddress,
        // migration secret key
        msk: Field,
        // MigrationNote fields
        amount: u128,
        // Lock note hashing data
        migration_note_storage_slot: Field,
        migration_note_randomness: Field,
        // Siloing data
        migration_note_nonce: Field,
        // Note hash tree membership proof
        migration_note_hash_leaf_index: Field,
        migration_note_hash_sibling_path: [Field; NOTE_HASH_TREE_HEIGHT],
        // Full block header (to verify note_hash_tree_root is bound to archive)
        archive_block_header: BlockHeader,
        // Archive membership proof (proves block header hash is in archive)
        archive_leaf_index: Field,
        archive_sibling_path: [Field; ARCHIVE_HEIGHT],
    ) {
        // 1. Compute migration_data (must match what was stored in MigrationNote on old rollup)
        let serialized = amount.serialize();
        let migration_data = poseidon2_hash(serialized);

        // 2. Call Migrator to verify the proof and mark the MigrationNote as migrated
        let migration_note_creator = self.storage.old_rollup_app_address.read();
        let _ = self.call(Migrator::at(migrator_address).migrate_mode_a(
            msk,
            migration_note_creator, // migration_note_creator is the OLD app that called lock_migration_note
            migration_data,
            migration_note_storage_slot,
            migration_note_randomness,
            migration_note_nonce,
            migration_note_hash_leaf_index,
            migration_note_hash_sibling_path,
            archive_block_header,
            archive_leaf_index,
            archive_sibling_path,
        ));

        // 3. If successful, mint the migrated tokens to the user on the new rollup
        self.storage.balances.at(self.context.msg_sender().unwrap()).add(amount).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
    }

    /// Migrate tokens and claim to PUBLIC balance on new rollup.
    ///
    /// Same verification as migrate(), but mints to public balance instead of private.
    #[external("private")]
    fn migrate_to_public(
        migrator_address: AztecAddress,
        msk: Field,
        amount: u128,
        migration_note_storage_slot: Field,
        migration_note_randomness: Field,
        migration_note_nonce: Field,
        migration_note_hash_leaf_index: Field,
        migration_note_hash_sibling_path: [Field; NOTE_HASH_TREE_HEIGHT],
        archive_block_header: BlockHeader,
        archive_leaf_index: Field,
        archive_sibling_path: [Field; ARCHIVE_HEIGHT],
    ) {
        // 1. Compute migration_data (must match what was stored in MigrationNote on old rollup)
        let serialized = amount.serialize();
        let migration_data = poseidon2_hash(serialized);

        // 2. Call Migrator to verify the proof and mark the MigrationNote as migrated
        let migration_note_creator = self.storage.old_rollup_app_address.read();
        let _ = self.call(Migrator::at(migrator_address).migrate_mode_a(
            msk,
            migration_note_creator,
            migration_data,
            migration_note_storage_slot,
            migration_note_randomness,
            migration_note_nonce,
            migration_note_hash_leaf_index,
            migration_note_hash_sibling_path,
            archive_block_header,
            archive_leaf_index,
            archive_sibling_path,
        ));

        // 3. Mint to PUBLIC balance (instead of private)
        let recipient = self.context.msg_sender().unwrap();
        ExampleMigrationApp::at(self.context.this_address())
            ._increment_public_balance(recipient, amount)
            .enqueue(self.context);
    }

    // ============================================================
    // Mode B: Emergency Snapshot Migration (on NEW rollup)
    // ============================================================

    #[external("private")]
    fn migrate_mode_b(
        migrator_address: AztecAddress,
        // Authentication
        msk: Field,
        amount: u128,

        // UintNote (balance note) fields
        balance_note_owner: AztecAddress,
        balance_note_storage_slot: Field,
        balance_note_randomness: Field,
        balance_note_nonce: Field,

        // UintNote inclusion proof
        balance_note_leaf_index: Field,
        balance_note_sibling_path: [Field; NOTE_HASH_TREE_HEIGHT],

        // UintNote non-nullification proof
        balance_note_siloed_nullifier: Field,
        balance_low_nullifier_value: Field,
        balance_low_nullifier_next_value: Field,
        balance_low_nullifier_next_index: Field,
        balance_low_nullifier_leaf_index: Field,
        balance_low_nullifier_sibling_path: [Field; NULLIFIER_TREE_HEIGHT],

        // MigrationKeyNote fields
        key_note_storage_slot: Field,
        key_note_randomness: Field,
        key_note_nonce: Field,

        // MigrationKeyNote inclusion proof
        key_note_leaf_index: Field,
        key_note_sibling_path: [Field; NOTE_HASH_TREE_HEIGHT],

        // MigrationKeyNote non-nullification proof
        key_note_siloed_nullifier: Field,
        key_low_nullifier_value: Field,
        key_low_nullifier_next_value: Field,
        key_low_nullifier_next_index: Field,
        key_low_nullifier_leaf_index: Field,
        key_low_nullifier_sibling_path: [Field; NULLIFIER_TREE_HEIGHT],

        // Block header at snapshot height + archive proof
        archive_block_header: BlockHeader,
        archive_leaf_index: Field,
        archive_sibling_path: [Field; ARCHIVE_HEIGHT],
    ) {
        // 1. Call MigratorModeB to verify all proofs
        let _ = self.call(MigratorModeB::at(migrator_address).migrate_mode_b(
            msk,
            balance_note_owner,
            amount,
            balance_note_storage_slot,
            balance_note_randomness,
            balance_note_nonce,
            balance_note_leaf_index,
            balance_note_sibling_path,
            balance_note_siloed_nullifier,
            balance_low_nullifier_value,
            balance_low_nullifier_next_value,
            balance_low_nullifier_next_index,
            balance_low_nullifier_leaf_index,
            balance_low_nullifier_sibling_path,
            key_note_storage_slot,
            key_note_randomness,
            key_note_nonce,
            key_note_leaf_index,
            key_note_sibling_path,
            key_note_siloed_nullifier,
            key_low_nullifier_value,
            key_low_nullifier_next_value,
            key_low_nullifier_next_index,
            key_low_nullifier_leaf_index,
            key_low_nullifier_sibling_path,
            archive_block_header,
            archive_leaf_index,
            archive_sibling_path,
        ));

        // 2. Mint the migrated tokens to the user on the new rollup
        self.storage.balances.at(self.context.msg_sender().unwrap()).add(amount).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
    }
}
