use dep::aztec::{
    macros::notes::note,
    protocol_types::traits::{Deserialize, Packable, Serialize},
};

/// MigrationKeyNote - stores a user's migration public key hash.
///
/// The #[note] macro auto-generates compute_note_hash as:
///   poseidon2([mpk_hash, owner, storage_slot, randomness], GENERATOR_INDEX__NOTE_HASH)
/// This includes the owner, which binds the registration to a specific address
/// and enables cross-rollup ownership proofs in Mode B migration.
#[derive(Deserialize, Eq, Serialize, Packable)]
#[note]
pub struct MigrationKeyNote {
    pub mpk_hash: Field,
}

impl MigrationKeyNote {
    pub fn new(mpk_hash: Field) -> Self {
        Self { mpk_hash }
    }
}
