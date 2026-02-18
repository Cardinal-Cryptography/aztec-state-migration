mod methods;
pub use methods::{lock_migration_notes, migrate_notes_mode_a};
pub(crate) mod migration_note;
pub(crate) mod migration_data_event;

use crate::note_proof_data::NoteProofData;

/// Migration note inclusion proof data needed to verify a [MigrationNote] exists in the
/// old rollup's note hash tree.
/// The generic parameter `MigrationData` allows this [MigrationNote] to be used for different types of migration data.
pub type MigrationNoteProofData<MigrationData> = NoteProofData<MigrationData>;
