use dep::aztec::{
    context::PrivateContext,
    keys::getters::{get_nsk_app, get_public_keys},
    macros::notes::custom_note,
    note::note_interface::NoteHash,
    protocol_types::{
        address::AztecAddress,
        constants::{GENERATOR_INDEX__NOTE_HASH, GENERATOR_INDEX__NOTE_NULLIFIER},
        hash::poseidon2_hash_with_separator,
        traits::{Deserialize, Hash, Packable, Serialize},
    },
};

/// MigrationKeyNote - stores a user's migration public key hash.
///
/// Uses #[custom_note] because ownership is implicit via the Owned<PrivateSet> storage,
/// not via a standard owner field in the note. The note hash excludes the owner parameter,
/// matching the pattern used by MigrationNote in the migrator contract.
#[derive(Deserialize, Eq, Serialize, Packable)]
#[custom_note]
pub struct MigrationKeyNote {
    pub mpk_hash: Field,
}

impl NoteHash for MigrationKeyNote {
    fn compute_note_hash(
        self,
        _owner: AztecAddress,
        storage_slot: Field,
        randomness: Field,
    ) -> Field {
        poseidon2_hash_with_separator(
            [self.mpk_hash, storage_slot, randomness],
            GENERATOR_INDEX__NOTE_HASH,
        )
    }

    fn compute_nullifier(
        self,
        context: &mut PrivateContext,
        owner: AztecAddress,
        note_hash_for_nullification: Field,
    ) -> Field {
        let owner_npk_m_hash = get_public_keys(owner).npk_m.hash();
        let secret = context.request_nsk_app(owner_npk_m_hash);
        poseidon2_hash_with_separator(
            [note_hash_for_nullification, secret],
            GENERATOR_INDEX__NOTE_NULLIFIER,
        )
    }

    unconstrained fn compute_nullifier_unconstrained(
        self,
        owner: AztecAddress,
        note_hash_for_nullification: Field,
    ) -> Field {
        let owner_npk_m_hash = get_public_keys(owner).npk_m.hash();
        let secret = get_nsk_app(owner_npk_m_hash);
        poseidon2_hash_with_separator(
            [note_hash_for_nullification, secret],
            GENERATOR_INDEX__NOTE_NULLIFIER,
        )
    }
}

impl MigrationKeyNote {
    pub fn new(mpk_hash: Field) -> Self {
        Self { mpk_hash }
    }
}
