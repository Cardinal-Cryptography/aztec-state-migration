use aztec::macros::aztec as aztec_contract;

mod migration_key_note;
pub use crate::migration_key_note::MigrationKeyNote;

#[aztec_contract]
pub contract MigrationKeyRegistry {
    use crate::migration_key_note::MigrationKeyNote;
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        messages::message_delivery::MessageDelivery,
        protocol_types::address::AztecAddress,
        state_vars::{owned::Owned, private_immutable::PrivateImmutable},
    };
    use std::embedded_curve_ops::EmbeddedCurvePoint as Point;

    #[storage]
    struct Storage<Context> {
        registered_keys: Owned<PrivateImmutable<MigrationKeyNote, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor() {}

    /// Register a migration public key for the caller (once only).
    /// A second call will fail because the initialization nullifier already exists.
    #[external("private")]
    fn register(mpk: Point) {
        assert(
            (mpk.y * mpk.y == mpk.x * mpk.x * mpk.x - 17) & (!mpk.is_infinite),
            "mpk not on Grumpkin curve",
        );

        let owner = self.context.msg_sender().unwrap();
        let note = MigrationKeyNote::new(mpk);
        self.storage.registered_keys.at(owner).initialize(note).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
    }

    /// View function: retrieve the registered mpk for an owner.
    /// Returns the point at infinity if no key is registered.
    #[external("utility")]
    unconstrained fn get(owner: AztecAddress) -> Point {
        if self.storage.registered_keys.at(owner).is_initialized() {
            self.storage.registered_keys.at(owner).view_note().mpk
        } else {
            Point::point_at_infinity()
        }
    }
}
