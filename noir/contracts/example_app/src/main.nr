use aztec::macros::aztec;

/// Example migration-aware token contract.
///
/// This contract demonstrates how to implement Mode A locking on the OLD rollup.
/// Users call `lock_for_migration()` to:
/// 1. Nullify their original token note
/// 2. Create a MigrationLockNote that can be proven on the new rollup
#[aztec]
pub contract ExampleMigrationApp {
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        messages::message_delivery::MessageDelivery,
        protocol_types::{
            abis::block_header::BlockHeader, address::AztecAddress, hash::poseidon2_hash,
            traits::Serialize,
        },
        state_vars::{owned::Owned, public_immutable::PublicImmutable},
    };
    use balance_set::balance_set::BalanceSet;
    use migrator::{ARCHIVE_HEIGHT, Migrator, NOTE_HASH_TREE_HEIGHT};

    #[storage]
    struct Storage<Context> {
        old_rollup_app_address: PublicImmutable<AztecAddress, Context>,
        // Token balances (using Aztec's BalanceSet for private balances)
        balances: Owned<BalanceSet<Context>, Context>,
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
    // Mode A: Lock for Migration (on OLD rollup)
    // ============================================================

    /// Lock a token note for migration to a new rollup.
    ///
    /// This function:
    /// 1. Takes a UintNote from the caller's balance
    /// 2. Nullifies the original note (preventing double-spend)
    /// 3. Creates a MigrationLockNote that can be proven on the destination rollup
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

        // 3. Call Migrator contract to create and store the MigrationLockNote
        let _ = self.call(Migrator::at(migrator_address).lock_migration_note(
            note_owner,
            destination_rollup,
            owner_msk,
            migration_data,
        ));

        // The lock note is now in the note hash tree and can be proven
        // on the new rollup using migrate_via_proof()
    }

    // ============================================================
    // Mode A: Migrate via Proof (on NEW rollup)
    // ============================================================

    #[external("private")]
    fn migrate_via_proof(
        migrator_address: AztecAddress,
        // migration secret key
        msk: Field,
        // MigrationLockNote fields
        amount: u128,
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
        // 1. Compute migration_data (must match what was stored in MigrationLockNote on old rollup)
        let serialized = amount.serialize();
        let migration_data = poseidon2_hash(serialized);

        // 2. Call Migrator to verify the proof and mark the MigrationLockNote as migrated
        let lock_note_creator = self.storage.old_rollup_app_address.read();
        let _ = self.call(Migrator::at(migrator_address).migrate_via_proof(
            msk,
            lock_note_creator, // lock_note_creator is the OLD app that called lock_migration_note
            migration_data,
            lock_note_storage_slot,
            lock_note_randomness,
            lock_note_nonce,
            lock_note_hash_leaf_index,
            lock_note_hash_sibling_path,
            archive_block_header,
            archive_leaf_index,
            archive_sibling_path,
        ));

        // 3. If successful, mint the migrated tokens to the user on the new rollup
        self.storage.balances.at(self.context.msg_sender().unwrap()).add(amount).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
    }
}
