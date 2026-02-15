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
    fn register(mpk_hash: Field) {
        assert(mpk_hash != 0, "Invalid mpk_hash: cannot be zero");

        let owner = self.context.msg_sender().unwrap();
        let note = MigrationKeyNote::new(mpk_hash);
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

    /// View function: retrieve the registered mpk_hash for an owner.
    /// Returns 0 if no key is registered.
    #[external("utility")]
    unconstrained fn get(owner: AztecAddress) -> Field {
        let options = NoteViewerOptions::<MigrationKeyNote, <MigrationKeyNote as Packable>::N>::new();
        let notes = self.storage.registered_keys.at(owner).view_notes(options);
        if notes.len() > 0 {
            notes.get_unchecked(0).mpk_hash
        } else {
            0
        }
    }

    /// View function: return the number of active registration notes for an owner.
    /// Useful to verify old keys are fully revoked after cancel + re-register
    /// (expected: 0 after cancel, 1 after register).
    #[external("utility")]
    unconstrained fn get_count(owner: AztecAddress) -> u32 {
        let options = NoteViewerOptions::<MigrationKeyNote, <MigrationKeyNote as Packable>::N>::new();
        let notes = self.storage.registered_keys.at(owner).view_notes(options);
        notes.len()
    }
}
