use aztec::macros::aztec;

/// Example migration-aware token contract.
///
/// Supports both Mode A (routine lock-and-claim) and Mode B (emergency snapshot) migration.
///
/// Mode A: Users call `lock_migration_notes_mode_a()` on old rollup, then `migrate_mode_a()` on new rollup.
/// Mode B: Users prove note existence + non-nullification at snapshot height H.
#[aztec]
pub contract ExampleMigrationApp {
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        messages::message_delivery::MessageDelivery,
        protocol_types::{address::AztecAddress, hash::poseidon2_hash, traits::Serialize, constants::{ARCHIVE_HEIGHT, NOTE_HASH_TREE_HEIGHT}, abis::block_header::BlockHeader,},
        state_vars::{owned::Owned, public_immutable::PublicImmutable},
    };
    use balance_set::balance_set::BalanceSet;
    use migrator_mode_a::{
        mode_a::{FullMigrationNote, migrate_notes, lock_migration_notes, MigrationArgs, Point}
    };
    use migrator_mode_b::{MigratorModeB, NULLIFIER_TREE_HEIGHT};

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
    /// 3. Creates a MigrationNote that can be proven on the destination rollup
    #[external("private")]
    fn lock_migration_notes_mode_a(amount: u128, destination_rollup: Field, mpk: Point) {
        let note_owner = self.context.msg_sender().unwrap();

        // 1. Subtract from balance (this nullifies notes internally)
        //    The BalanceSet handles note selection and nullification
        //    We don't need to deliver since we're locking, not transferring
        let _ = self.storage.balances.at(note_owner).sub(amount);

        // 2. Compute migration data
        let serialized = amount.serialize();
        let migration_data = poseidon2_hash(serialized);

        lock_migration_notes(
            self.context,
            note_owner,
            destination_rollup,
            mpk,
            [migration_data],
        );
    }

    // ============================================================
    // Mode A: Migrate via Proof (on NEW rollup)
    // ============================================================

    #[external("private")]
    fn migrate_mode_a(
        // Amount is not strictly needed for the migration (the proof of the MigrationNote is sufficient),
        // but including it in the arguments allows the contract to verify it matches the migration_data hash,
        // preventing mismatches between the old and new rollup states and mint the correct amount on the new rollup.
        amount: u128,
        // Address of the Migrator on the new rollup
        migrator_address: AztecAddress,
        // Migration arguments
        migration_args: MigrationArgs,
        //
        full_migration_note: FullMigrationNote,
    ) {
        // 1. Compute migration_data (must match what was stored in MigrationNote on old rollup)
        let serialized = amount.serialize();
        let migration_data = poseidon2_hash(serialized);

        assert(
            migration_data == full_migration_note.migration_data,
            "Migration data hash mismatch",
        );

        let old_app_address = self.storage.old_rollup_app_address.read();

        migrate_notes(
            self.context,
            migrator_address,
            old_app_address,
            [full_migration_note],
            migration_args,
        );

        // 4. If successful, mint the migrated tokens to the user on the new rollup
        self.storage.balances.at(self.context.msg_sender().unwrap()).add(amount).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
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
