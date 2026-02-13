use crate::{migration_note::{MIGRATION_NOTE_STORAGE_SLOT, MigrationNote}, MigratorModeA};
use aztec::{
    context::PrivateContext,
    messages::message_delivery::MessageDelivery,
    note::{lifecycle::create_note, note_interface::NoteHash},
    protocol_types::{
        abis::block_header::BlockHeader,
        address::AztecAddress,
        constants::{ARCHIVE_HEIGHT, NOTE_HASH_TREE_HEIGHT},
        hash::{compute_siloed_note_hash, compute_unique_note_hash},
        merkle_tree::root::root_from_sibling_path,
        traits::{Deserialize, Hash, Packable, Serialize},
    },
};
pub use std::embedded_curve_ops::EmbeddedCurvePoint as Point;
pub use std::embedded_curve_ops::EmbeddedCurveScalar as Scalar;
use std::embedded_curve_ops::fixed_base_scalar_mul;

#[derive(Serialize)]
pub struct MigrationArgs {
    pub(crate) msk: Scalar,
    // Block header
    pub archive_block_header: BlockHeader,
    // Archive membership proof
    pub archive_leaf_index: Field,
    pub archive_sibling_path: [Field; ARCHIVE_HEIGHT],
}

/// Per-note inclusion proof data needed to verify a MigrationNote exists in the
/// old rollup's note hash tree. Supplied by the migrating user alongside `MigrationArgs`.
#[derive(Deserialize, Serialize, Packable)]
pub struct FullMigrationNote {
    pub migration_data: Field,
    pub randomness: Field,
    pub nonce: Field,
    pub leaf_index: Field,
    pub sibling_path: [Field; NOTE_HASH_TREE_HEIGHT],
}

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
/// - `note_owner`: account that will own the notes in PXE (for note discovery)
/// - `destination_rollup`: version identifier of the target rollup (prevents replay)
/// - `mpk`: migration public key (Grumpkin point); must be on-curve
/// - `migration_data`: app-specific data to lock (one note per element)
pub fn lock_migration_notes<let N: u32>(
    context: &mut PrivateContext,
    note_owner: AztecAddress,
    destination_rollup: Field,
    mpk: Point,
    migration_data: [Field; N],
) {
    assert(mpk.y * mpk.y == mpk.x * mpk.x * mpk.x - 17, "mpk not on Grumpkin curve");

    let note_creator = context.this_address();
    for i in 0..N {
        let migration_note =
            MigrationNote::new(note_creator, mpk, destination_rollup, migration_data[i]);
        create_note(
            context,
            note_owner,
            MIGRATION_NOTE_STORAGE_SLOT,
            migration_note,
        )
            .deliver(MessageDelivery.CONSTRAINED_ONCHAIN);
    }
}

/// Claim locked notes on the NEW rollup by proving their inclusion in the old
/// rollup's state.
///
/// Verification chain:
///   1. Derive `mpk` from the caller-supplied `msk` to authenticate ownership.
///   2. For each `FullMigrationNote`, reconstruct the note hash and verify it
///      exists in the old rollup's note hash tree (via Merkle proof).
///   3. Recompute the archive root from the block header and its sibling path.
///   4. Enqueue a public call to the MigratorRegistry to verify the computed
///      archive root matches the one registered on-chain (bridged from L1).
///
/// Each verified note emits a nullifier (keyed to `msk`) to prevent double-claiming.
///
/// # Parameters
/// - `context`: the calling app contract's private context on the new rollup
/// - `migrator_registry`: address of the MigratorRegistry contract (holds registered archive roots)
/// - `old_app_address`: address of the app contract on the old rollup (used for note siloing)
/// - `full_notes`: per-note inclusion proofs and migration data
/// - `migration_args`: archive-level proof (block header, sibling path) and migration secret key
pub fn migrate_notes<let N: u32>(
    context: &mut PrivateContext,
    migrator_registry: AztecAddress,
    old_app_address: AztecAddress,
    full_notes: [FullMigrationNote; N],
    migration_args: MigrationArgs,
) {
    // 1. Derive mpk from msk to authenticate the migrating user
    let current_rollup = context.version();
    let mpk = fixed_base_scalar_mul(migration_args.msk);

    // 2. Verify each note's inclusion in the old rollup's note hash tree
    let note_hash_tree_root = migration_args.archive_block_header.state.partial.note_hash_tree.root;

    for i in 0..N {
        migrate_note(
            context,
            old_app_address,
            mpk,
            migration_args.msk,
            current_rollup,
            full_notes[i],
            note_hash_tree_root,
        );
    }

    // 3. Recompute archive root from block header + sibling path
    let archive_block_header_hash = migration_args.archive_block_header.hash();
    let computed_archive_root = root_from_sibling_path(
        archive_block_header_hash,
        migration_args.archive_leaf_index,
        migration_args.archive_sibling_path,
    );

    // 4. Enqueue public check: computed archive root must match the one
    //    registered in MigratorModeA (bridged from L1)
    MigratorModeA::at(migrator_registry)
        .verify_archive_root(
            migration_args.archive_block_header.global_variables.block_number,
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
fn migrate_note(
    context: &mut PrivateContext,
    old_app_address: AztecAddress,
    mpk: Point,
    msk: Scalar,
    current_rollup: Field,
    full_note: FullMigrationNote,
    note_hash_tree_root: Field,
) {
    // Reconstruct the MigrationNote and compute its hash
    // (owner is ignored by #[custom_note] - mpk serves as ownership proof)
    let migration_note = MigrationNote::new(
        old_app_address,
        mpk,
        current_rollup,
        full_note.migration_data,
    );
    let migration_note_hash = migration_note.compute_note_hash(
        AztecAddress::zero(),
        MIGRATION_NOTE_STORAGE_SLOT,
        full_note.randomness,
    );

    // Replay the protocol's siloing and uniqueness transforms
    let siloed_note_hash = compute_siloed_note_hash(old_app_address, migration_note_hash);
    let unique_note_hash = compute_unique_note_hash(full_note.nonce, siloed_note_hash);

    // Verify inclusion in the note hash tree via Merkle proof
    let computed_note_hash_tree_root = root_from_sibling_path(
        unique_note_hash,
        full_note.leaf_index,
        full_note.sibling_path,
    );
    assert(computed_note_hash_tree_root == note_hash_tree_root, "Lock note not in note hash tree");

    // Emit nullifier keyed to msk (prevents double-claiming, preserves privacy
    // since observers cannot link old/new rollup identities)
    let migration_nullifier =
        MigrationNote::compute_destination_rollup_nullifier(migration_note_hash, msk);
    context.push_nullifier(migration_nullifier);
}
