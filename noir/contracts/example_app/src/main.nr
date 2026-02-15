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
        protocol_types::{
            address::AztecAddress, hash::poseidon2_hash, public_keys::PublicKeys, traits::Serialize,
        },
        state_vars::{owned::Owned, public_immutable::PublicImmutable},
    };
    use balance_set::balance_set::BalanceSet;
    use migration::{
        ArchiveArgs,
        mode_a::{FullMigrationNote, lock_migration_notes, migrate_notes_mode_a},
        mode_b::{FullKeyNote, FullNote, migrate_notes_mode_b},
        Point,
        Scalar,
    };
    use uint_note::uint_note::UintNote;

    #[storage]
    struct Storage<Context> {
        archive_root_address: PublicImmutable<AztecAddress, Context>,
        old_rollup_app_address: PublicImmutable<AztecAddress, Context>,
        // Token balances (using Aztec's BalanceSet for private balances)
        balances: Owned<BalanceSet<Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(
        archive_root_address: Option<AztecAddress>,
        old_rollup_app_address: Option<AztecAddress>,
    ) {
        assert(
            archive_root_address.is_some() == old_rollup_app_address.is_some(),
            "Must provide both old rollup app address and archive root address, or neither",
        );
        if archive_root_address.is_some() {
            self.storage.old_rollup_app_address.initialize(old_rollup_app_address.unwrap());
            self.storage.archive_root_address.initialize(archive_root_address.unwrap());
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

    /// Burn tokens from an account (for testing)
    #[external("private")]
    fn burn(from: AztecAddress, amount: u128) {
        self.storage.balances.at(from).sub(amount).deliver(MessageDelivery.CONSTRAINED_ONCHAIN);
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

    /// Claim a Mode A migration on the new rollup.
    ///
    /// Verifies the MigrationNote inclusion proof via `migrate_notes_mode_a`,
    /// checks that `amount` matches the locked `migration_data` hash, and mints
    /// the equivalent tokens to the caller.
    #[external("private")]
    fn migrate_mode_a(
        // Amount is not strictly needed for the migration (the proof of the MigrationNote is sufficient),
        // but including it in the arguments allows the contract to verify it matches the migration_data hash,
        // preventing mismatches between the old and new rollup states and mint the correct amount on the new rollup.
        amount: u128,
        // Authentication
        mpk: Point,
        signature: [u8; 64],
        //
        full_migration_notes: [FullMigrationNote; 1],
        //
        archive_args: ArchiveArgs,
    ) {
        // 1. Compute migration_data (must match what was stored in MigrationNote on old rollup)
        let serialized = amount.serialize();
        let migration_data = poseidon2_hash(serialized);

        assert(
            migration_data == full_migration_notes[0].migration_data,
            "Migration data hash mismatch",
        );

        let old_app = self.storage.old_rollup_app_address.read();

        migrate_notes_mode_a(
            self.context,
            self.storage.archive_root_address.read(),
            mpk,
            signature,
            old_app,
            full_migration_notes,
            archive_args,
        );

        // 4. If successful, mint the migrated tokens to the user on the new rollup
        self.storage.balances.at(self.context.msg_sender().unwrap()).add(amount).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
    }

    // ============================================================
    // Mode B: Emergency Snapshot Migration (on NEW rollup)
    // ============================================================

    /// Claim a Mode B (emergency snapshot) migration on the new rollup.
    ///
    /// Verifies note inclusion and non-nullification at the snapshot height via
    /// `migrate_notes_mode_b`, checks the sum of note values matches `amount`,
    /// and mints the equivalent tokens to the caller.
    #[external("private")]
    fn migrate_mode_b(
        amount: u128,
        // Authentication
        mpk: Point,
        signature: [u8; 64],
        //
        full_notes: [FullNote<UintNote>; 1],
        //
        archive_args: ArchiveArgs,
        //
        notes_owner: AztecAddress,
        //
        public_keys: PublicKeys,
        partial_address: Field,
        //
        full_key_note: FullKeyNote,
        //
        nsk: Scalar,
    ) {
        let old_app = self.storage.old_rollup_app_address.read();
        let sum = full_notes.fold(0, |acc, full_note| acc + full_note.note.value);
        assert(sum == amount, "Sum of migrated notes does not match the specified amount");
        // 1. Call MigratorModeB to verify all proofs
        migrate_notes_mode_b(
            self.context,
            self.storage.archive_root_address.read(),
            mpk,
            signature,
            old_app,
            full_notes,
            archive_args,
            notes_owner,
            public_keys,
            partial_address,
            full_key_note,
            nsk,
        );

        // 2. Mint the migrated tokens to the user on the new rollup
        self.storage.balances.at(self.context.msg_sender().unwrap()).add(amount).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
    }
}
