use aztec::{
    context::PrivateContext,
    keys::getters::{get_nhk_app, get_public_keys},
    macros::notes::custom_note,
    note::note_interface::NoteHash,
    protocol::{
        address::AztecAddress,
        constants::{DOM_SEP__NOTE_HASH, DOM_SEP__NOTE_NULLIFIER},
        hash::poseidon2_hash_with_separator,
        traits::{Hash, Packable, Serialize, ToField},
    },
};
use aztec_state_migration::mode_b::assert_note_has_canonical_nullifier;

/// A private note representing a token id associated to an account.
/// Copied from defi-wonderland/aztec-standards to ensure identical note hash computation.
#[derive(Eq, Serialize, Packable)]
#[custom_note]
pub struct NFTNote {
    pub token_id: Field,
}

impl NoteHash for NFTNote {
    fn compute_note_hash(
        self,
        owner: AztecAddress,
        storage_slot: Field,
        randomness: Field,
    ) -> Field {
        // Two-round Poseidon for partial note compatibility.
        // First round: commit to private content (owner, storage_slot, randomness).
        let partial_commitment = poseidon2_hash_with_separator(
            [owner.to_field(), storage_slot, randomness],
            DOM_SEP__NOTE_HASH,
        );
        // Second round: include the token_id.
        poseidon2_hash_with_separator([partial_commitment, self.token_id], DOM_SEP__NOTE_HASH)
    }

    fn compute_nullifier(
        self,
        context: &mut PrivateContext,
        owner: AztecAddress,
        note_hash_for_nullification: Field,
    ) -> Field {
        let owner_npk_m = get_public_keys(owner).npk_m;
        let owner_npk_m_hash = owner_npk_m.hash();
        let secret = context.request_nhk_app(owner_npk_m_hash);
        poseidon2_hash_with_separator(
            [note_hash_for_nullification, secret],
            DOM_SEP__NOTE_NULLIFIER,
        )
    }

    unconstrained fn compute_nullifier_unconstrained(
        self,
        owner: AztecAddress,
        note_hash_for_nullification: Field,
    ) -> Option<Field> {
        let owner_npk_m = get_public_keys(owner).npk_m;
        let owner_npk_m_hash = owner_npk_m.hash();
        let secret = get_nhk_app(owner_npk_m_hash);
        Option::some(poseidon2_hash_with_separator(
            [note_hash_for_nullification, secret],
            DOM_SEP__NOTE_NULLIFIER,
        ))
    }
}

#[test]
unconstrained fn assert_canonical_nullifier() {
    let note = NFTNote { token_id: 0x12345 };
    assert_note_has_canonical_nullifier(note);
}
