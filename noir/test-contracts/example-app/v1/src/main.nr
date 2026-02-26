mod non_canonical_note;
pub use non_canonical_note::NonCanonicalNote;
use aztec::macros::aztec;

/// V1 of the example migration-aware token contract.
///
/// Deployed on the OLD rollup. Supports normal app operations
/// and Mode A lock functions for migration.
#[aztec]
pub contract ExampleMigrationAppV1 {
    use crate::non_canonical_note::NonCanonicalNote;
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        messages::message_delivery::MessageDelivery,
        protocol::{address::AztecAddress, traits::{Deserialize, Packable, Serialize}},
        state_vars::{Map, Owned, PrivateMutable, PublicMutable},
    };
    use aztec_state_migration::{mode_a::MigrationLock, Point};
    use balance_set::BalanceSet;

    // Only Packable needed for Migration
    // Serialize and Deserialize because it's used as argument
    #[derive(Packable, Deserialize, Serialize)]
    pub struct SomeStruct {
        a: u128,
        b: AztecAddress,
    }

    #[storage]
    struct Storage<Context> {
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
        //
        non_canonical_note: Owned<PrivateMutable<NonCanonicalNote, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor() {}

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
        ExampleMigrationAppV1::at(self.context.this_address())
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

    #[external("public")]
    fn _decrement_public_balance(owner: AztecAddress, amount: u128) {
        assert(self.msg_sender() == self.context.this_address(), "Only callable internally");
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
        let note_owner = self.msg_sender();

        self.storage.balances.at(note_owner).sub(amount).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

        MigrationLock::new(self.context, mpk, note_owner, destination_rollup)
            .lock_state(amount)
            .finish();
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
        let note_owner = self.msg_sender();

        MigrationLock::new(self.context, mpk, note_owner, destination_rollup)
            .lock_state(amount)
            .finish();

        // 3. Enqueue public balance decrement (executes after private phase)
        //    If this fails (insufficient balance), the entire tx reverts including the MigrationNote
        ExampleMigrationAppV1::at(self.context.this_address())
            ._decrement_public_balance(note_owner, amount)
            .enqueue(self.context);
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

    #[external("private")]
    fn init_non_canonical_note(foo: Field) {
        let note = NonCanonicalNote::new(foo);
        self.storage.non_canonical_note.at(self.msg_sender()).initialize(note).deliver(
            MessageDelivery.ONCHAIN_CONSTRAINED,
        );
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

    #[external("utility")]
    unconstrained fn get_non_canonical_note(owner: AztecAddress) -> NonCanonicalNote {
        self.storage.non_canonical_note.at(owner).view_note()
    }
}
