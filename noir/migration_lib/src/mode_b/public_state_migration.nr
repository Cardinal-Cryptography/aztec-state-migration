use crate::ArchiveProofData;
use super::FullKeyNote;
use aztec::{
    context::private_context::PrivateContext,
    note::note_interface::NoteHash,
    protocol_types::{
        address::{AztecAddress, partial_address::PartialAddress},
        constants::{
            GENERATOR_INDEX__NOTE_NULLIFIER, GENERATOR_INDEX__NSK_M,
            GENERATOR_INDEX__PUBLIC_LEAF_INDEX, PUBLIC_DATA_TREE_HEIGHT,
        },
        hash::{
            compute_siloed_note_hash, compute_siloed_nullifier, compute_unique_note_hash,
            poseidon2_hash, poseidon2_hash_with_separator,
        },
        merkle_tree::root::root_from_sibling_path,
        public_keys::{NpkM, PublicKeys},
        traits::{Deserialize, Hash, Packable, Serialize, ToField},
        utils::field::{full_field_greater_than, full_field_less_than},
    },
};
use migration_archive_registry::MigrationArchiveRegistry;
use migration_key_registry::MigrationKeyRegistry::STORAGE_LAYOUT_MigrationKeyRegistry;
use std::embedded_curve_ops::{EmbeddedCurveScalar as Scalar, fixed_base_scalar_mul};

pub global CLAIM_DOMAIN_B_PUBLIC: Field = 0xdeadbeef; // placeholder

#[derive(Packable, Serialize, Deserialize)]
pub struct PublicDataSlotProofData {
    // Leaf preimage fields (indexed tree leaf)
    pub next_slot: Field,
    pub next_index: Field,
    // Merkle inclusion proof
    pub leaf_index: Field,
    pub sibling_path: [Field; PUBLIC_DATA_TREE_HEIGHT],
}

pub fn migrate_public_state_map_mode_b<T, let N: u32>(
    context: &mut PrivateContext,
    migration_archive_registry: AztecAddress,
    signature: [u8; 64],
    old_app: AztecAddress,
    base_storage_slot: Field,
    public_data: T,
    public_data_slot_proofs: [PublicDataSlotProofData; N],
    archive_proof_data: ArchiveProofData,
    old_owner: AztecAddress,
    public_keys: PublicKeys,
    partial_address: Field,
    full_key_note: FullKeyNote,
    nsk: Scalar,
)
where
    T: Packable,
{
    let derived_storage_slot = poseidon2_hash([base_storage_slot, old_owner.to_field()]);
    migrate_public_state_mode_b(
        context,
        migration_archive_registry,
        signature,
        old_app,
        derived_storage_slot,
        public_data,
        public_data_slot_proofs,
        archive_proof_data,
        old_owner,
        public_keys,
        partial_address,
        full_key_note,
        nsk,
    )
}

pub fn migrate_public_state_mode_b<T: Packable, let N: u32>(
    context: &mut PrivateContext,
    migration_archive_registry: AztecAddress,
    signature: [u8; 64],
    old_app: AztecAddress,
    base_storage_slot: Field,
    public_data: T,
    public_data_slot_proofs: [PublicDataSlotProofData; N],
    archive_proof_data: ArchiveProofData,
    old_owner: AztecAddress,
    public_keys: PublicKeys,
    partial_address: Field,
    full_key_note: FullKeyNote,
    nsk: Scalar,
) {
    assert(
        <T as Packable>::N == N,
        "Proof data length must match the number of fields in the struct",
    );
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

    // ============================================================
    // 2. Verify public data existed in the public data tree
    // ============================================================
    // Each serialized field occupies a consecutive storage slot (S, S+1, ..., S+N-1).
    // We verify each field's inclusion in the public data tree separately.

    let public_state_tree_root =
        archive_proof_data.archive_block_header.state.partial.public_data_tree.root;

    let serialized = public_data.pack();

    for i in 0..N {
        let slot_i = base_storage_slot + i as Field;

        // Compute the siloed storage slot (public data tree index) using the protocol's domain separator
        let public_data_tree_index = poseidon2_hash_with_separator(
            [old_app.to_field(), slot_i],
            GENERATOR_INDEX__PUBLIC_LEAF_INDEX,
        );

        // Compute leaf hash from the preimage (must match PublicDataTreeLeafPreimage::hash())
        let leaf_hash = poseidon2_hash([
            public_data_tree_index,
            serialized[i],
            public_data_slot_proofs[i].next_index,
            public_data_slot_proofs[i].next_slot,
        ]);

        // Verify the leaf is in the public data tree
        let computed_public_data_root = root_from_sibling_path(
            leaf_hash,
            public_data_slot_proofs[i].leaf_index,
            public_data_slot_proofs[i].sibling_path,
        );
        assert(
            computed_public_data_root == public_state_tree_root,
            "Public data not in public data tree",
        );
    }

    // Verify the computed address matches the public data owner
    let computed_address =
        AztecAddress::compute(public_keys, PartialAddress::from_field(partial_address));
    assert(computed_address == old_owner, "Address does not match public keys derived from nsk");

    let nullifier_tree_root =
        archive_proof_data.archive_block_header.state.partial.nullifier_tree.root;
    let note_hash_tree_root =
        archive_proof_data.archive_block_header.state.partial.note_hash_tree.root;

    // ============================================================
    // 3. Authentication
    // ============================================================

    let public_state_hash = poseidon2_hash(public_data.pack());
    let old_rollup = archive_proof_data.archive_block_header.global_variables.version;
    let current_rollup = context.version();
    let recipient = context.msg_sender().unwrap().to_field();
    let new_app = context.this_address().to_field();

    let msg = poseidon2_hash([
        CLAIM_DOMAIN_B_PUBLIC,
        old_rollup,
        current_rollup,
        public_state_hash,
        recipient,
        new_app,
    ]);
    assert(
        schnorr::verify_signature(full_key_note.note.mpk, signature, msg.to_be_bytes::<32>()),
        "Invalid migration signature",
    );

    // ============================================================
    // 4. Compute MigrationKeyNote hash (includes owner for binding)
    // ============================================================
    let key_note_hash = full_key_note.note.compute_note_hash(
        old_owner,
        STORAGE_LAYOUT_MigrationKeyRegistry.fields.registered_keys.slot,
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
    // 5. Verify MigrationKeyNote inclusion in note hash tree
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
    // 6. Compute and verify MigrationKeyNote non-nullification
    // ============================================================
    // Derive nsk_app for the old key registry contract
    let nsk_app_key = poseidon2_hash_with_separator(
        [nsk.hi, nsk.lo, old_registry.to_field()],
        GENERATOR_INDEX__NSK_M,
    );
    let key_inner_nullifier =
        poseidon2_hash_with_separator([key_unique, nsk_app_key], GENERATOR_INDEX__NOTE_NULLIFIER);
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
    // 7. Push migration nullifiers (one per slot, prevents double-claiming)
    // ============================================================
    for i in 0..N {
        let slot_i = base_storage_slot + i as Field;
        let public_data_tree_index = poseidon2_hash_with_separator(
            [old_app.to_field(), slot_i],
            GENERATOR_INDEX__PUBLIC_LEAF_INDEX,
        );
        let migration_nullifier = poseidon2_hash_with_separator(
            [public_data_tree_index, serialized[i]],
            GENERATOR_INDEX__NOTE_NULLIFIER,
        );
        context.push_nullifier(migration_nullifier);
    }

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
        .verify_migration_mode_b(computed_archive_root)
        .enqueue(context);
}
