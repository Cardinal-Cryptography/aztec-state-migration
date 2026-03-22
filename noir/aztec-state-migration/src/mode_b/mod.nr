mod builder;
pub use builder::MigrationModeB;
pub(crate) mod key_note_proof_data;
pub use key_note_proof_data::KeyNoteProofData;
pub(crate) mod non_nullification_proof_data;
pub use non_nullification_proof_data::NonNullificationProofData;
pub(crate) mod public_state_proof_data;
pub use public_state_proof_data::PublicStateProofData;
pub(crate) mod l1_to_l2_message_proof_data;
pub use l1_to_l2_message_proof_data::L1ToL2MessageProofData;
mod custom_note_test;
pub use custom_note_test::assert_note_has_canonical_nullifier;

use crate::note_proof_data::NoteProofData;
use aztec::protocol::traits::Serialize;

/// A note together with its inclusion proof and nullifier non-inclusion proof data.
/// Carries everything needed to verify that a note exists in the note hash tree
/// and has not been nullified in the nullifier tree at a given snapshot height.
#[derive(Serialize)]
pub struct FullNoteProofData<Note> {
    pub note_proof_data: NoteProofData<Note>,
    pub non_nullification_proof_data: NonNullificationProofData,
}

/// An L1-to-L2 message together with its inclusion proof and consumption
/// nullifier non-inclusion proof data. Carries everything needed to verify
/// that a message exists in the L1-to-L2 message tree and was not consumed
/// at a given snapshot height.
#[derive(Serialize)]
pub struct FullL1ToL2MessageProofData {
    pub message_proof_data: L1ToL2MessageProofData,
    pub non_nullification_proof_data: NonNullificationProofData,
}
