use aztec::macros::aztec;

/// V2 of the ERC20-like token migration contract.
///
/// Deployed on the NEW rollup.
/// Implements the ERC-20 core of AIP-20 (balances, transfers, mint, burn, authwit, metadata views).
/// Omits: commitment-based transfers (PartialUintNote), upgrade mechanism, vault/ERC-4626.
/// Adds: Mode A claims (migrate_mode_a, migrate_to_public_mode_a),
///       Mode B claims (migrate_mode_b, migrate_public_balance_mode_b).
#[aztec]
pub contract TokenMigrationAppV2 {
    use aztec::{
        authwit::auth::{
            assert_current_call_valid_authwit, assert_current_call_valid_authwit_public,
        },
        context::PrivateContext,
        macros::{functions::{external, initializer, internal, only_self, view}, storage::storage},
        messages::message_delivery::MessageDelivery,
        protocol::{abis::block_header::BlockHeader, address::AztecAddress, public_keys::PublicKeys},
        state_vars::{Map, Owned, PublicImmutable, PublicMutable},
    };
    use aztec_state_migration::{
        MigrationSignature,
        mode_a::{MigrationModeA, MigrationNoteProofData},
        mode_b::{FullNoteProofData, KeyNoteProofData, MigrationModeB, PublicStateProofData},
        Point,
        Scalar,
    };
    use balance_set::BalanceSet;
    use compressed_string::FieldCompressedString;
    use token_migration_app_v1::TokenMigrationAppV1::STORAGE_LAYOUT_TokenMigrationAppV1;
    use uint_note::UintNote;

    // Gas-optimized max notes for initial transfer call
    global INITIAL_TRANSFER_CALL_MAX_NOTES: u32 = 2;
    // Max notes transfer for recursive transfer call
    global RECURSIVE_TRANSFER_CALL_MAX_NOTES: u32 = 8;

    #[storage]
    struct Storage<Context> {
        // --- Fields matching V1 storage layout (order must match for migration proofs) ---
        name: PublicImmutable<FieldCompressedString, Context>,
        symbol: PublicImmutable<FieldCompressedString, Context>,
        decimals: PublicImmutable<u8, Context>,
        private_balances: Owned<BalanceSet<Context>, Context>,
        total_supply: PublicMutable<u128, Context>,
        public_balances: Map<AztecAddress, PublicMutable<u128, Context>, Context>,
        minter: PublicImmutable<AztecAddress, Context>,
        // --- V2-only fields (not present in V1) ---
        archive_root_address: PublicImmutable<AztecAddress, Context>,
        old_rollup_app_address: PublicImmutable<AztecAddress, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(
        name: str<31>,
        symbol: str<31>,
        decimals: u8,
        minter: AztecAddress,
        archive_root_address: AztecAddress,
        old_rollup_app_address: AztecAddress,
    ) {
        self.storage.name.initialize(FieldCompressedString::from_string(name));
        self.storage.symbol.initialize(FieldCompressedString::from_string(symbol));
        self.storage.decimals.initialize(decimals);
        self.storage.minter.initialize(minter);
        self.storage.archive_root_address.initialize(archive_root_address);
        self.storage.old_rollup_app_address.initialize(old_rollup_app_address);
    }

    // ============================================================
    // Private functions
    // ============================================================

    /// Transfer tokens from private balance to public balance
    #[external("private")]
    fn transfer_private_to_public(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        _nonce: Field,
    ) {
        _validate_from_private::<4>(self.context, from);
        self.internal._decrease_private_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);
        self.enqueue_self.increase_public_balance_internal(to, amount);
    }

    /// Transfer tokens from private balance to another private balance
    #[external("private")]
    fn transfer_private_to_private(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        _nonce: Field,
    ) {
        _validate_from_private::<4>(self.context, from);
        self.internal._decrease_private_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);
        self.internal._increase_private_balance(to, amount);
    }

    /// Transfer tokens from public balance to private balance
    #[external("private")]
    fn transfer_public_to_private(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        _nonce: Field,
    ) {
        _validate_from_private::<4>(self.context, from);
        self.enqueue_self.decrease_public_balance_internal(from, amount);
        self.internal._increase_private_balance(to, amount);
    }

    /// Recursively subtracts balance from private balance
    #[external("private")]
    #[only_self]
    fn recurse_subtract_balance_internal(account: AztecAddress, amount: u128) -> u128 {
        self.internal._subtract_balance(account, amount, RECURSIVE_TRANSFER_CALL_MAX_NOTES)
    }

    // ============================================================
    // Public functions
    // ============================================================

    /// Transfer tokens from public balance to public balance
    #[external("public")]
    fn transfer_public_to_public(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        _nonce: Field,
    ) {
        self.internal._validate_from_public(from);
        self.internal._decrease_public_balance(from, amount);
        self.internal._increase_public_balance(to, amount);
    }

    #[external("public")]
    #[only_self]
    fn increase_public_balance_internal(to: AztecAddress, amount: u128) {
        self.internal._increase_public_balance(to, amount);
    }

    #[external("public")]
    #[only_self]
    fn decrease_public_balance_internal(from: AztecAddress, amount: u128) {
        self.internal._decrease_public_balance(from, amount);
    }

    // ============================================================
    // View functions
    // ============================================================

    #[external("public")]
    #[view]
    fn balance_of_public(owner: AztecAddress) -> u128 {
        self.storage.public_balances.at(owner).read()
    }

    #[external("public")]
    #[view]
    fn total_supply() -> u128 {
        self.storage.total_supply.read()
    }

    #[external("public")]
    #[view]
    fn name() -> FieldCompressedString {
        self.storage.name.read()
    }

    #[external("public")]
    #[view]
    fn symbol() -> FieldCompressedString {
        self.storage.symbol.read()
    }

    #[external("public")]
    #[view]
    fn decimals() -> u8 {
        self.storage.decimals.read()
    }

    #[external("utility")]
    unconstrained fn balance_of_private(owner: AztecAddress) -> u128 {
        self.storage.private_balances.at(owner).balance_of()
    }

    // ============================================================
    // Mintable
    // ============================================================

    /// Mint tokens to a private balance
    #[external("private")]
    fn mint_to_private(to: AztecAddress, amount: u128) {
        _validate_minter(self.msg_sender(), self.storage.minter.read());
        self.internal._mint_to_private(to, amount);
    }

    /// Mint tokens to a public balance
    #[external("public")]
    fn mint_to_public(to: AztecAddress, amount: u128) {
        _validate_minter(self.msg_sender(), self.storage.minter.read());
        self.internal._mint_to_public(to, amount);
    }

    #[external("public")]
    #[only_self]
    fn increase_total_supply_internal(amount: u128) {
        self.internal._increase_total_supply(amount);
    }

    // ============================================================
    // Burnable
    // ============================================================

    /// Burn tokens from a private balance
    #[external("private")]
    fn burn_private(from: AztecAddress, amount: u128, _nonce: Field) {
        _validate_from_private::<3>(self.context, from);
        self.internal._burn_private(from, amount);
    }

    /// Burn tokens from a public balance
    #[external("public")]
    fn burn_public(from: AztecAddress, amount: u128, _nonce: Field) {
        self.internal._validate_from_public(from);
        self.internal._burn_public(from, amount);
    }

    #[external("public")]
    #[only_self]
    fn decrease_total_supply_internal(amount: u128) {
        self.internal._decrease_total_supply(amount);
    }

    // ============================================================
    // Mode A: Migrate via Proof (on NEW rollup)
    // ============================================================

    /// Claim a Mode A migration on the new rollup (to private balance).
    ///
    /// Verifies the MigrationNote inclusion proof via `migrate_notes_mode_a`,
    /// checks that `amount` matches the locked `migration_data` hash, and mints
    /// the equivalent tokens to the caller's private balance.
    #[external("private")]
    fn migrate_mode_a(
        amount: u128,
        mpk: Point,
        signature: MigrationSignature,
        note_proof_data: MigrationNoteProofData<u128>,
        block_header: BlockHeader,
    ) {
        let amount_from_data = note_proof_data.data;
        assert(amount_from_data == amount, "Migration data hash mismatch");

        let recipient = self.msg_sender();
        let old_app = self.storage.old_rollup_app_address.read();

        MigrationModeA::new(
            self.context,
            old_app,
            self.storage.archive_root_address.read(),
            block_header,
            mpk,
        )
            .with_note(note_proof_data)
            .finish(recipient, signature);

        // Mint the migrated tokens to the user's private balance
        self.storage.private_balances.at(recipient).add(amount).deliver(
            MessageDelivery.ONCHAIN_CONSTRAINED,
        );

        // Update total supply on the new rollup.
        // Privacy note: this leaks the migrated amount as a public function argument.
        // This is a known compromise. If only Mode B migration is supported, an
        // alternative is to initialize V2 with total_supply from the old rollup snapshot
        // and skip incrementing on each claim.
        self.enqueue_self.increase_total_supply_internal(amount);
    }

    /// Claim a Mode A migration on the new rollup (to public balance).
    ///
    /// Same verification as migrate_mode_a(), but mints to public balance instead of private.
    #[external("private")]
    fn migrate_to_public_mode_a(
        amount: u128,
        mpk: Point,
        signature: MigrationSignature,
        note_proof_data: MigrationNoteProofData<u128>,
        block_header: BlockHeader,
    ) {
        let amount_from_data = note_proof_data.data;
        assert(amount_from_data == amount, "Migration data hash mismatch");

        let recipient = self.msg_sender();
        let old_app = self.storage.old_rollup_app_address.read();

        MigrationModeA::new(
            self.context,
            old_app,
            self.storage.archive_root_address.read(),
            block_header,
            mpk,
        )
            .with_note(note_proof_data)
            .finish(recipient, signature);

        // Mint to PUBLIC balance via enqueued call
        TokenMigrationAppV2::at(self.context.this_address())
            ._mint_to_public_external(recipient, amount)
            .enqueue(self.context);
    }

    // ============================================================
    // Mode B: Emergency Snapshot Migration (on NEW rollup)
    // ============================================================

    /// Claim a Mode B migration for private notes on the new rollup.
    ///
    /// Verifies note inclusion and non-nullification at the snapshot height via
    /// `migrate_notes_mode_b`, checks the sum of note values matches `amount`,
    /// and mints the equivalent tokens to the caller's private balance.
    #[external("private")]
    fn migrate_mode_b(
        amount: u128,
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

        // Use V1's storage layout to get the correct slot on the old rollup
        let balances_expected_storage_slot =
            STORAGE_LAYOUT_TokenMigrationAppV1.fields.private_balances.slot;

        let sum = full_proof_data.note_proof_data.data.value;
        assert(sum == amount, "Sum of migrated notes does not match the specified amount");

        MigrationModeB::new(
            self.context,
            old_app,
            self.storage.archive_root_address.read(),
            block_header,
        )
            .with_notes_owner(notes_owner, key_note, recipient, public_keys, partial_address, nhk)
            .with_note(full_proof_data, balances_expected_storage_slot)
            .finish(signature);

        // Mint the migrated tokens to the user's private balance
        self.storage.private_balances.at(recipient).add(amount).deliver(
            MessageDelivery.ONCHAIN_CONSTRAINED,
        );

        // Update total supply on the new rollup.
        // Privacy note: this leaks the migrated amount as a public function argument.
        // This is a known compromise. If only Mode B migration is supported, an
        // alternative is to initialize V2 with total_supply from the old rollup snapshot
        // and skip incrementing on each claim.
        self.enqueue_self.increase_total_supply_internal(amount);
    }

    /// Claim a Mode B migration for a public balance on the new rollup.
    ///
    /// Proves `public_balances[owner]` at snapshot height, verifies ownership via
    /// migration key signature, and mints to the authenticated recipient's public balance.
    #[external("private")]
    fn migrate_public_balance_mode_b(
        proof_data: PublicStateProofData<u128, 1>,
        block_header: BlockHeader,
        old_owner: AztecAddress,
        signature: MigrationSignature,
        key_note: KeyNoteProofData,
    ) {
        let amount = proof_data.data;
        assert(amount > 0, "Cannot migrate zero balance");

        let recipient = self.msg_sender();
        let old_app = self.storage.old_rollup_app_address.read();

        // Use V1's storage layout to get the correct slot on the old rollup
        let base_storage_slot = STORAGE_LAYOUT_TokenMigrationAppV1.fields.public_balances.slot;

        MigrationModeB::new(
            self.context,
            old_app,
            self.storage.archive_root_address.read(),
            block_header,
        )
            .with_owner(old_owner, key_note, recipient)
            .with_public_map_state(proof_data, base_storage_slot, [old_owner])
            .finish(signature);

        // Mint to PUBLIC balance via enqueued call
        TokenMigrationAppV2::at(self.context.this_address())
            ._mint_to_public_external(recipient, amount)
            .enqueue(self.context);
    }

    // ============================================================
    // Internal helpers for migration minting
    // ============================================================

    /// Public function to mint tokens (used by migration functions via enqueue)
    #[external("public")]
    #[only_self]
    fn _mint_to_public_external(to: AztecAddress, amount: u128) {
        self.internal._mint_to_public(to, amount);
    }

    // ============================================================
    // Internal library methods
    // ============================================================

    #[contract_library_method]
    fn _validate_minter(sender: AztecAddress, minter: AztecAddress) {
        assert(minter.eq(sender), "caller is not minter");
    }

    #[contract_library_method]
    fn _validate_from_private<let N: u32>(context: &mut PrivateContext, from: AztecAddress) {
        if (!from.eq(context.maybe_msg_sender().unwrap())) {
            assert_current_call_valid_authwit::<N>(context, from);
        }
    }

    #[internal("private")]
    fn _decrease_private_balance(account: AztecAddress, amount: u128, max_notes: u32) {
        let change = self.internal._subtract_balance(account, amount, max_notes);
        self.storage.private_balances.at(account).add(change).deliver(
            MessageDelivery.ONCHAIN_CONSTRAINED,
        );
    }

    #[internal("private")]
    fn _increase_private_balance(to: AztecAddress, amount: u128) {
        self.storage.private_balances.at(to).add(amount).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
    }

    #[internal("public")]
    fn _increase_public_balance(to: AztecAddress, amount: u128) {
        let new_balance = self.storage.public_balances.at(to).read() + amount;
        self.storage.public_balances.at(to).write(new_balance);
    }

    #[internal("public")]
    fn _decrease_public_balance(from: AztecAddress, amount: u128) {
        let new_balance = self.storage.public_balances.at(from).read() - amount;
        self.storage.public_balances.at(from).write(new_balance);
    }

    #[internal("private")]
    fn _subtract_balance(account: AztecAddress, amount: u128, max_notes: u32) -> u128 {
        let subtracted = self.storage.private_balances.at(account).try_sub(amount, max_notes);
        if subtracted >= amount {
            subtracted - amount
        } else {
            assert(subtracted > 0, "Balance too low");
            let remaining = amount - subtracted;
            self.call_self.recurse_subtract_balance_internal(account, remaining)
        }
    }

    #[internal("public")]
    fn _increase_total_supply(amount: u128) {
        let new_supply = self.storage.total_supply.read() + amount;
        self.storage.total_supply.write(new_supply);
    }

    #[internal("public")]
    fn _decrease_total_supply(amount: u128) {
        let new_supply = self.storage.total_supply.read() - amount;
        self.storage.total_supply.write(new_supply);
    }

    #[internal("public")]
    fn _mint_to_public(to: AztecAddress, amount: u128) {
        self.internal._increase_public_balance(to, amount);
        self.internal._increase_total_supply(amount);
    }

    #[internal("private")]
    fn _mint_to_private(to: AztecAddress, amount: u128) {
        self.internal._increase_private_balance(to, amount);
        self.enqueue_self.increase_total_supply_internal(amount);
    }

    #[internal("public")]
    fn _burn_public(from: AztecAddress, amount: u128) {
        self.internal._decrease_public_balance(from, amount);
        self.internal._decrease_total_supply(amount);
    }

    #[internal("private")]
    fn _burn_private(from: AztecAddress, amount: u128) {
        self.internal._decrease_private_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);
        self.enqueue_self.decrease_total_supply_internal(amount);
    }

    // ============================================================
    // Auth libraries
    // ============================================================

    #[internal("public")]
    fn _validate_from_public(from: AztecAddress) {
        if (!from.eq(self.msg_sender())) {
            assert_current_call_valid_authwit_public(self.context, from);
        }
    }
}
