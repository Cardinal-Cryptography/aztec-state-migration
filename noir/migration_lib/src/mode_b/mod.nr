use crate::ArchiveProofData;
use aztec::{
    context::private_context::PrivateContext,
    note::note_interface::NoteHash,
    protocol_types::{
        address::{AztecAddress, partial_address::PartialAddress},
        constants::{
            GENERATOR_INDEX__NOTE_NULLIFIER,
            GENERATOR_INDEX__NSK_M, NOTE_HASH_TREE_HEIGHT, NULLIFIER_TREE_HEIGHT,
        },
        hash::{
            compute_siloed_note_hash, compute_siloed_nullifier, compute_unique_note_hash,
            poseidon2_hash, poseidon2_hash_with_separator,
        },
        merkle_tree::root::root_from_sibling_path,
        public_keys::{ NpkM, PublicKeys},
        traits::{Hash, Packable, Serialize, ToField},
        utils::field::{full_field_greater_than, full_field_less_than},
    },
};
use migration_archive_registry::MigrationArchiveRegistry;
use migration_key_registry::MigrationKeyNote;
use std::embedded_curve_ops::{
    EmbeddedCurvePoint as Point, EmbeddedCurveScalar as Scalar, fixed_base_scalar_mul,
};

pub global CLAIM_DOMAIN_B: Field = 0x18ca708ad6dca829b497a77f901adeefeb108751ceae07b68c22499a1da0e40e; // poseidon2 of "migration_mode_b" as ASCII

/// A note together with its inclusion proof and nullifier non-inclusion proof data.
/// Carries everything needed to verify that a note exists in the note hash tree
/// and has not been nullified in the nullifier tree at a given snapshot height.
#[derive(Serialize, Packable)]
pub struct FullProofData<Note> {
    pub note: Note,
    // Note indexing
    pub storage_slot: Field,
    // Note randomness
    pub randomness: Field,
    // Note uniqueness
    pub nonce: Field,
    // Note inclusion proof
    pub leaf_index: Field,
    pub sibling_path: [Field; NOTE_HASH_TREE_HEIGHT],
    // Note non-nullification proof (low-leaf witnesses only; nullifier is computed)
    pub low_nullifier_value: Field,
    pub low_nullifier_next_value: Field,
    pub low_nullifier_next_index: Field,
    pub low_nullifier_leaf_index: Field,
    pub low_nullifier_sibling_path: [Field; NULLIFIER_TREE_HEIGHT],
}

pub type FullKeyNote = FullProofData<MigrationKeyNote>;

// ============================================================
// Mode B: Emergency Snapshot Migration (on NEW rollup)
// ============================================================
//
// Verification chain:
//   1. Address verification: nsk -> npk_m, verify pubkeys match owner address
//   2. Notes inclusion in note_hash_tree at snapshot H
//   3. Notes non-nullification at snapshot H (constrained nullifier derivation)
//   4. MigrationKeyNote inclusion in note_hash_tree at snapshot H
//   5. MigrationKeyNote non-nullification at snapshot H (constrained nullifier derivation)
//   6. Authentication: verify signature over migration context and notes hashes against mpk
//   7. Archive root verification via block header + merkle proof

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
/// - `mpk`:                           Migration public key used to verify the claim signature.
/// - `signature`:                     Schnorr signature over the migration message.
/// - `old_app`:                       Address of the contract that owned the notes on the old rollup.
/// - `full_proof_data`:                    Array of notes with inclusion and non-nullification proofs.
/// - `archive_proof_data`:                  Block header and archive Merkle proof for the snapshot block.
/// - `notes_owner`:                   Address that owned the notes on the old rollup.
/// - `public_keys`:                   Owner's public key set (npk_m is re-derived from `nsk`).
/// - `partial_address`:               Owner's partial address for address re-computation.
/// - `full_key_note`:                 `MigrationKeyNote` with inclusion and non-nullification proofs.
/// - `nsk`:                           Master nullifier secret key (used to derive npk_m and nsk_app).
pub fn migrate_notes_mode_b<Note: NoteHash, let N: u32>(
    context: &mut PrivateContext,
    migration_archive_registry: AztecAddress,
    mpk: Point,
    signature: [u8; 64],
    old_app: AztecAddress,
    full_proof_data: [FullProofData<Note>; N],
    archive_proof_data: ArchiveProofData,
    notes_owner: AztecAddress,
    public_keys: PublicKeys,
    partial_address: Field,
    full_key_note: FullKeyNote,
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

    // Verify the computed address matches the balance note owner
    let computed_address =
        AztecAddress::compute(public_keys, PartialAddress::from_field(partial_address));
    assert(computed_address == notes_owner, "Address does not match public keys derived from nsk");

    // ============================================================
    // 2. Extract snapshot height from block header (verified against stored value in public call)
    // ============================================================
    let snapshot_height = archive_proof_data.archive_block_header.global_variables.block_number;

    // ============================================================
    // 3. For each note, verify inclusion and non-nullification in the snapshot state
    // ============================================================

    let nullifier_tree_root = archive_proof_data.archive_block_header.state.partial.nullifier_tree.root;
    let note_hash_tree_root = archive_proof_data.archive_block_header.state.partial.note_hash_tree.root;

    // Derive nsk_app for the old app contract:
    let nsk_app = poseidon2_hash_with_separator(
        [nsk.hi, nsk.lo, old_app.to_field()],
        GENERATOR_INDEX__NSK_M,
    );

    let mut notes_hashes: [Field; N] = [0; N];

    for i in 0..N {
        notes_hashes[i] = migrate_note(
            context,
            notes_owner,
            full_proof_data[i],
            old_app,
            note_hash_tree_root,
            nullifier_tree_root,
            nsk_app,
        );
    }

    // ============================================================
    // 4. Authentication: verify the migration signature over the set of notes and migration context
    // ============================================================

    // notes_hash = poseidon2_hash([note1_hash, note2_hash, ...])
    // msg = poseidon2(CLAIM_DOMAIN, "B", old_rollup_id, dest_rollup_id, notes_hash, recipient_address, new_app_address)
    let notes_hash = poseidon2_hash(notes_hashes);
    let old_rollup = archive_proof_data.archive_block_header.global_variables.version;
    let current_rollup = context.version();
    let recipient = context.msg_sender().unwrap().to_field();
    let new_app = context.this_address().to_field();

    let msg = poseidon2_hash([CLAIM_DOMAIN_B, old_rollup, current_rollup, notes_hash, recipient, new_app]);
    assert(
        schnorr::verify_signature(
            mpk,
            signature,
            msg.to_be_bytes::<32>(),
        ),
        "Invalid migration signature",
    );

    // ============================================================
    // 5. Compute MigrationKeyNote hash (includes owner for binding)
    // ============================================================
    let key_note_hash = full_key_note.note.compute_note_hash(
        notes_owner,
        full_key_note.storage_slot,
        full_key_note.randomness,
    );
    // Silo by old key registry contract address
    let old_registry = MigrationArchiveRegistry::at(migration_archive_registry)
        .get_old_key_registry()
        .call(context);
    let key_siloed = compute_siloed_note_hash(old_registry, key_note_hash);
    // Make unique with nonce
    let key_unique = compute_unique_note_hash(full_key_note.nonce, key_siloed);

    // ============================================================
    // 6. Verify MigrationKeyNote inclusion in note hash tree
    // ============================================================
    let computed_key_note_root = root_from_sibling_path(
        key_unique,
        full_key_note.leaf_index,
        full_key_note.sibling_path,
    );
    assert(
        computed_key_note_root == note_hash_tree_root,
        "Migration key note not in note hash tree",
    );

    // ============================================================
    // 7. Compute and verify MigrationKeyNote non-nullification
    // ============================================================
    // Derive nsk_app for the old key registry contract
    let nsk_app_key = poseidon2_hash_with_separator(
        [nsk.hi, nsk.lo, old_registry.to_field()],
        GENERATOR_INDEX__NSK_M,
    );
    let key_inner_nullifier = poseidon2_hash_with_separator(
        [key_unique, nsk_app_key],
        GENERATOR_INDEX__NOTE_NULLIFIER,
    );
    let key_note_siloed_nullifier = compute_siloed_nullifier(old_registry, key_inner_nullifier);

    let key_low_leaf_hash = poseidon2_hash([
        full_key_note.low_nullifier_value,
        full_key_note.low_nullifier_next_value,
        full_key_note.low_nullifier_next_index,
    ]);
    let computed_key_nullifier_root = root_from_sibling_path(
        key_low_leaf_hash,
        full_key_note.low_nullifier_leaf_index,
        full_key_note.low_nullifier_sibling_path,
    );
    assert(
        computed_key_nullifier_root == nullifier_tree_root,
        "Key low nullifier leaf not in nullifier tree",
    );
    assert(
        full_field_less_than(full_key_note.low_nullifier_value, key_note_siloed_nullifier),
        "Key nullifier non-inclusion: low leaf not less than target",
    );
    assert(
        full_field_greater_than(
            full_key_note.low_nullifier_next_value,
            key_note_siloed_nullifier,
        )
            | (full_key_note.low_nullifier_next_index == 0),
        "Key nullifier non-inclusion: next leaf not greater than target",
    );

    // ============================================================
    // 8. Compute archive root from block header
    // ============================================================
    let archive_block_header_hash = archive_proof_data.archive_block_header.hash();
    let computed_archive_root = root_from_sibling_path(
        archive_block_header_hash,
        archive_proof_data.archive_leaf_index,
        archive_proof_data.archive_sibling_path,
    );

    // ============================================================
    // 9. Enqueue public verification of archive root and snapshot height
    // ============================================================
    MigrationArchiveRegistry::at(migration_archive_registry)
        .verify_migration_mode_b(snapshot_height, computed_archive_root)
        .enqueue(context);
}

/// Verify a single note's inclusion in the note hash tree and non-nullification
/// in the nullifier tree, then push a migration nullifier to prevent double-claiming.
/// Returns the inner note hash (used to build the aggregate `notes_hash` for signature verification).
fn migrate_note<Note: NoteHash>(
    context: &mut PrivateContext,
    notes_owner: AztecAddress,
    full_note: FullProofData<Note>,
    old_app: AztecAddress,
    note_hash_tree_root: Field,
    nullifier_tree_root: Field,
    nsk_app: Field,
) -> Field {
    // ============================================================
    // 1. Compute Note hash and verify inclusion in note hash tree
    // ============================================================

    let note_hash = full_note.note.compute_note_hash(
        notes_owner,
        full_note.storage_slot,
        full_note.randomness,
    );
    let note_siloed = compute_siloed_note_hash(old_app, note_hash);
    let note_unique = compute_unique_note_hash(full_note.nonce, note_siloed);
    let computed_note_root = root_from_sibling_path(
        note_unique,
        full_note.leaf_index,
        full_note.sibling_path,
    );
    assert(computed_note_root == note_hash_tree_root, "Note not in note hash tree");

    // ============================================================
    // 3. Compute and verify Note non-nullification
    // ============================================================

    // Use the unique note hash for nullifier computation, matching the protocol's behavior
    // for settled notes (compute_nullifier receives the unique hash, not the inner hash).
    let inner_nullifier =
        poseidon2_hash_with_separator([note_unique, nsk_app], GENERATOR_INDEX__NOTE_NULLIFIER);
    let siloed_nullifier = compute_siloed_nullifier(old_app, inner_nullifier);

    // Compute low leaf hash: poseidon2_hash([nullifier, next_nullifier, next_index])
    let low_leaf_hash = poseidon2_hash([
        full_note.low_nullifier_value,
        full_note.low_nullifier_next_value,
        full_note.low_nullifier_next_index,
    ]);
    // Verify low leaf is in the nullifier tree
    let computed_nullifier_root = root_from_sibling_path(
        low_leaf_hash,
        full_note.low_nullifier_leaf_index,
        full_note.low_nullifier_sibling_path,
    );
    assert(
        computed_nullifier_root == nullifier_tree_root,
        "Note low nullifier leaf not in nullifier tree",
    );
    // Sandwich check: low_value < target < next_value (or next is max)
    assert(
        full_field_less_than(full_note.low_nullifier_value, siloed_nullifier),
        "Note nullifier non-inclusion: low leaf not less than target",
    );
    assert(
        full_field_greater_than(full_note.low_nullifier_next_value, siloed_nullifier)
            | (full_note.low_nullifier_next_index == 0),
        "Note nullifier non-inclusion: next leaf not greater than target",
    );

    // ============================================================
    // 4. Push migration nullifier (prevents double-claiming)
    // ============================================================
    let migration_nullifier = poseidon2_hash_with_separator(
        [note_unique, full_note.randomness],
        GENERATOR_INDEX__NOTE_NULLIFIER,
    );
    context.push_nullifier(migration_nullifier);

    note_hash
}
