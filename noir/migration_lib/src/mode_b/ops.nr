use crate::{
    archive_proof_data::ArchiveProofData,
    constants::{CLAIM_DOMAIN_B, CLAIM_DOMAIN_B_PUBLIC},
    signature::MigrationSignature,
};
use super::{FullNoteProofData, KeyNoteProofData, public_state_proof_data::PublicStateProofData};
use aztec::{
    context::private_context::PrivateContext,
    note::note_interface::NoteHash,
    protocol_types::{
        address::{AztecAddress, partial_address::PartialAddress},
        constants::{GENERATOR_INDEX__NOTE_NULLIFIER, GENERATOR_INDEX__NSK_M},
        hash::{poseidon2_hash, poseidon2_hash_with_separator},
        public_keys::{NpkM, PublicKeys},
        traits::{Packable, ToField},
    },
};
use migration_archive_registry::MigrationArchiveRegistry;
use migration_key_registry::MigrationKeyRegistry::STORAGE_LAYOUT_MigrationKeyRegistry;
use std::embedded_curve_ops::{EmbeddedCurveScalar as Scalar, fixed_base_scalar_mul};

// ============================================================
// Mode B: Emergency Snapshot Migration (on NEW rollup)
// ============================================================
//
// Verification chain:
//   1. Address verification: nsk -> npk_m, verify pubkeys match owner address
//   2. Notes inclusion in note_hash_tree at snapshot H
//   3. Notes non-nullification at snapshot H (constrained nullifier derivation)
//   4. MigrationKeyNote inclusion in note_hash_tree at snapshot H
//   5. Authentication: verify signature over migration context and notes hashes against mpk
//   6. Archive root verification via block header + merkle proof

/// Verify and claim a Mode B (emergency snapshot) migration for a batch of notes.
///
/// Proves that each note existed and was not nullified in the old rollup at
/// snapshot height H, authenticates the claim via a Schnorr signature over the
/// migration context, and enqueues a public call to the archive registry for
/// final archive-root and snapshot-height verification.
///
/// # Parameters
/// - `context`:                       Private execution context on the new rollup.
/// - `migration_archive_registry`:    Address of the `MigrationArchiveRegistry` on the new rollup.
/// - `signature`:                     Schnorr signature over the migration message.
/// - `old_app`:                       Address of the contract that owned the notes on the old rollup.
/// - `full_proof_data`:               Array of notes with inclusion and non-nullification proofs.
/// - `expected_storage_slot`:         Expected storage slot for the notes.
/// - `archive_proof_data`:            Block header and archive Merkle proof for the snapshot block.
/// - `notes_owner`:                   Address that owned the notes on the old rollup.
/// - `public_keys`:                   Owner's public key set (npk_m is re-derived from `nsk`).
/// - `partial_address`:               Owner's partial address for address re-computation.
/// - `key_note`:                      `MigrationKeyNote` with inclusion proof.
/// - `nsk`:                           Master nullifier secret key (used to derive npk_m and nsk_app).
pub fn migrate_notes_mode_b<Note: NoteHash, let N: u32>(
    context: &mut PrivateContext,
    migration_archive_registry: AztecAddress,
    signature: MigrationSignature,
    old_app: AztecAddress,
    full_proof_data: [FullNoteProofData<Note>; N],
    expected_storage_slot: Field,
    archive_proof_data: ArchiveProofData,
    notes_owner: AztecAddress,
    public_keys: PublicKeys,
    partial_address: Field,
    key_note: KeyNoteProofData,
    nsk: Scalar,
) {
    // ============================================================
    // 1. Address verification: derive npk_m from nsk, verify address
    // ============================================================
    // Derive nullifier public key from nullifier secret key via Grumpkin scalar mul
    let derived_npk_m = NpkM { inner: fixed_base_scalar_mul(nsk) };

    let public_keys = PublicKeys {
        npk_m: derived_npk_m,
        ivpk_m: public_keys.ivpk_m,
        ovpk_m: public_keys.ovpk_m,
        tpk_m: public_keys.tpk_m,
    };

    // Verify the computed address matches the note owner
    let computed_address =
        AztecAddress::compute(public_keys, PartialAddress::from_field(partial_address));
    assert(computed_address == notes_owner, "Address does not match public keys derived from nsk");

    // ============================================================
    // 2. For each note, verify inclusion and non-nullification in the snapshot state
    // ============================================================

    let nullifier_tree_root =
        archive_proof_data.archive_block_header.state.partial.nullifier_tree.root;
    let note_hash_tree_root =
        archive_proof_data.archive_block_header.state.partial.note_hash_tree.root;

    // Derive nsk_app for the old app contract:
    let nsk_app =
        poseidon2_hash_with_separator([nsk.hi, nsk.lo, old_app.to_field()], GENERATOR_INDEX__NSK_M);

    let mut notes_hashes: [Field; N] = [0; N];

    for i in 0..N {
        notes_hashes[i] = migrate_note(
            context,
            notes_owner,
            full_proof_data[i],
            expected_storage_slot,
            old_app,
            note_hash_tree_root,
            nullifier_tree_root,
            nsk_app,
        );
    }

    // ============================================================
    // 3. Authentication: verify the migration signature over the set of notes and migration context
    // ============================================================
    let notes_hash = poseidon2_hash(notes_hashes);
    let old_rollup = archive_proof_data.archive_block_header.global_variables.version;
    let current_rollup = context.version();
    let recipient = context.msg_sender().unwrap();
    let new_app = context.this_address();

    signature.verify_migration_signature::<CLAIM_DOMAIN_B>(
        old_rollup,
        current_rollup,
        notes_hash,
        recipient,
        new_app,
        key_note.data.mpk,
    );

    // ============================================================
    // 4. Verify MigrationKeyNote inclusion
    // ============================================================

    let key_note_hash = key_note.note_hash(
        notes_owner,
        STORAGE_LAYOUT_MigrationKeyRegistry.fields.registered_keys.slot,
    );

    // Silo by old key registry contract address
    let old_registry = MigrationArchiveRegistry::at(migration_archive_registry)
        .get_old_key_registry()
        .call(context);

    let _ = key_note.verify_note_inclusion(old_registry, key_note_hash, note_hash_tree_root);

    // ============================================================
    // 5. Compute archive root from block header
    // ============================================================
    let computed_archive_root = archive_proof_data.compute_archive_root();

    // ============================================================
    // 6. Enqueue public verification of archive root and snapshot height
    // ============================================================
    MigrationArchiveRegistry::at(migration_archive_registry)
        .verify_migration_mode_b(computed_archive_root)
        .enqueue(context);
}

/// Verify a single note's inclusion in the note hash tree and non-nullification
/// in the nullifier tree, then push a migration nullifier to prevent double-claiming.
/// Returns the inner note hash (used to build the aggregate `notes_hash` for signature verification).
fn migrate_note<Note: NoteHash>(
    context: &mut PrivateContext,
    notes_owner: AztecAddress,
    full_note_proof_data: FullNoteProofData<Note>,
    expected_storage_slot: Field,
    old_app: AztecAddress,
    note_hash_tree_root: Field,
    nullifier_tree_root: Field,
    nsk_app: Field,
) -> Field {
    let note_proof_data = full_note_proof_data.note_proof_data;
    let non_nullification_proof_data = full_note_proof_data.non_nullification_proof_data;
    // ============================================================
    // 1. Compute Note hash and verify inclusion in note hash tree
    // ============================================================

    let note_hash = note_proof_data.note_hash(notes_owner, expected_storage_slot);
    let note_unique =
        note_proof_data.verify_note_inclusion(old_app, note_hash, note_hash_tree_root);

    // ============================================================
    // 2. Compute and verify Note non-nullification
    // ============================================================

    let _ = non_nullification_proof_data.verify_nullifier_non_inclusion(
        nsk_app,
        old_app,
        note_unique,
        nullifier_tree_root,
    );

    // ============================================================
    // 3. Push migration nullifier (prevents double-claiming)
    // ============================================================
    let migration_nullifier = poseidon2_hash_with_separator(
        [note_unique, note_proof_data.randomness],
        GENERATOR_INDEX__NOTE_NULLIFIER,
    );
    context.push_nullifier(migration_nullifier);

    note_hash
}

pub fn migrate_public_state_mode_b<T: Packable>(
    context: &mut PrivateContext,
    migration_archive_registry: AztecAddress,
    signature: MigrationSignature,
    old_app: AztecAddress,
    public_state_proof_data: PublicStateProofData<T, <T as Packable>::N>,
    base_storage_slot: Field,
    archive_proof_data: ArchiveProofData,
    old_owner: AztecAddress,
    key_note: KeyNoteProofData,
) {
    // ============================================================
    // 1. Verify public data existed in the public data tree
    // ============================================================
    let public_state_tree_root =
        archive_proof_data.archive_block_header.state.partial.public_data_tree.root;

    public_state_proof_data.migrate_public_state(
        context,
        base_storage_slot,
        old_app,
        public_state_tree_root,
    );

    let public_state_hash: Field = public_state_proof_data.public_state_hash();
    let old_rollup = archive_proof_data.archive_block_header.global_variables.version;
    let current_rollup = context.version();
    let recipient = context.msg_sender().unwrap();
    let new_app = context.this_address();

    signature.verify_migration_signature::<CLAIM_DOMAIN_B_PUBLIC>(
        old_rollup,
        current_rollup,
        public_state_hash,
        recipient,
        new_app,
        key_note.data.mpk,
    );

    // ============================================================
    // 4. Verify MigrationKeyNote inclusion
    // ============================================================
    let note_hash_tree_root =
        archive_proof_data.archive_block_header.state.partial.note_hash_tree.root;

    let key_note_hash = key_note.note_hash(
        old_owner,
        STORAGE_LAYOUT_MigrationKeyRegistry.fields.registered_keys.slot,
    );

    // Silo by old key registry contract address
    let old_registry = MigrationArchiveRegistry::at(migration_archive_registry)
        .get_old_key_registry()
        .call(context);

    let _ = key_note.verify_note_inclusion(old_registry, key_note_hash, note_hash_tree_root);

    // ============================================================
    // 5. Compute archive root from block header
    // ============================================================
    let computed_archive_root = archive_proof_data.compute_archive_root();

    // ============================================================
    // 6. Enqueue public verification of archive root and snapshot height
    // ============================================================
    MigrationArchiveRegistry::at(migration_archive_registry)
        .verify_migration_mode_b(computed_archive_root)
        .enqueue(context);
}

pub fn migrate_public_map_state_mode_b<T: Packable, K: ToField>(
    context: &mut PrivateContext,
    migration_archive_registry: AztecAddress,
    signature: MigrationSignature,
    old_app: AztecAddress,
    public_state_proof_data: PublicStateProofData<T, <T as Packable>::N>,
    base_storage_slot: Field,
    archive_proof_data: ArchiveProofData,
    old_owner: AztecAddress,
    map_key: K,
    key_note: KeyNoteProofData,
) {
    let derived_storage_slot = poseidon2_hash([base_storage_slot, map_key.to_field()]);
    migrate_public_state_mode_b(
        context,
        migration_archive_registry,
        signature,
        old_app,
        public_state_proof_data,
        derived_storage_slot,
        archive_proof_data,
        old_owner,
        key_note,
    );
}
