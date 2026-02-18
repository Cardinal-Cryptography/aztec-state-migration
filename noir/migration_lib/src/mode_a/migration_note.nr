use aztec::{
    context::PrivateContext,
    macros::notes::custom_note,
    note::note_interface::NoteHash,
    protocol_types::{
        address::AztecAddress,
        constants::{GENERATOR_INDEX__NOTE_HASH, GENERATOR_INDEX__NOTE_NULLIFIER},
        hash::{poseidon2_hash, poseidon2_hash_with_separator},
        traits::{Deserialize, Packable, Serialize, ToField},
    },
};
use std::embedded_curve_ops::EmbeddedCurvePoint as Point;

/// MigrationNote - a note that locks a user's original note for migration.
///
/// Uses #[custom_note] because ownership is determined by the migration public key (mpk),
/// not by an Aztec owner address. The note hash intentionally excludes the standard `owner`
/// parameter, simplifying cross-rollup verification (the new rollup doesn't need to know
/// old rollup identities).
/// # Fields
/// - `note_creator`: Address of the note creator (typically app contract)
/// - `mpk`: Migration public key (Grumpkin curve point).
/// - `destination_rollup`: Identifier of the destination rollup (prevents cross-rollup replay)
/// - `migration_data_hash`: Hash of the data to migrate (e.g., hash of original note data)
#[derive(Deserialize, Eq, Serialize, Packable)]
#[custom_note]
pub struct MigrationNote {
    pub note_creator: AztecAddress,
    pub mpk: Point,
    pub destination_rollup: Field,
    pub migration_data_hash: Field,
}

impl MigrationNote {
    pub fn new<T: Packable>(
        note_creator: AztecAddress,
        mpk: Point,
        destination_rollup: Field,
        migration_data: T,
    ) -> Self {
        let migration_data_hash = poseidon2_hash(migration_data.pack());
        Self { note_creator, mpk, destination_rollup, migration_data_hash }
    }
}

impl NoteHash for MigrationNote {
    // Owner is intentionally excluded - `mpk` serves as the ownership proof.
    fn compute_note_hash(
        self,
        _owner: AztecAddress,
        storage_slot: Field,
        randomness: Field,
    ) -> Field {
        poseidon2_hash_with_separator(
            [
                self.note_creator.to_field(),
                self.mpk.x,
                self.mpk.y,
                self.destination_rollup,
                self.migration_data_hash,
                storage_slot,
                randomness,
            ],
            GENERATOR_INDEX__NOTE_HASH,
        )
    }

    /// Returns the non-siloed migration nullifier,
    /// which will be later siloed by contract address by the kernels before being committed to the state tree.
    ///
    /// Instead of owner address, includes migration note randomness so that
    /// observers cannot link old/new rollup identities by predicting the nullifier from
    /// public note fields.
    /// # Parameters:
    /// - `note_hash_for_nullification`: the note hash of the migration note being claimed
    /// - `wrapped_randomness`: the randomness of the migration note being claimed,
    ///                         wrapped in an [AztecAddress] for compatibility with the NoteHash trait; the inner field is used as the randomness
    fn compute_nullifier(
        self,
        _context: &mut PrivateContext,
        wrapped_randomness: AztecAddress,
        note_hash_for_nullification: Field,
    ) -> Field {
        let randomness = wrapped_randomness.inner;
        poseidon2_hash_with_separator(
            [note_hash_for_nullification, randomness],
            GENERATOR_INDEX__NOTE_NULLIFIER,
        )
    }

    unconstrained fn compute_nullifier_unconstrained(
        self,
        wrapped_randomness: AztecAddress,
        note_hash_for_nullification: Field,
    ) -> Field {
        let randomness = wrapped_randomness.inner;
        poseidon2_hash_with_separator(
            [note_hash_for_nullification, randomness],
            GENERATOR_INDEX__NOTE_NULLIFIER,
        )
    }
}
