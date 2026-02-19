mod ops;
pub use ops::{migrate_notes_mode_b, migrate_public_map_state_mode_b, migrate_public_state_mode_b};
use crate::note_proof_data::NoteProofData;
mod non_nullification_proof_data;
pub use non_nullification_proof_data::NonNullificationProofData;
pub(crate) mod public_state_proof_data;
pub use public_state_proof_data::PublicStateProofData;

use aztec::protocol_types::traits::Serialize;
use migration_key_registry::MigrationKeyNote;

/// Key note with inclusion proof data.
pub type KeyNoteProofData = NoteProofData<MigrationKeyNote>;
/// A note together with its inclusion proof and nullifier non-inclusion proof data.
/// Carries everything needed to verify that a note exists in the note hash tree
/// and has not been nullified in the nullifier tree at a given snapshot height.
#[derive(Serialize)]
pub struct FullNoteProofData<Note> {
    pub note_proof_data: NoteProofData<Note>,
    pub non_nullification_proof_data: NonNullificationProofData,
}
