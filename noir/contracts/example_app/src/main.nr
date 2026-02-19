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
        protocol_types::{address::AztecAddress, public_keys::PublicKeys},
        state_vars::{
            map::Map, owned::Owned, public_immutable::PublicImmutable,
            public_mutable::PublicMutable,
        },
    };
    use balance_set::balance_set::BalanceSet;
    use migration::{
        ArchiveProofData,
        MigrationSignature,
        mode_a::{lock_migration_notes, migrate_notes_mode_a, MigrationNoteProofData},
        mode_b::{FullNoteProofData, KeyNoteProofData, migrate_notes_mode_b},
        NoteProofData,
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
        // Public token balances
        public_balances: Map<AztecAddress, PublicMutable<u128, Context>, Context>,
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
    fn lock_migration_notes_mode_a(amount: u128, destination_rollup: Field, mpk: Point) {
        let note_owner = self.context.msg_sender().unwrap();

        self.storage.balances.at(note_owner).sub(amount).deliver(MessageDelivery.CONSTRAINED_ONCHAIN);

        lock_migration_notes(self.context, note_owner, destination_rollup, mpk, [amount]);
    }

    /// Lock a public token balance for migration to a new rollup.
    ///
    /// This function:
    /// 1. Creates a MigrationNote (identical to private lock) in the Migrator
    /// 2. Enqueues a public function to decrement the user's public balance
    ///
    /// The MigrationNote is the same as for private locks, so the claim circuit is unchanged.
    #[external("private")]
    fn lock_public_for_migration(amount: u128, destination_rollup: Field, mpk: Point) {
        let note_owner = self.context.msg_sender().unwrap();

        lock_migration_notes(self.context, note_owner, destination_rollup, mpk, [amount]);

        // 3. Enqueue public balance decrement (executes after private phase)
        //    If this fails (insufficient balance), the entire tx reverts including the MigrationNote
        ExampleMigrationApp::at(self.context.this_address())
            ._decrement_public_balance(note_owner, amount)
            .enqueue(self.context);
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
        // but including it in the arguments allows the contract to verify it matches the migration data hash,
        // and mint the correct amount of tokens to the user.
        amount: u128,
        // Authentication
        mpk: Point,
        signature: MigrationSignature,
        //
        note_proof_data: [MigrationNoteProofData<u128>; 1],
        //
        archive_proof_data: ArchiveProofData,
    ) {
        // FIXME: No need for `amount` argument; duplicate of `note_proof_data[0].data`
        let amount_from_data = note_proof_data[0].data;
        // 1. Compute migration_data (must match what was stored in MigrationNote on old rollup)
        assert(amount_from_data == amount, "Migration data hash mismatch");

        let old_app = self.storage.old_rollup_app_address.read();

        migrate_notes_mode_a(
            self.context,
            self.storage.archive_root_address.read(),
            mpk,
            signature,
            old_app,
            note_proof_data,
            archive_proof_data,
        );

        // 4. If successful, mint the migrated tokens to the user on the new rollup
        self.storage.balances.at(self.context.msg_sender().unwrap()).add(amount).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
    }

    /// Migrate tokens and claim to PUBLIC balance on new rollup.
    ///
    /// Same verification as migrate(), but mints to public balance instead of private.
    #[external("private")]
    fn migrate_to_public(
        amount: u128,
        mpk: Point,
        signature: MigrationSignature,
        note_proof_data: [NoteProofData<u128>; 1],
        archive_proof_data: ArchiveProofData,
    ) {
        // FIXME: No need for `amount` argument; duplicate of `note_proof_data[0].data`
        let amount_from_data = note_proof_data[0].data;
        // 1. Compute migration_data (must match what was stored in MigrationNote on old rollup)
        assert(amount_from_data == amount, "Migration data hash mismatch");

        // 2. Call Migrator to verify the proof and mark the MigrationNote as migrated
        let old_app = self.storage.old_rollup_app_address.read();
        migrate_notes_mode_a(
            self.context,
            self.storage.archive_root_address.read(),
            mpk,
            signature,
            old_app,
            note_proof_data,
            archive_proof_data,
        );

        // 3. Mint to PUBLIC balance (instead of private)
        let recipient = self.context.msg_sender().unwrap();
        ExampleMigrationApp::at(self.context.this_address())
            ._increment_public_balance(recipient, amount)
            .enqueue(self.context);
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
        signature: MigrationSignature,
        //
        full_proof_data: [FullNoteProofData<UintNote>; 1],
        //
        archive_proof_data: ArchiveProofData,
        //
        notes_owner: AztecAddress,
        //
        public_keys: PublicKeys,
        partial_address: Field,
        //
        key_note: KeyNoteProofData,
        //
        nsk: Scalar,
    ) {
        let old_app = self.storage.old_rollup_app_address.read();
        // The `expected_storage_slot` should reflect the `balances` field in the storage layout
        // of the contract on the old rollup. Here we just use the same storage layout as this contract
        // is used in test on "old rollup" and "new rollup".
        let balances_expected_storage_slot =
            STORAGE_LAYOUT_ExampleMigrationApp.fields.balances.slot;
        let sum = full_proof_data.fold(0, |acc, full_note_proof_data| {
            acc + full_note_proof_data.note_proof_data.data.value
        });
        assert(sum == amount, "Sum of migrated notes does not match the specified amount");
        // 1. Call MigratorModeB to verify all proofs
        migrate_notes_mode_b(
            self.context,
            self.storage.archive_root_address.read(),
            signature,
            old_app,
            full_proof_data,
            balances_expected_storage_slot,
            archive_proof_data,
            notes_owner,
            public_keys,
            partial_address,
            key_note,
            nsk,
        );

        // 2. Mint the migrated tokens to the user on the new rollup
        self.storage.balances.at(self.context.msg_sender().unwrap()).add(amount).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
    }
}
