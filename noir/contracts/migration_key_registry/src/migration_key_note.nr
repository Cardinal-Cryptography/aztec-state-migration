use dep::aztec::{
    context::PrivateContext,
    keys::getters::{get_nsk_app, get_public_keys},
    macros::notes::custom_note,
    note::note_interface::NoteHash,
    protocol_types::{
        address::AztecAddress,
        constants::{GENERATOR_INDEX__NOTE_HASH, GENERATOR_INDEX__NOTE_NULLIFIER},
        hash::poseidon2_hash_with_separator,
        traits::{Deserialize, Hash, Packable, Serialize, ToField},
    },
};

/// MigrationKeyNote - stores a user's migration public key hash.
///
/// Uses #[custom_note] because ownership is determined by the migration public key hash,
/// not by a standard Aztec account key. The note hash INCLUDES the owner parameter to
/// bind the registration to a specific address, enabling cross-rollup ownership proofs
/// in Mode B migration.
#[derive(Deserialize, Eq, Serialize, Packable)]
#[custom_note]
pub struct MigrationKeyNote {
    pub mpk_hash: Field,
}

impl NoteHash for MigrationKeyNote {
    fn compute_note_hash(
        self,
        owner: AztecAddress,
        storage_slot: Field,
        randomness: Field,
    ) -> Field {
        // Owner is included so Mode B can prove a specific address registered this mpk_hash
        poseidon2_hash_with_separator(
            [self.mpk_hash, owner.to_field(), storage_slot, randomness],
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
