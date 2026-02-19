mod ops;
pub use ops::migrate_notes_mode_b;
use crate::note_proof_data::NoteProofData;
mod non_nullification_proof_data;
pub use non_nullification_proof_data::NonNullificationProofData;
use migration_key_registry::MigrationKeyNote;

use aztec::protocol_types::traits::Serialize;

/// Key note with inclusion proof data.
pub type KeyNoteProofData = NoteProofData<MigrationKeyNote>;
/// A note together with its inclusion proof and nullifier non-inclusion proof data.
/// Carries everything needed to verify that a note exists in the note hash tree
/// and has not been nullified in the nullifier tree at a given snapshot height.
#[derive(Serialize)]
pub struct FullNoteProofData<T> {
    pub note_proof_data: NoteProofData<T>,
    pub non_nullification_proof_data: NonNullificationProofData,
}
