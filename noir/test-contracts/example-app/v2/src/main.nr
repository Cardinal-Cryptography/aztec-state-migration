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
        mode_a::{MigrationModeA, MigrationNoteProofData},
        mode_b::{
            FullL1ToL2MessageProofData, FullNoteProofData, KeyNoteProofData, MigrationModeB,
            PublicStateProofData,
        },
        Point,
        Scalar,
    };
    use balance_set::BalanceSet;
    use example_app_v1::ExampleMigrationAppV1::STORAGE_LAYOUT_ExampleMigrationAppV1;
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
        // --- Fields matching V1 storage layout (order must match for migration proofs) ---
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
        // --- V2-only fields (not present in V1) ---
        archive_registry_address: PublicImmutable<AztecAddress, Context>,
        old_rollup_app_address: PublicImmutable<AztecAddress, Context>,
        migration_block_number: PublicImmutable<u32, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(archive_registry_address: AztecAddress, old_rollup_app_address: AztecAddress) {
        self.storage.archive_registry_address.initialize(archive_registry_address);
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
    /// Verifies the MigrationNote inclusion proof via `migrate_notes_mode_a`
    /// and mints the equivalent tokens to the caller.
    #[external("private")]
    fn migrate_mode_a(
        mpk: Point,
        signature: MigrationSignature,
        note_proof_data: MigrationNoteProofData<u128>,
        block_header: BlockHeader,
    ) {
        // 1. Extract the amount from the proof data
        let amount = note_proof_data.data;

        // 2. Verify the proof and mark the MigrationNote as migrated
        let recipient = self.msg_sender();
        let old_app = self.storage.old_rollup_app_address.read();

        MigrationModeA::new(
            self.context,
            old_app,
            self.storage.archive_registry_address.read(),
            block_header,
            mpk,
        )
            .with_note(note_proof_data)
            .finish(recipient, signature);

        // 3. If successful, mint the migrated tokens to the user on the new rollup
        self.storage.balances.at(self.msg_sender()).add(amount).deliver(
            MessageDelivery.ONCHAIN_CONSTRAINED,
        );
    }

    /// Migrate tokens and claim to PUBLIC balance on new rollup.
    ///
    /// Same verification as migrate(), but mints to public balance instead of private.
    #[external("private")]
    fn migrate_to_public_mode_a(
        mpk: Point,
        signature: MigrationSignature,
        note_proof_data: MigrationNoteProofData<u128>,
        block_header: BlockHeader,
    ) {
        // 1. Extract the amount from the proof data
        let amount = note_proof_data.data;

        // 2. Verify the proof and mark the MigrationNote as migrated
        let recipient = self.msg_sender();
        let old_app = self.storage.old_rollup_app_address.read();
        MigrationModeA::new(
            self.context,
            old_app,
            self.storage.archive_registry_address.read(),
            block_header,
            mpk,
        )
            .with_note(note_proof_data)
            .finish(recipient, signature);

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
    /// `migrate_notes_mode_b` and creates a new note.
    #[external("private")]
    fn migrate_mode_b_at_snapshot(
        signature: MigrationSignature,
        full_proof_data: FullNoteProofData<UintNote>,
        block_header: BlockHeader,
        notes_owner: AztecAddress,
        public_keys: PublicKeys,
        partial_address: Field,
        key_note: KeyNoteProofData,
        nhk: Scalar,
    ) {
        let recipient = self.msg_sender();
        let old_app = self.storage.old_rollup_app_address.read();
        // The `expected_storage_slot` must reflect the `balances` field in the storage layout
        // of the V1 contract on the old rollup. We import V1's storage layout to get the correct slot.
        let balances_expected_storage_slot =
            STORAGE_LAYOUT_ExampleMigrationAppV1.fields.balances.slot;
        // 1. Extract the amount from the proof data
        let amount = full_proof_data.note_proof_data.data.value;
        // 2. Call MigrationModeB to verify all proofs
        MigrationModeB::new(
            self.context,
            old_app,
            self.storage.archive_registry_address.read(),
            block_header,
        )
            .with_notes_owner(notes_owner, key_note, public_keys, partial_address, nhk)
            .with_note(full_proof_data, balances_expected_storage_slot)
            .finish_at_snapshot(recipient, signature);

        // 3. Mint the migrated tokens to the user on the new rollup
        self.storage.balances.at(recipient).add(amount).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
    }

    // ============================================================
    // Mode B: App specific block number Migration
    // ============================================================

    /// Claim a Mode B (app specific block number) migration on the new rollup.
    ///
    /// Verifies note inclusion and non-nullification at the specified block number via
    /// `migrate_notes_mode_b` and creates a new note.
    #[external("private")]
    fn migrate_mode_b_at_block(
        signature: MigrationSignature,
        full_proof_data: FullNoteProofData<UintNote>,
        block_header: BlockHeader,
        notes_owner: AztecAddress,
        public_keys: PublicKeys,
        partial_address: Field,
        key_note: KeyNoteProofData,
        nhk: Scalar,
    ) {
        let recipient = self.msg_sender();
        let old_app = self.storage.old_rollup_app_address.read();
        // The `expected_storage_slot` must reflect the `balances` field in the storage layout
        // of the V1 contract on the old rollup. We import V1's storage layout to get the correct slot.
        let balances_expected_storage_slot =
            STORAGE_LAYOUT_ExampleMigrationAppV1.fields.balances.slot;
        // 1. Extract the amount from the proof data
        let amount = full_proof_data.note_proof_data.data.value;
        // 2. Call MigrationModeB to verify all proofs
        MigrationModeB::new(
            self.context,
            old_app,
            self.storage.archive_registry_address.read(),
            block_header,
        )
            .with_notes_owner(notes_owner, key_note, public_keys, partial_address, nhk)
            .with_note(full_proof_data, balances_expected_storage_slot)
            .finish_at_block(recipient, signature, self.storage.migration_block_number.read());

        // 3. Mint the migrated tokens to the user on the new rollup
        self.storage.balances.at(recipient).add(amount).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
    }

    // ============================================================
    // Mode B: Unconsumed L1-to-L2 message migration
    // ============================================================

    /// Migrate an unconsumed L1-to-L2 message from the old rollup.
    ///
    /// Verifies the message existed in the old rollup's L1-to-L2 message tree
    /// and was not consumed, then credits the message content as balance.
    #[external("private")]
    fn migrate_l1_to_l2_message_mode_b(
        message_proof: FullL1ToL2MessageProofData,
        secret: Field,
        block_header: BlockHeader,
    ) {
        let recipient = self.msg_sender();
        let old_app = self.storage.old_rollup_app_address.read();

        MigrationModeB::new(
            self.context,
            old_app,
            self.storage.archive_registry_address.read(),
            block_header,
        )
            .without_owner()
            .with_l1_to_l2_message(message_proof, secret)
            .finish_at_snapshot();

        // Credit the message content as balance
        let amount = message_proof.message_proof_data.content as u128;
        self.storage.balances.at(recipient).add(amount).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
    }

    #[external("private")]
    fn migrate_to_public_struct_mode_b(
        struct_single_proof_data: PublicStateProofData<SomeStruct, 2>,
        block_header: BlockHeader,
    ) {
        let struct_single = struct_single_proof_data.data;
        let struct_single_slot = STORAGE_LAYOUT_ExampleMigrationAppV1.fields.struct_single.slot;
        MigrationModeB::new(
            self.context,
            self.storage.old_rollup_app_address.read(),
            self.storage.archive_registry_address.read(),
            block_header,
        )
            .without_owner()
            .with_public_state(struct_single_proof_data, struct_single_slot)
            .finish_at_snapshot();

        ExampleMigrationAppV2::at(self.context.this_address())
            .init_struct_single(struct_single)
            .enqueue(self.context);
    }

    #[external("private")]
    fn migrate_to_public_struct_map_mode_b(
        struct_in_map_proof_data: PublicStateProofData<SomeStruct, 2>,
        block_header: BlockHeader,
        map_key: Field,
    ) {
        let struct_in_map = struct_in_map_proof_data.data;
        let struct_in_map_slot = STORAGE_LAYOUT_ExampleMigrationAppV1.fields.struct_map.slot;
        MigrationModeB::new(
            self.context,
            self.storage.old_rollup_app_address.read(),
            self.storage.archive_registry_address.read(),
            block_header,
        )
            .without_owner()
            .with_public_map_state(struct_in_map_proof_data, struct_in_map_slot, [map_key])
            .finish_at_snapshot();
        ExampleMigrationAppV2::at(self.context.this_address())
            .init_struct_map(map_key, struct_in_map)
            .enqueue(self.context);
    }

    #[external("private")]
    fn migrate_to_public_owned_struct_map_mode_b(
        owned_struct_map_proof_data: PublicStateProofData<SomeStruct, 2>,
        block_header: BlockHeader,
        old_owner: AztecAddress,
        signature: MigrationSignature,
        key_note: KeyNoteProofData,
    ) {
        let recipient = self.msg_sender();
        let owned_struct = owned_struct_map_proof_data.data;
        let owner_struct_map_slot =
            STORAGE_LAYOUT_ExampleMigrationAppV1.fields.owned_struct_map.slot;
        MigrationModeB::new(
            self.context,
            self.storage.old_rollup_app_address.read(),
            self.storage.archive_registry_address.read(),
            block_header,
        )
            .with_owner(old_owner, key_note)
            .with_public_map_state(owned_struct_map_proof_data, owner_struct_map_slot, [old_owner])
            .finish_at_snapshot(recipient, signature);
        ExampleMigrationAppV2::at(self.context.this_address())
            ._set_owned_struct_map(recipient, owned_struct)
            .enqueue(self.context);
    }

    #[external("private")]
    fn migrate_to_public_owned_struct_nested_map_mode_b(
        owned_struct_nested_map_proof_data: PublicStateProofData<SomeStruct, 2>,
        block_header: BlockHeader,
        old_owner: AztecAddress,
        signature: MigrationSignature,
        key_note: KeyNoteProofData,
        map_key: Field,
    ) {
        let recipient = self.msg_sender();
        let owned_struct = owned_struct_nested_map_proof_data.data;
        let owned_struct_nested_map_slot =
            STORAGE_LAYOUT_ExampleMigrationAppV1.fields.owned_struct_nested_map.slot;
        MigrationModeB::new(
            self.context,
            self.storage.old_rollup_app_address.read(),
            self.storage.archive_registry_address.read(),
            block_header,
        )
            .with_owner(old_owner, key_note)
            .with_public_map_state(
                owned_struct_nested_map_proof_data,
                owned_struct_nested_map_slot,
                [map_key, old_owner.to_field()],
            )
            .finish_at_snapshot(recipient, signature);
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
    fn set_migration_block_number(migration_block_number: u32) {
        self.storage.migration_block_number.initialize(migration_block_number);
    }

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
