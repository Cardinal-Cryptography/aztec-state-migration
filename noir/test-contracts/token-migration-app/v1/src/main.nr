use aztec::macros::aztec;

/// V1 of the ERC20-like token migration contract.
///
/// Deployed on the OLD rollup.
/// Implements the ERC-20 core of AIP-20 (balances, transfers, mint, burn, authwit, metadata views).
/// Omits: commitment-based transfers (PartialUintNote), upgrade mechanism, vault/ERC-4626.
/// Adds: Mode A lock functions (lock_migration_notes_mode_a, lock_public_for_migration).
#[aztec]
pub contract TokenMigrationAppV1 {
    use aztec::{
        authwit::auth::{
            assert_current_call_valid_authwit, assert_current_call_valid_authwit_public,
        },
        context::PrivateContext,
        macros::{functions::{external, initializer, internal, only_self, view}, storage::storage},
        messages::message_delivery::MessageDelivery,
        protocol::address::AztecAddress,
        state_vars::{Map, Owned, PublicImmutable, PublicMutable},
    };
    use aztec_state_migration::{mode_a::lock_migration_notes, Point};
    use balance_set::BalanceSet;
    use compressed_string::FieldCompressedString;
    // Gas-optimized max notes for initial transfer call
    global INITIAL_TRANSFER_CALL_MAX_NOTES: u32 = 2;
    // Max notes transfer for recursive transfer call
    global RECURSIVE_TRANSFER_CALL_MAX_NOTES: u32 = 8;

    #[storage]
    struct Storage<Context> {
        name: PublicImmutable<FieldCompressedString, Context>,
        symbol: PublicImmutable<FieldCompressedString, Context>,
        decimals: PublicImmutable<u8, Context>,
        private_balances: Owned<BalanceSet<Context>, Context>,
        total_supply: PublicMutable<u128, Context>,
        public_balances: Map<AztecAddress, PublicMutable<u128, Context>, Context>,
        minter: PublicImmutable<AztecAddress, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(name: str<31>, symbol: str<31>, decimals: u8, minter: AztecAddress) {
        self.storage.name.initialize(FieldCompressedString::from_string(name));
        self.storage.symbol.initialize(FieldCompressedString::from_string(symbol));
        self.storage.decimals.initialize(decimals);
        self.storage.minter.initialize(minter);
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
    // Mode A: Lock for Migration (on OLD rollup)
    // ============================================================

    /// Lock private tokens for migration to a new rollup.
    ///
    /// This function:
    /// 1. Subtracts the amount from the caller's private balance
    /// 2. Creates a MigrationNote that can be proven on the destination rollup
    #[external("private")]
    fn lock_migration_notes_mode_a(amount: u128, destination_rollup: Field, mpk: Point) {
        let note_owner = self.msg_sender();
        self.storage.private_balances.at(note_owner).sub(amount).deliver(
            MessageDelivery.ONCHAIN_CONSTRAINED,
        );
        lock_migration_notes(self.context, note_owner, destination_rollup, mpk, [amount]);
    }

    /// Lock public tokens for migration to a new rollup.
    ///
    /// This function:
    /// 1. Creates a MigrationNote (identical to private lock)
    /// 2. Enqueues a public function to decrement the user's public balance
    /// 3. Enqueues a public function to decrement the total supply
    #[external("private")]
    fn lock_public_for_migration(amount: u128, destination_rollup: Field, mpk: Point) {
        let note_owner = self.msg_sender();
        lock_migration_notes(self.context, note_owner, destination_rollup, mpk, [amount]);
        TokenMigrationAppV1::at(self.context.this_address())
            .decrease_public_balance_internal(note_owner, amount)
            .enqueue(self.context);
        TokenMigrationAppV1::at(self.context.this_address())
            .decrease_total_supply_internal(amount)
            .enqueue(self.context);
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
