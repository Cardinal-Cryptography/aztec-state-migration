use dep::aztec::{macros::notes::note, protocol_types::{address::AztecAddress, traits::{Deserialize, Packable, Serialize}}};

/// MigrationLockNote - a note that locks a user's original note for migration.
#[derive(Deserialize, Eq, Serialize, Packable)]
#[note]
// #[custom_note]
pub struct MigrationLockNote {
    /// Address of the note creator (typically app contract)
    pub note_creator: AztecAddress,
    /// Owner's migration public key (mpk).
    /// Used for cross-rollup ownership proof - user proves knowledge of migration secret key (msk).
    pub owner_mpk: Field,
    /// Data to migrate (e.g., original note hash)
    pub migration_data: Field,
    /// Identifier of the destination rollup (prevents cross-rollup replay)
    pub destination_rollup: Field,
}

impl MigrationLockNote {
    /// Create a new MigrationLockNote
    pub fn new(
        note_creator: AztecAddress,
        owner_mpk: Field,
        migration_data: Field,
        destination_rollup: Field,
    ) -> Self {
        Self { note_creator, owner_mpk, migration_data, destination_rollup }
    }
}
