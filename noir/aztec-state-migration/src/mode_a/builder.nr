use crate::{
    constants::{DOM_SEP__CLAIM_A, MIGRATION_NOTE_STORAGE_SLOT},
    signature::MigrationSignature,
};
use super::{migration_note::MigrationNote, MigrationNoteProofData};
use aztec::{
    context::PrivateContext,
    note::note_interface::NoteHash,
    protocol::{abis::block_header::BlockHeader, address::AztecAddress, traits::{Hash, Packable}},
};
use migration_archive_registry::MigrationArchiveRegistry::MigrationArchiveRegistry;
use poseidon::poseidon2::Poseidon2Hasher;
use std::{embedded_curve_ops::EmbeddedCurvePoint as Point, hash::Hasher};

pub struct MigrationModeA {
    context: &mut PrivateContext,
    old_app: AztecAddress,
    migration_archive_registry: AztecAddress,
    block_header: BlockHeader,
    mpk: Point,
    current_rollup: Field,
    hasher: Poseidon2Hasher,
}

pub struct MigrationFinished;

impl MigrationModeA {
    pub fn new<Env>(
        context: &mut PrivateContext,
        old_app: AztecAddress,
        migration_archive_registry: AztecAddress,
        block_header: BlockHeader,
        mpk: Point,
        builder: fn[Env](MigrationModeA) -> MigrationFinished,
    ) {
        let _ = builder(
            Self {
                context,
                old_app,
                migration_archive_registry,
                block_header,
                mpk,
                current_rollup: context.version(),
                hasher: Poseidon2Hasher::default(),
            },
        );
    }

    pub fn with_note<T: Packable>(mut self, note_proof_data: MigrationNoteProofData<T>) -> Self {
        let note_hash = self.migrate_note(note_proof_data);
        self.hasher.write(note_hash);
        self
    }

    pub fn finish(
        self,
        recipient: AztecAddress,
        signature: MigrationSignature,
    ) -> MigrationFinished {
        let old_rollup = self.block_header.global_variables.version;
        let new_app = self.context.this_address();

        let notes_hash = self.hasher.finish();

        signature.verify_migration_signature::<DOM_SEP__CLAIM_A>(
            old_rollup,
            self.current_rollup,
            notes_hash,
            recipient,
            new_app,
            self.mpk,
        );

        let block_hash = self.block_header.hash();
        MigrationArchiveRegistry::at(self.migration_archive_registry)
            .verify_migration_mode_a(self.block_header.global_variables.block_number, block_hash)
            .call(self.context);
        MigrationFinished {}
    }

    /// Verify a single MigrationNote's inclusion and emit its nullifier.
    fn migrate_note<T: Packable>(self, note_proof_data: MigrationNoteProofData<T>) -> Field {
        // Reconstruct the MigrationNote and compute its hash
        let migration_note = MigrationNote::new(
            self.old_app,
            self.mpk,
            self.current_rollup,
            note_proof_data.data,
        );

        let note_hash = migration_note.compute_note_hash(
            AztecAddress::zero(), // (owner is ignored by #[custom_note] - mpk serves as ownership proof)
            MIGRATION_NOTE_STORAGE_SLOT,
            note_proof_data.randomness,
        );

        let _unique_note_hash = note_proof_data.verify_note_inclusion(
            self.old_app,
            note_hash,
            self.block_header.state.partial.note_hash_tree.root,
        );
        // Emit nullifier keyed to note randomness (prevents double-claiming, preserves
        // privacy since observers cannot link old/new rollup identities)
        let wrapped_randomness = AztecAddress { inner: note_proof_data.randomness };
        let migration_nullifier =
            migration_note.compute_nullifier(self.context, wrapped_randomness, note_hash);
        self.context.push_nullifier(migration_nullifier);
        note_hash
    }
}
