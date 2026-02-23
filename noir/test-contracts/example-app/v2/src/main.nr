use aztec::macros::aztec;

/// V2 of the example migration-aware token contract.
///
/// Deployed on the NEW rollup. Supports migration claim functions
/// for both Mode A (routine lock-and-claim) and Mode B (emergency snapshot).
#[aztec]
pub contract ExampleMigrationAppV2 {
    use aztec::{
        macros::{functions::{external, initializer, only_self}, storage::storage},
        messages::message_delivery::MessageDelivery,
        protocol::{
            address::AztecAddress,
            public_keys::PublicKeys,
            traits::{Deserialize, Packable, Serialize, ToField},
        },
        state_vars::{Map, Owned, PublicImmutable, PublicMutable},
    };
    use aztec::protocol::abis::block_header::BlockHeader;
    use aztec_state_migration::{
        MigrationSignature,
        mode_a::{migrate_notes_mode_a, MigrationNoteProofData},
        mode_b::{
            FullNoteProofData, KeyNoteProofData, migrate_notes_mode_b,
            migrate_public_map_owned_state_mode_b, migrate_public_map_state_mode_b,
            migrate_public_state_mode_b, PublicStateProofData,
        },
        Point,
        Scalar,
    };
    use balance_set::BalanceSet;
    use uint_note::UintNote;

    // Only Packable needed for Migration
    // Serialize and Deserialize because it's used as argument
    #[derive(Packable, Deserialize, Serialize)]
    pub struct SomeStruct {
        a: u128,
        b: AztecAddress,
    }

    #[storage]
    struct Storage<Context> {
        archive_root_address: PublicImmutable<AztecAddress, Context>,
        old_rollup_app_address: PublicImmutable<AztecAddress, Context>,
        // Token balances (using Aztec's BalanceSet for private balances)
        balances: Owned<BalanceSet<Context>, Context>,
        // Public token balances
        public_balances: Map<AztecAddress, PublicMutable<u128, Context>, Context>,
        // Some public struct
        struct_single: PublicMutable<SomeStruct, Context>,
        struct_map: Map<Field, PublicMutable<SomeStruct, Context>, Context>,
        // Map with some struct where the key is the owner (to show migration of public map state with ownership)
        owned_struct_map: Map<AztecAddress, PublicMutable<SomeStruct, Context>, Context>,
        //
        owned_struct_nested_map: Map<Field, Map<AztecAddress, PublicMutable<SomeStruct, Context>, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(archive_root_address: AztecAddress, old_rollup_app_address: AztecAddress) {
        self.storage.archive_root_address.initialize(archive_root_address);
        self.storage.old_rollup_app_address.initialize(old_rollup_app_address);
    }

    // ============================================================
    // Standard token operations
    // ============================================================

    /// Mint tokens to an account (for testing)
    #[external("private")]
    fn mint(to: AztecAddress, amount: u128) {
        self.storage.balances.at(to).add(amount).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
    }

    /// Burn tokens from an account (for testing)
    #[external("private")]
    fn burn(from: AztecAddress, amount: u128) {
        self.storage.balances.at(from).sub(amount).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
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
        ExampleMigrationAppV2::at(self.context.this_address())
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
        assert(self.msg_sender() == self.context.this_address(), "Only callable internally");
        let current = self.storage.public_balances.at(owner).read();
        self.storage.public_balances.at(owner).write(current + amount);
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
        block_header: BlockHeader,
    ) {
        // FIXME: No need for `amount` argument; duplicate of `note_proof_data[0].data`
        let amount_from_data = note_proof_data[0].data;
        // 1. Compute migration_data (must match what was stored in MigrationNote on old rollup)
        assert(amount_from_data == amount, "Migration data hash mismatch");

        let recipient = self.msg_sender();
        let old_app = self.storage.old_rollup_app_address.read();

        migrate_notes_mode_a(
            self.context,
            self.storage.archive_root_address.read(),
            mpk,
            signature,
            recipient,
            old_app,
            note_proof_data,
            block_header,
        );

        // 4. If successful, mint the migrated tokens to the user on the new rollup
        self.storage.balances.at(self.msg_sender()).add(amount).deliver(
            MessageDelivery.ONCHAIN_CONSTRAINED,
        );
    }

    /// Migrate tokens and claim to PUBLIC balance on new rollup.
    ///
    /// Same verification as migrate(), but mints to public balance instead of private.
    #[external("private")]
    fn migrate_to_public_mode_a(
        amount: u128,
        mpk: Point,
        signature: MigrationSignature,
        note_proof_data: [MigrationNoteProofData<u128>; 1],
        block_header: BlockHeader,
    ) {
        // FIXME: No need for `amount` argument; duplicate of `note_proof_data[0].data`
        let amount_from_data = note_proof_data[0].data;
        // 1. Compute migration_data (must match what was stored in MigrationNote on old rollup)
        assert(amount_from_data == amount, "Migration data hash mismatch");

        // 2. Call Migrator to verify the proof and mark the MigrationNote as migrated
        let recipient = self.msg_sender();
        let old_app = self.storage.old_rollup_app_address.read();
        migrate_notes_mode_a(
            self.context,
            self.storage.archive_root_address.read(),
            mpk,
            signature,
            recipient,
            old_app,
            note_proof_data,
            block_header,
        );

        // 3. Mint to PUBLIC balance (instead of private)
        let recipient = self.msg_sender();
        ExampleMigrationAppV2::at(self.context.this_address())
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
        block_header: BlockHeader,
        //
        notes_owner: AztecAddress,
        //
        public_keys: PublicKeys,
        partial_address: Field,
        //
        key_note: KeyNoteProofData,
        //
        nhk: Scalar,
    ) {
        let recipient = self.msg_sender();
        let old_app = self.storage.old_rollup_app_address.read();
        // The `expected_storage_slot` should reflect the `balances` field in the storage layout
        // of the contract on the old rollup. Here we just use the same storage layout as this contract
        // is used in test on "old rollup" and "new rollup".
        let balances_expected_storage_slot =
            STORAGE_LAYOUT_ExampleMigrationAppV2.fields.balances.slot;
        let sum = full_proof_data.fold(0, |acc, full_note_proof_data| {
            acc + full_note_proof_data.note_proof_data.data.value
        });
        assert(sum == amount, "Sum of migrated notes does not match the specified amount");
        // 1. Call MigratorModeB to verify all proofs
        migrate_notes_mode_b(
            self.context,
            self.storage.archive_root_address.read(),
            signature,
            recipient,
            old_app,
            full_proof_data,
            balances_expected_storage_slot,
            block_header,
            notes_owner,
            public_keys,
            partial_address,
            key_note,
            nhk,
        );

        // 2. Mint the migrated tokens to the user on the new rollup
        self.storage.balances.at(recipient).add(amount).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
    }

    #[external("private")]
    fn migrate_to_public_struct_mode_b(
        // the number of occupied slots (2) is asserted in the migration function:
        // std::static_assert(<T as Packable>::N == N),
        // where in this example T=SomeStruct and N=<SomeStruct as Packable>::N.
        // The app developer will get compile-time errors if the proof data length doesn't match the struct packing.
        struct_single_proof_data: PublicStateProofData<SomeStruct, 2>,
        block_header: BlockHeader,
    ) {
        // in this example we use struct to show that we can migrate any public state, not just balances.
        // In a real token contract, this would likely still be `amount: u128`.
        let struct_single = struct_single_proof_data.data;
        migrate_public_state_mode_b(
            self.context,
            self.storage.archive_root_address.read(),
            self.storage.old_rollup_app_address.read(),
            struct_single_proof_data,
            // The `base_storage_slot` should reflect the `struct_single` field in the storage layout
            // of the contract on the old rollup.
            STORAGE_LAYOUT_ExampleMigrationAppV2.fields.struct_single.slot,
            block_header,
        );
        ExampleMigrationAppV2::at(self.context.this_address())
            .init_struct_single(struct_single)
            .enqueue(self.context);
    }

    #[external("private")]
    fn migrate_to_public_struct_map_mode_b(
        // the number of occupied slots (2) is asserted in the migration function:
        // std::static_assert(<T as Packable>::N == N),
        // where in this example T=SomeStruct and N=<SomeStruct as Packable>::N.
        // The app developer will get compile-time errors if the proof data length doesn't match the struct packing.
        struct_in_map_proof_data: PublicStateProofData<SomeStruct, 2>,
        block_header: BlockHeader,
        map_key: Field,
    ) {
        // in this example we use struct to show that we can migrate any public state, not just balances.
        // In a real token contract, this would likely still be `amount: u128`.
        let struct_in_map = struct_in_map_proof_data.data;
        migrate_public_map_state_mode_b(
            self.context,
            self.storage.archive_root_address.read(),
            self.storage.old_rollup_app_address.read(),
            struct_in_map_proof_data,
            // The `expected_storage_slot` should reflect the `struct_map` field in the storage layout
            // of the contract on the old rollup.
            STORAGE_LAYOUT_ExampleMigrationAppV2.fields.struct_map.slot,
            block_header,
            [map_key],
        );
        ExampleMigrationAppV2::at(self.context.this_address())
            .init_struct_map(map_key, struct_in_map)
            .enqueue(self.context);
    }

    #[external("private")]
    fn migrate_to_public_owned_struct_map_mode_b(
        // the number of occupied slots (2) is asserted in the migration function:
        // std::static_assert(<T as Packable>::N == N),
        // where in this example T=SomeStruct and N=<SomeStruct as Packable>::N.
        // The app developer will get compile-time errors if the proof data length doesn't match the struct packing.
        owned_struct_map_proof_data: PublicStateProofData<SomeStruct, 2>,
        block_header: BlockHeader,
        old_owner: AztecAddress,
        signature: MigrationSignature,
        key_note: KeyNoteProofData,
    ) {
        let recipient = self.msg_sender();
        // in this example we use struct to show that we can migrate any public state, not just balances.
        // In a real token contract, this would likely still be `amount: u128`.
        let owned_struct = owned_struct_map_proof_data.data;
        migrate_public_map_owned_state_mode_b(
            self.context,
            self.storage.archive_root_address.read(),
            self.storage.old_rollup_app_address.read(),
            owned_struct_map_proof_data,
            // The `expected_storage_slot` should reflect the `owned_struct_map` field in the storage layout
            // of the contract on the old rollup.
            STORAGE_LAYOUT_ExampleMigrationAppV2.fields.owned_struct_map.slot,
            block_header,
            [old_owner],
            old_owner,
            signature,
            recipient,
            key_note,
        );
        ExampleMigrationAppV2::at(self.context.this_address())
            ._set_owned_struct_map(recipient, owned_struct)
            .enqueue(self.context);
    }

    #[external("private")]
    fn migrate_to_public_owned_struct_nested_map_mode_b(
        // the number of occupied slots (2) is asserted in the migration function:
        // std::static_assert(<T as Packable>::N == N),
        // where in this example T=SomeStruct and N=<SomeStruct as Packable>::N.
        // The app developer will get compile-time errors if the proof data length doesn't match the struct packing.
        owned_struct_nested_map_proof_data: PublicStateProofData<SomeStruct, 2>,
        block_header: BlockHeader,
        old_owner: AztecAddress,
        signature: MigrationSignature,
        key_note: KeyNoteProofData,
        map_key: Field,
    ) {
        let recipient = self.msg_sender();
        // in this example we use struct to show that we can migrate any public state, not just balances.
        // In a real token contract, this would likely still be `amount: u128`.
        let owned_struct = owned_struct_nested_map_proof_data.data;
        migrate_public_map_owned_state_mode_b(
            self.context,
            self.storage.archive_root_address.read(),
            self.storage.old_rollup_app_address.read(),
            owned_struct_nested_map_proof_data,
            // The `expected_storage_slot` should reflect the `owned_struct_nested_map` field in the storage layout
            // of the contract on the old rollup.
            STORAGE_LAYOUT_ExampleMigrationAppV2.fields.owned_struct_nested_map.slot,
            block_header,
            [map_key, old_owner.to_field()],
            old_owner,
            signature,
            recipient,
            key_note,
        );
        ExampleMigrationAppV2::at(self.context.this_address())
            ._set_owned_struct_nested_map(recipient, map_key, owned_struct)
            .enqueue(self.context);
    }

    #[external("public")]
    #[only_self]
    fn _set_owned_struct_map(owner: AztecAddress, some_struct: SomeStruct) {
        self.storage.owned_struct_map.at(owner).write(some_struct);
    }

    #[external("public")]
    #[only_self]
    fn _set_owned_struct_nested_map(owner: AztecAddress, map_key: Field, some_struct: SomeStruct) {
        self.storage.owned_struct_nested_map.at(map_key).at(owner).write(some_struct);
    }

    // ============================================================
    // Test helpers
    // ============================================================

    #[external("public")]
    fn init_struct_single(some_struct: SomeStruct) {
        self.storage.struct_single.write(some_struct);
    }

    #[external("public")]
    fn init_struct_map(map_key: Field, some_struct: SomeStruct) {
        self.storage.struct_map.at(map_key).write(some_struct);
    }

    #[external("public")]
    fn init_owned_struct_map(some_struct: SomeStruct) {
        self.storage.owned_struct_map.at(self.msg_sender()).write(some_struct);
    }

    #[external("public")]
    fn init_owned_struct_nested_map(map_key: Field, some_struct: SomeStruct) {
        self.storage.owned_struct_nested_map.at(map_key).at(self.msg_sender()).write(some_struct);
    }

    #[external("utility")]
    unconstrained fn get_struct_single() -> SomeStruct {
        self.storage.struct_single.read()
    }

    #[external("utility")]
    unconstrained fn get_struct_map(map_key: Field) -> SomeStruct {
        self.storage.struct_map.at(map_key).read()
    }

    #[external("utility")]
    unconstrained fn get_owned_struct_map(owner: AztecAddress) -> SomeStruct {
        self.storage.owned_struct_map.at(owner).read()
    }

    #[external("utility")]
    unconstrained fn get_owned_struct_nested_map(
        map_key: Field,
        owner: AztecAddress,
    ) -> SomeStruct {
        self.storage.owned_struct_nested_map.at(map_key).at(owner).read()
    }
}
