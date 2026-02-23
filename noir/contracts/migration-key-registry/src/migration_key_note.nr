use ::aztec::{macros::notes::note, protocol::traits::{Deserialize, Packable, Serialize}};
use std::embedded_curve_ops::EmbeddedCurvePoint as Point;

/// MigrationKeyNote - stores a user's migration public key hash.
///
/// The #[note] macro auto-generates compute_note_hash as:
///   poseidon2([mpk_hash, owner, storage_slot, randomness], DOM_SEP__NOTE_HASH)
/// This includes the owner, which binds the registration to a specific address
/// and enables cross-rollup ownership proofs in Mode B migration.
#[derive(Deserialize, Eq, Serialize, Packable)]
#[note]
pub struct MigrationKeyNote {
    pub mpk: Point,
}

impl MigrationKeyNote {
    pub fn new(mpk: Point) -> Self {
        Self { mpk }
    }
}
