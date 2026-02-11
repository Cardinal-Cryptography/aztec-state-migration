use dep::aztec::{
    context::PrivateContext,
    macros::notes::custom_note,
    note::note_interface::NoteHash,
    protocol_types::{
        address::AztecAddress,
        constants::{GENERATOR_INDEX__NOTE_HASH, GENERATOR_INDEX__NOTE_NULLIFIER},
        hash::poseidon2_hash_with_separator,
        traits::{Deserialize, Packable, Serialize, ToField},
    },
};

/// MigrationNote - a note that locks a user's original note for migration.
///
/// Uses #[custom_note] because ownership is determined by the migration public key (mpk),
/// not by an Aztec account address. The note hash intentionally excludes the standard `owner`
/// parameter, simplifying cross-rollup verification (the new rollup doesn't need to know
/// old rollup identities).
#[derive(Deserialize, Eq, Serialize, Packable)]
#[custom_note]
pub struct MigrationNote {
    /// Address of the note creator (typically app contract)
    pub note_creator: AztecAddress,
    /// Migration public key (mpk).
    /// Used for cross-rollup ownership proof - user proves knowledge of migration secret key (msk).
    pub mpk: Field,
    /// Identifier of the destination rollup (prevents cross-rollup replay)
    pub destination_rollup: Field,
    /// Data to migrate (e.g., hash of original note data)
    pub migration_data: Field,
}

impl NoteHash for MigrationNote {
    fn compute_note_hash(
        self,
        _owner: AztecAddress,
        storage_slot: Field,
        randomness: Field,
    ) -> Field {
        // Owner is intentionally excluded - mpk serves as the ownership proof.
        poseidon2_hash_with_separator(
            [
                self.note_creator.to_field(),
                self.mpk,
                self.destination_rollup,
                self.migration_data,
                storage_slot,
                randomness,
            ],
            GENERATOR_INDEX__NOTE_HASH,
        )
    }

    fn compute_nullifier(
        self,
        _context: &mut PrivateContext,
        _owner: AztecAddress,
        note_hash_for_nullification: Field,
    ) -> Field {
        // Trait fallback - not used in the migration flow (which calls MigrationNote::compute_nullifier
        // with msk directly).
        // Ideally, the msk should be requested from the context.
        //
        // Return a deterministic dummy so PXE note discovery
        // can track the note without crashing.
        poseidon2_hash_with_separator(
            [note_hash_for_nullification],
            GENERATOR_INDEX__NOTE_NULLIFIER,
        )
    }

    unconstrained fn compute_nullifier_unconstrained(
        self,
        _owner: AztecAddress,
        note_hash_for_nullification: Field,
    ) -> Field {
        poseidon2_hash_with_separator(
            [note_hash_for_nullification],
            GENERATOR_INDEX__NOTE_NULLIFIER,
        )
    }
}

impl MigrationNote {
    pub fn new(
        note_creator: AztecAddress,
        mpk: Field,
        destination_rollup: Field,
        migration_data: Field,
    ) -> Self {
        Self { note_creator, mpk, destination_rollup, migration_data }
    }

    /// Computes the migration nullifier. Includes msk (migration secret key) so that
    /// observers cannot link old/new rollup identities by predicting the nullifier from
    /// public note fields.
    pub fn compute_nullifier(
        note_hash_for_nullification: Field,
        msk: Field,
    ) -> Field {
        poseidon2_hash_with_separator(
            [note_hash_for_nullification, msk],
            GENERATOR_INDEX__NOTE_NULLIFIER,
        )
    }

    unconstrained fn compute_nullifier_unconstrained(
        note_hash_for_nullification: Field,
        msk: Field,
    ) -> Field {
        poseidon2_hash_with_separator(
            [note_hash_for_nullification, msk],
            GENERATOR_INDEX__NOTE_NULLIFIER,
        )
    }
}
