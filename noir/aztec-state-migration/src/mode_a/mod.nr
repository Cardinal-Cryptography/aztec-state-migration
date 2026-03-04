mod builder;
pub use builder::MigrationModeA;
mod migration_lock;
pub use migration_lock::MigrationLock;
pub(crate) mod migration_note;
pub(crate) mod migration_data_event;

use crate::note_proof_data::NoteProofData;

/// Migration note inclusion proof data needed to verify a [MigrationNote] exists in the
/// old rollup's note hash tree.
/// The generic parameter `MigrationData` allows this [MigrationNote] to be used for different types of migration data.
pub type MigrationNoteProofData<MigrationData> = NoteProofData<MigrationData>;
