use aztec::{
    note::note_interface::NoteHash,
    protocol::{
        address::AztecAddress,
        constants::NOTE_HASH_TREE_HEIGHT,
        hash::{compute_siloed_note_hash, compute_unique_note_hash},
        merkle_tree::root::root_from_sibling_path,
        traits::{Packable, Serialize},
    },
};

/// Per-note inclusion proof data needed to verify a Note exists in the
/// old rollup's note hash tree.
#[derive(Serialize, Packable)]
pub struct NoteProofData<T> {
    pub data: T,
    pub(crate) randomness: Field,
    nonce: Field,
    leaf_index: Field,
    sibling_path: [Field; NOTE_HASH_TREE_HEIGHT],
}

impl<T> NoteProofData<T> {
    /// Verify the note inclusion proof against the given note hash tree root.
    /// Reconstructs the note hash following the same pipeline the protocol uses
    /// when committing notes:
    ///   note_hash -> siloed_note_hash (with contract address) -> unique_note_hash (with nonce)
    /// Then verifies the unique hash against the note hash tree root via Merkle proof.
    /// # Parameters
    /// - `old_app`: Address of the old app contract (used for siloing)
    /// - `note_hash`: Hash of the note data (pre-siloing and uniqueness transforms)
    /// - `note_hash_tree_root`: Root of the note hash tree to verify against
    /// # Returns
    /// The unique note hash (after siloing and uniqueness transforms), which can be
    /// used for nullifier computation.
    pub(crate) fn verify_note_inclusion(
        self,
        old_app: AztecAddress,
        note_hash: Field,
        note_hash_tree_root: Field,
    ) -> Field {
        let note_siloed = compute_siloed_note_hash(old_app, note_hash);
        let note_unique = compute_unique_note_hash(self.nonce, note_siloed);
        let computed_note_root =
            root_from_sibling_path(note_unique, self.leaf_index, self.sibling_path);
        assert(computed_note_root == note_hash_tree_root, "Note not in note hash tree");
        note_unique
    }
}

impl<T: NoteHash> NoteProofData<T> {
    pub(crate) fn note_hash(self, note_owner: AztecAddress, expected_storage_slot: Field) -> Field {
        self.data.compute_note_hash(note_owner, expected_storage_slot, self.randomness)
    }
}
