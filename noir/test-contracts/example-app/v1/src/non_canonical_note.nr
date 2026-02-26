use aztec::{
    context::PrivateContext,
    macros::notes::custom_note,
    note::note_interface::NoteHash,
    protocol::{
        address::AztecAddress,
        constants::{DOM_SEP__NOTE_HASH, DOM_SEP__NOTE_NULLIFIER},
        hash::poseidon2_hash_with_separator,
        traits::{Deserialize, Packable, Serialize, ToField},
    },
};

#[derive(Deserialize, Eq, Serialize, Packable)]
#[custom_note]
pub struct NonCanonicalNote {
    pub foo: Field,
}

impl NonCanonicalNote {
    pub fn new(foo: Field) -> Self {
        Self { foo }
    }
}

impl NoteHash for NonCanonicalNote {
    fn compute_note_hash(
        self,
        owner: AztecAddress,
        storage_slot: Field,
        randomness: Field,
    ) -> Field {
        poseidon2_hash_with_separator(
            [self.foo.to_field(), owner.to_field(), storage_slot, randomness],
            DOM_SEP__NOTE_HASH,
        )
    }

    fn compute_nullifier(
        self,
        _context: &mut PrivateContext,
        _owner: AztecAddress,
        note_hash_for_nullification: Field,
    ) -> Field {
        poseidon2_hash_with_separator(
            [note_hash_for_nullification, self.foo],
            DOM_SEP__NOTE_NULLIFIER,
        )
    }

    unconstrained fn compute_nullifier_unconstrained(
        self,
        _owner: AztecAddress,
        note_hash_for_nullification: Field,
    ) -> Option<Field> {
        Option::some(poseidon2_hash_with_separator(
            [note_hash_for_nullification, self.foo],
            DOM_SEP__NOTE_NULLIFIER,
        ))
    }
}
