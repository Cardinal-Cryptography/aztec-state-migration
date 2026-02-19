use crate::{
    archive_proof_data::ArchiveProofData,
    constants::{CLAIM_DOMAIN_A, MIGRATION_MODE_A_STORAGE_SLOT},
    signature::MigrationSignature,
};
use super::{
    migration_data_event::MigrationDataEvent, migration_note::MigrationNote, MigrationNoteProofData,
};
use aztec::{
    context::PrivateContext,
    event::event_emission::emit_event_in_private,
    messages::message_delivery::MessageDelivery,
    note::{lifecycle::create_note, note_interface::NoteHash},
    protocol_types::{address::AztecAddress, hash::poseidon2_hash, traits::{Packable, Serialize}},
};
use migration_archive_registry::MigrationArchiveRegistry;
use std::embedded_curve_ops::EmbeddedCurvePoint as Point;

/// Lock notes on the OLD rollup for cross-rollup migration.
///
/// Called as a library function from the app contract's private context.
/// For each element in `migration_data`, creates a MigrationNote committed to
/// the note hash tree under the caller's address. The note binds the user's
/// migration public key (`mpk`) and `destination_rollup`, so only the holder
/// of the corresponding secret key can claim on the target rollup.
///
/// Notes are stored under `MIGRATION_NOTE_STORAGE_SLOT` - app contracts must
/// not use this slot for their own storage.
///
/// # Parameters
/// - `context`: the calling app contract's private context
/// - `notes_owner`: account that will own the notes in PXE (for note discovery)
/// - `destination_rollup`: version identifier of the target rollup (prevents replay)
/// - `mpk`: migration public key (Grumpkin point); must be on-curve
/// - `migration_data`: app-specific data to lock (one note per element)
pub fn lock_migration_notes<T, let N: u32>(
    context: &mut PrivateContext,
    notes_owner: AztecAddress,
    destination_rollup: Field,
    mpk: Point,
    migration_data: [T; N],
)
where
    T: Packable + Serialize,
{
    assert(
        (mpk.y * mpk.y == mpk.x * mpk.x * mpk.x - 17) & (!mpk.is_infinite),
        "mpk not on Grumpkin curve",
    );

    let note_creator = context.this_address();
    for i in 0..N {
        let migration_note =
            MigrationNote::new(note_creator, mpk, destination_rollup, migration_data[i]);
        create_note(
            context,
            notes_owner,
            MIGRATION_MODE_A_STORAGE_SLOT,
            migration_note,
        )
            .deliver(MessageDelivery.CONSTRAINED_ONCHAIN);

        // Emit migration data as an encrypted private event so the recipient can
        // reconstruct the original data when claiming on the new rollup.
        emit_event_in_private(
            context,
            MigrationDataEvent { migration_data: migration_data[i] },
        )
            .deliver_to(notes_owner, MessageDelivery.CONSTRAINED_ONCHAIN);
    }
}

/// Claim locked notes on the NEW rollup by proving their inclusion in the old
/// rollup's state.
///
/// Verification chain:
///   1. Derive `mpk` from the caller-supplied `msk` to authenticate ownership.
///   2. For each `MigrationNoteProofData`, reconstruct the note hash and verify it
///      exists in the old rollup's note hash tree (via Merkle proof).
///   3. Recompute the archive root from the block header and its sibling path.
///   4. Enqueue a public call to the MigrationArchiveRegistry to verify the computed
///      archive root matches the one registered on-chain (bridged from L1).
///
/// Each verified note emits a nullifier (keyed to note randomness) to prevent double-claiming.
///
/// # Parameters
/// - `context`: the calling app contract's private context on the new rollup
/// - `migration_archive_registry`: address of the MigrationArchiveRegistry contract (holds registered archive roots)
/// - `old_app`: address of the app contract on the old rollup (used for note siloing)
/// - `note_proof_data`: per-note inclusion proofs and migration data
/// - `migration_args`: archive-level proof (block header, sibling path) and migration secret key
pub fn migrate_notes_mode_a<T: Packable, let N: u32>(
    context: &mut PrivateContext,
    migration_archive_registry: AztecAddress,
    mpk: Point,
    signature: MigrationSignature,
    old_app: AztecAddress,
    note_proof_data: [MigrationNoteProofData<T>; N],
    archive_proof_data: ArchiveProofData,
) {
    // ============================================================
    // 1. Verify each note's inclusion in the old rollup's note hash tree
    // ============================================================
    let mut note_hashes: [Field; N] = [0; N];
    let current_rollup = context.version();
    let note_hash_tree_root =
        archive_proof_data.archive_block_header.state.partial.note_hash_tree.root;

    for i in 0..N {
        let note_hash = migrate_note(
            context,
            old_app,
            mpk,
            current_rollup,
            note_proof_data[i],
            note_hash_tree_root,
        );
        note_hashes[i] = note_hash;
    }

    // ============================================================
    // 2. Verify the migration signature over the set of notes and migration context
    // ============================================================
    let notes_hash = poseidon2_hash(note_hashes);
    let old_rollup = archive_proof_data.archive_block_header.global_variables.version;
    let recipient = context.msg_sender().unwrap();
    let new_app_address = context.this_address();

    signature.verify_migration_signature::<CLAIM_DOMAIN_A>(
        old_rollup,
        current_rollup,
        notes_hash,
        recipient,
        new_app_address,
        mpk,
    );

    // ============================================================
    // 3. Compute archive root from block header
    // ============================================================
    let computed_archive_root = archive_proof_data.compute_archive_root();

    // ============================================================
    // 4. Enqueue public check: computed archive root must match the one
    //    registered in MigrationArchiveRegistry (bridged from L1)
    // ============================================================
    MigrationArchiveRegistry::at(migration_archive_registry)
        .verify_migration_mode_a(
            archive_proof_data.archive_block_header.global_variables.block_number,
            computed_archive_root,
        )
        .enqueue(context);
}

/// Verify a single MigrationNote's inclusion and emit its nullifier.
///
/// Reconstructs the note hash following the same pipeline the protocol uses
/// when committing notes:
///   note_hash -> siloed_note_hash (with contract address) -> unique_note_hash (with nonce)
/// Then verifies the unique hash against the note hash tree root via Merkle proof.
fn migrate_note<T: Packable>(
    context: &mut PrivateContext,
    old_app_address: AztecAddress,
    mpk: Point,
    current_rollup: Field,
    note_proof_data: MigrationNoteProofData<T>,
    note_hash_tree_root: Field,
) -> Field {
    // Reconstruct the MigrationNote and compute its hash
    let migration_note =
        MigrationNote::new(old_app_address, mpk, current_rollup, note_proof_data.data);

    let note_hash = migration_note.compute_note_hash(
        AztecAddress::zero(), // (owner is ignored by #[custom_note] - mpk serves as ownership proof)
        MIGRATION_MODE_A_STORAGE_SLOT,
        note_proof_data.randomness,
    );

    let _unique_note_hash =
        note_proof_data.verify_note_inclusion(old_app_address, note_hash, note_hash_tree_root);

    // Emit nullifier keyed to note randomness (prevents double-claiming, preserves
    // privacy since observers cannot link old/new rollup identities)
    let wrapped_randomness = AztecAddress { inner: note_proof_data.randomness };
    let migration_nullifier =
        migration_note.compute_nullifier(context, wrapped_randomness, note_hash);
    context.push_nullifier(migration_nullifier);
    note_hash
}
