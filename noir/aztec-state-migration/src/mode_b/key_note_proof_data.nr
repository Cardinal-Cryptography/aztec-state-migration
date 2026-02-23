use crate::note_proof_data::NoteProofData;
use aztec::{context::PrivateContext, protocol::address::AztecAddress};
use migration_archive_registry::MigrationArchiveRegistry;
use migration_key_registry::{
    MigrationKeyNote, MigrationKeyRegistry::STORAGE_LAYOUT_MigrationKeyRegistry,
};

/// Key note with inclusion proof data.
pub type KeyNoteProofData = NoteProofData<MigrationKeyNote>;

impl NoteProofData<MigrationKeyNote> {
    /// Verify the key note inclusion in the [KeyNote] hash tree
    pub fn verify_key_note_inclusion(
        self,
        context: &mut PrivateContext,
        migration_archive_registry: AztecAddress,
        note_owner: AztecAddress,
        note_hash_tree_root: Field,
    ) -> Field {
        let key_note_hash = self.note_hash(
            note_owner,
            STORAGE_LAYOUT_MigrationKeyRegistry.fields.registered_keys.slot,
        );

        // Silo by old key registry contract address
        let old_registry = MigrationArchiveRegistry::at(migration_archive_registry)
            .get_old_key_registry()
            .call(context);

        self.verify_note_inclusion(old_registry, key_note_hash, note_hash_tree_root)
    }
}
