use aztec::{
    keys::getters::{get_nhk_app, get_public_keys},
    note::note_interface::NoteHash,
    protocol::{
        constants::DOM_SEP__NOTE_NULLIFIER, hash::poseidon2_hash_with_separator, traits::Hash,
    },
    test::helpers::test_environment::TestEnvironment,
};

pub unconstrained fn assert_note_has_canonical_nullifier<Note: NoteHash>(note: Note) {
    let mut env = TestEnvironment::new();
    let owner = env.create_light_account();
    let note_hash_for_nullification = 0x67890;
    let (actual, nhk_app) = env.private_context(|context| {
        let owner_npk_m = get_public_keys(owner).npk_m;
        let nhk_app = get_nhk_app(owner_npk_m.hash());
        let actual = note.compute_nullifier(context, owner, note_hash_for_nullification);
        (actual, nhk_app)
    });

    let expected = poseidon2_hash_with_separator(
        [note_hash_for_nullification, nhk_app],
        DOM_SEP__NOTE_NULLIFIER,
    );

    assert(actual == expected, "Note nullifier does not match canonical formula");
}
