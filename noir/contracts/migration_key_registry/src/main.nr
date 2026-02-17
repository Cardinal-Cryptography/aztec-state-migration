use aztec::macros::aztec as aztec_contract;

mod migration_key_note;
pub use crate::migration_key_note::MigrationKeyNote;

#[aztec_contract]
pub contract MigrationKeyRegistry {
    use crate::migration_key_note::MigrationKeyNote;
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        messages::message_delivery::MessageDelivery,
        note::{note_getter_options::NoteGetterOptions, note_viewer_options::NoteViewerOptions},
        protocol_types::{address::AztecAddress, traits::Packable},
        state_vars::{owned::Owned, private_set::PrivateSet},
    };
    use std::embedded_curve_ops::EmbeddedCurvePoint as Point;

    #[storage]
    struct Storage<Context> {
        registered_keys: Owned<PrivateSet<MigrationKeyNote, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor() {}

    /// Register a migration public key hash for the caller.
    /// Creates a MigrationKeyNote in the caller's private set.
    #[external("private")]
    fn register(mpk: Point) {
        assert(
            (mpk.y * mpk.y == mpk.x * mpk.x * mpk.x - 17) & (!mpk.is_infinite),
            "mpk not on Grumpkin curve",
        );

        let owner = self.context.msg_sender().unwrap();
        let note = MigrationKeyNote::new(mpk);
        self.storage.registered_keys.at(owner).insert(note).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
    }

    /// Cancel (nullify) all registered migration key notes for the caller.
    /// After cancellation the user can call register() again with a new key.
    #[external("private")]
    fn cancel() {
        let owner = self.context.msg_sender().unwrap();
        let options = NoteGetterOptions::new();
        let notes = self.storage.registered_keys.at(owner).pop_notes(options);
        assert(notes.len() > 0, "No registered key to cancel");
    }

    /// View function: retrieve the registered mpk for an owner.
    /// Returns the point at infinity if no key is registered.
    #[external("utility")]
    unconstrained fn get(owner: AztecAddress) -> Point {
        let options =
            NoteViewerOptions::<MigrationKeyNote, <MigrationKeyNote as Packable>::N>::new();
        let notes = self.storage.registered_keys.at(owner).view_notes(options);
        if notes.len() > 0 {
            notes.get_unchecked(0).mpk
        } else {
            Point::point_at_infinity()
        }
    }

    /// View function: return the number of active registration notes for an owner.
    /// Useful to verify old keys are fully revoked after cancel + re-register
    /// (expected: 0 after cancel, 1 after register).
    #[external("utility")]
    unconstrained fn get_count(owner: AztecAddress) -> u32 {
        let options =
            NoteViewerOptions::<MigrationKeyNote, <MigrationKeyNote as Packable>::N>::new();
        let notes = self.storage.registered_keys.at(owner).view_notes(options);
        notes.len()
    }
}
