use aztec::macros::aztec as aztec_contract;

pub use aztec::protocol_types::constants::{
    ARCHIVE_HEIGHT, NOTE_HASH_TREE_HEIGHT, NULLIFIER_TREE_HEIGHT,
};

#[aztec_contract]
pub contract MigratorModeB {
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        protocol_types::{
            abis::block_header::BlockHeader,
            address::{partial_address::PartialAddress, AztecAddress, EthAddress},
            constants::{
                ARCHIVE_HEIGHT, GENERATOR_INDEX__NOTE_HASH, GENERATOR_INDEX__NOTE_NULLIFIER,
                GENERATOR_INDEX__NSK_M, NOTE_HASH_TREE_HEIGHT, NULLIFIER_TREE_HEIGHT,
            },
            hash::{
                compute_siloed_note_hash, compute_siloed_nullifier, compute_unique_note_hash,
                poseidon2_hash, poseidon2_hash_with_separator,
            },
            merkle_tree::root::root_from_sibling_path,
            public_keys::{IvpkM, NpkM, OvpkM, PublicKeys, TpkM},
            traits::{Hash, ToField},
            utils::field::{full_field_greater_than, full_field_less_than},
        },
        state_vars::{
            map::Map, public_immutable::PublicImmutable, public_mutable::PublicMutable,
        },
    };
    use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, fixed_base_scalar_mul};
    #[storage]
    struct Storage<Context> {
        // L1 Migrator address (for L1-to-L2 message consumption)
        l1_migrator: PublicImmutable<EthAddress, Context>,
        // Old rollup version (for archive root content verification)
        old_rollup_version: PublicImmutable<Field, Context>,
        // Old rollup app address (for siloing UintNote hashes)
        old_app_address: PublicImmutable<AztecAddress, Context>,
        // Old rollup MigrationKeyRegistry address (for siloing MigrationKeyNote hashes)
        old_key_registry: PublicImmutable<AztecAddress, Context>,

        // Mapping: proven_block_number -> archive_root
        old_archive_roots: Map<u32, PublicMutable<Field, Context>, Context>,
        // Track the latest registered proven block
        latest_proven_block: PublicMutable<u32, Context>,
        // Snapshot height H: the block at which Mode B migration is anchored
        snapshot_height: PublicMutable<u32, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(
        l1_migrator: EthAddress,
        old_rollup_version: Field,
        old_app_address: AztecAddress,
        old_key_registry: AztecAddress,
    ) {
        self.storage.l1_migrator.initialize(l1_migrator);
        self.storage.old_rollup_version.initialize(old_rollup_version);
        self.storage.old_app_address.initialize(old_app_address);
        self.storage.old_key_registry.initialize(old_key_registry);
    }

    // ============================================================
    // Archive root registration (same pattern as Mode A Migrator)
    // ============================================================

    #[external("public")]
    fn register_archive_root(
        archive_root: Field,
        proven_block_number: u32,
        secret: Field,
        leaf_index: Field,
    ) {
        let old_rollup_version = self.storage.old_rollup_version.read();
        // Content: poseidon2(oldVersion, archiveRoot, provenBlockNumber)
        let content = poseidon2_hash([
            old_rollup_version,
            archive_root,
            proven_block_number as Field,
        ]);

        // Consume L1-to-L2 message
        self.context.consume_l1_to_l2_message(
            content,
            secret,
            self.storage.l1_migrator.read(),
            leaf_index,
        );

        // Store archive root
        self.storage.old_archive_roots.at(proven_block_number).write(archive_root);

        // Update latest if newer
        let current_latest = self.storage.latest_proven_block.read();
        if proven_block_number as u64 > current_latest as u64 {
            self.storage.latest_proven_block.write(proven_block_number);
        }
    }

    // ============================================================
    // Snapshot height configuration
    // ============================================================

    #[external("public")]
    fn set_snapshot_height(height: u32) {
        let current = self.storage.snapshot_height.read();
        assert(current == 0, "Snapshot height already set");

        // Archive root must be registered for this height
        let archive_root = self.storage.old_archive_roots.at(height).read();
        assert(archive_root != 0, "No archive root registered for this height");

        self.storage.snapshot_height.write(height);
    }

    // ============================================================
    // Mode B: Emergency Snapshot Migration (on NEW rollup)
    // ============================================================
    //
    // Verification chain:
    //   1. Address verification: nsk -> npk_m, verify pubkeys match owner address
    //   2. UintNote (balance) inclusion in note_hash_tree at snapshot H
    //   3. UintNote non-nullification at snapshot H (constrained nullifier derivation)
    //   4. MigrationKeyNote inclusion in note_hash_tree at snapshot H
    //   5. MigrationKeyNote non-nullification at snapshot H (constrained nullifier derivation)
    //   6. Authentication: poseidon2(msk) == mpk_hash from key note
    //   7. Archive root verification via block header + merkle proof

    #[external("private")]
    fn migrate_mode_b(
        // Authentication
        msk: Field,

        // UintNote (balance note) fields
        balance_note_owner: AztecAddress,
        balance_note_value: u128,
        balance_note_storage_slot: Field,
        balance_note_randomness: Field,
        balance_note_nonce: Field,

        // UintNote inclusion proof
        balance_note_leaf_index: Field,
        balance_note_sibling_path: [Field; NOTE_HASH_TREE_HEIGHT],

        // UintNote non-nullification proof (low-leaf witnesses only; nullifier is computed)
        balance_low_nullifier_value: Field,
        balance_low_nullifier_next_value: Field,
        balance_low_nullifier_next_index: Field,
        balance_low_nullifier_leaf_index: Field,
        balance_low_nullifier_sibling_path: [Field; NULLIFIER_TREE_HEIGHT],

        // MigrationKeyNote fields (mpk_hash is derived from msk, not passed separately)
        key_note_storage_slot: Field,
        key_note_randomness: Field,
        key_note_nonce: Field,

        // MigrationKeyNote inclusion proof
        key_note_leaf_index: Field,
        key_note_sibling_path: [Field; NOTE_HASH_TREE_HEIGHT],

        // MigrationKeyNote non-nullification proof (low-leaf witnesses only; nullifier is computed)
        key_low_nullifier_value: Field,
        key_low_nullifier_next_value: Field,
        key_low_nullifier_next_index: Field,
        key_low_nullifier_leaf_index: Field,
        key_low_nullifier_sibling_path: [Field; NULLIFIER_TREE_HEIGHT],

        // Block header at snapshot height
        archive_block_header: BlockHeader,
        // Archive membership proof
        archive_leaf_index: Field,
        archive_sibling_path: [Field; ARCHIVE_HEIGHT],

        // Address preimage: master nullifier secret key (hi/lo) + other public keys + partial address
        // nsk is used to derive npk_m (via EC scalar mul) and nsk_app (for nullifier computation)
        nsk_hi: Field,
        nsk_lo: Field,
        ivpk_m_x: Field,
        ivpk_m_y: Field,
        ovpk_m_x: Field,
        ovpk_m_y: Field,
        tpk_m_x: Field,
        tpk_m_y: Field,
        partial_address: Field,
    ) {
        // 1. Authentication: verify msk corresponds to the registered mpk_hash
        let mpk_hash = poseidon2_hash([msk]);

        // ============================================================
        // 2. Address verification: derive npk_m from nsk, verify address
        // ============================================================
        // Derive nullifier public key from nullifier secret key via Grumpkin scalar mul
        let nsk = EmbeddedCurveScalar { lo: nsk_lo, hi: nsk_hi };
        let npk_m_point = fixed_base_scalar_mul(nsk);

        // Construct full public keys from derived npk_m + witness keys
        let public_keys = PublicKeys {
            npk_m: NpkM {
                inner: npk_m_point,
            },
            ivpk_m: IvpkM {
                inner: EmbeddedCurvePoint { x: ivpk_m_x, y: ivpk_m_y, is_infinite: false },
            },
            ovpk_m: OvpkM {
                inner: EmbeddedCurvePoint { x: ovpk_m_x, y: ovpk_m_y, is_infinite: false },
            },
            tpk_m: TpkM {
                inner: EmbeddedCurvePoint { x: tpk_m_x, y: tpk_m_y, is_infinite: false },
            },
        };

        // Verify the computed address matches the balance note owner
        let computed_address =
            AztecAddress::compute(public_keys, PartialAddress::from_field(partial_address));
        assert(
            computed_address == balance_note_owner,
            "Address does not match public keys derived from nsk",
        );

        // 3. Extract snapshot height from block header (verified against stored value in public call)
        let snapshot_height = archive_block_header.global_variables.block_number;

        // ============================================================
        // 4. Compute UintNote hash (two-step formula from uint_note.nr)
        // ============================================================
        // Step 1: partial commitment = poseidon2([owner, storage_slot, randomness], GEN_NOTE_HASH)
        let balance_partial = poseidon2_hash_with_separator(
            [
                balance_note_owner.to_field(),
                balance_note_storage_slot,
                balance_note_randomness,
            ],
            GENERATOR_INDEX__NOTE_HASH,
        );
        // Step 2: complete hash = poseidon2([partial, value], GEN_NOTE_HASH)
        let balance_note_hash = poseidon2_hash_with_separator(
            [balance_partial, balance_note_value as Field],
            GENERATOR_INDEX__NOTE_HASH,
        );
        // Silo by old app contract address
        let old_app = self.storage.old_app_address.read();
        let balance_siloed = compute_siloed_note_hash(old_app, balance_note_hash);
        // Make unique with nonce
        let balance_unique = compute_unique_note_hash(balance_note_nonce, balance_siloed);

        // ============================================================
        // 5. Verify UintNote inclusion in note hash tree
        // ============================================================
        let note_hash_tree_root = archive_block_header.state.partial.note_hash_tree.root;
        let computed_note_root = root_from_sibling_path(
            balance_unique,
            balance_note_leaf_index,
            balance_note_sibling_path,
        );
        assert(
            computed_note_root == note_hash_tree_root,
            "Balance note not in note hash tree",
        );

        // ============================================================
        // 6. Compute and verify UintNote non-nullification
        // ============================================================
        // Derive nsk_app for the old app contract:
        //   nsk_app = poseidon2([nsk.hi, nsk.lo, contract_address], GENERATOR_INDEX__NSK_M)
        let nsk_app_balance = poseidon2_hash_with_separator(
            [nsk_hi, nsk_lo, old_app.to_field()],
            GENERATOR_INDEX__NSK_M,
        );
        // inner_nullifier = poseidon2([note_hash, nsk_app], NOTE_NULLIFIER)
        let balance_inner_nullifier = poseidon2_hash_with_separator(
            [balance_note_hash, nsk_app_balance],
            GENERATOR_INDEX__NOTE_NULLIFIER,
        );
        // siloed_nullifier = poseidon2([contract_address, inner_nullifier], OUTER_NULLIFIER)
        let balance_note_siloed_nullifier =
            compute_siloed_nullifier(old_app, balance_inner_nullifier);

        let nullifier_tree_root = archive_block_header.state.partial.nullifier_tree.root;

        // Compute low leaf hash: poseidon2_hash([nullifier, next_nullifier, next_index])
        let balance_low_leaf_hash = poseidon2_hash([
            balance_low_nullifier_value,
            balance_low_nullifier_next_value,
            balance_low_nullifier_next_index,
        ]);
        // Verify low leaf is in the nullifier tree
        let computed_nullifier_root = root_from_sibling_path(
            balance_low_leaf_hash,
            balance_low_nullifier_leaf_index,
            balance_low_nullifier_sibling_path,
        );
        assert(
            computed_nullifier_root == nullifier_tree_root,
            "Balance low nullifier leaf not in nullifier tree",
        );
        // Sandwich check: low_value < target < next_value (or next is max)
        assert(
            full_field_less_than(balance_low_nullifier_value, balance_note_siloed_nullifier),
            "Balance nullifier non-inclusion: low leaf not less than target",
        );
        assert(
            full_field_greater_than(
                balance_low_nullifier_next_value,
                balance_note_siloed_nullifier,
            )
                | (balance_low_nullifier_next_index == 0),
            "Balance nullifier non-inclusion: next leaf not greater than target",
        );

        // ============================================================
        // 7. Compute MigrationKeyNote hash (includes owner for binding)
        // ============================================================
        // Hash formula: poseidon2([mpk_hash, owner, storage_slot, randomness], GEN_NOTE_HASH)
        let key_note_hash = poseidon2_hash_with_separator(
            [
                mpk_hash,
                balance_note_owner.to_field(),
                key_note_storage_slot,
                key_note_randomness,
            ],
            GENERATOR_INDEX__NOTE_HASH,
        );
        // Silo by old key registry contract address
        let old_registry = self.storage.old_key_registry.read();
        let key_siloed = compute_siloed_note_hash(old_registry, key_note_hash);
        // Make unique with nonce
        let key_unique = compute_unique_note_hash(key_note_nonce, key_siloed);

        // ============================================================
        // 8. Verify MigrationKeyNote inclusion in note hash tree
        // ============================================================
        let computed_key_note_root = root_from_sibling_path(
            key_unique,
            key_note_leaf_index,
            key_note_sibling_path,
        );
        assert(
            computed_key_note_root == note_hash_tree_root,
            "Migration key note not in note hash tree",
        );

        // ============================================================
        // 9. Compute and verify MigrationKeyNote non-nullification
        // ============================================================
        // Derive nsk_app for the old key registry contract
        let nsk_app_key = poseidon2_hash_with_separator(
            [nsk_hi, nsk_lo, old_registry.to_field()],
            GENERATOR_INDEX__NSK_M,
        );
        let key_inner_nullifier = poseidon2_hash_with_separator(
            [key_note_hash, nsk_app_key],
            GENERATOR_INDEX__NOTE_NULLIFIER,
        );
        let key_note_siloed_nullifier =
            compute_siloed_nullifier(old_registry, key_inner_nullifier);

        let key_low_leaf_hash = poseidon2_hash([
            key_low_nullifier_value,
            key_low_nullifier_next_value,
            key_low_nullifier_next_index,
        ]);
        let computed_key_nullifier_root = root_from_sibling_path(
            key_low_leaf_hash,
            key_low_nullifier_leaf_index,
            key_low_nullifier_sibling_path,
        );
        assert(
            computed_key_nullifier_root == nullifier_tree_root,
            "Key low nullifier leaf not in nullifier tree",
        );
        assert(
            full_field_less_than(key_low_nullifier_value, key_note_siloed_nullifier),
            "Key nullifier non-inclusion: low leaf not less than target",
        );
        assert(
            full_field_greater_than(key_low_nullifier_next_value, key_note_siloed_nullifier)
                | (key_low_nullifier_next_index == 0),
            "Key nullifier non-inclusion: next leaf not greater than target",
        );

        // ============================================================
        // 10. Compute archive root from block header
        // ============================================================
        let archive_block_header_hash = archive_block_header.hash();
        let computed_archive_root = root_from_sibling_path(
            archive_block_header_hash,
            archive_leaf_index,
            archive_sibling_path,
        );

        // ============================================================
        // 11. Push migration nullifier (prevents double-claiming)
        // ============================================================
        let migration_nullifier = poseidon2_hash_with_separator(
            [balance_unique, msk],
            GENERATOR_INDEX__NOTE_NULLIFIER,
        );
        self.context.push_nullifier(migration_nullifier);

        // ============================================================
        // 12. Enqueue public verification of archive root and snapshot height
        // ============================================================
        MigratorModeB::at(self.context.this_address())
            .complete_migration_mode_b(snapshot_height, computed_archive_root)
            .enqueue(self.context);
    }

    // Verify archive root and snapshot height match stored values
    #[external("public")]
    fn complete_migration_mode_b(snapshot_height: u32, computed_archive_root: Field) {
        // Verify snapshot height matches configured value
        let stored_snapshot = self.storage.snapshot_height.read();
        assert(stored_snapshot != 0, "Snapshot height not set");
        assert(snapshot_height == stored_snapshot, "Snapshot height mismatch");

        // Verify archive root
        let stored_archive_root = self.storage.old_archive_roots.at(snapshot_height).read();
        assert(stored_archive_root != 0, "Archive root not registered for snapshot height");
        assert(
            computed_archive_root == stored_archive_root,
            "Archive root mismatch - block header not from old rollup at snapshot height",
        );
    }

    // ============================================================
    // View functions
    // ============================================================

    #[external("utility")]
    unconstrained fn get_old_archive_root(proven_block_number: u32) -> Field {
        self.storage.old_archive_roots.at(proven_block_number).read()
    }

    #[external("utility")]
    unconstrained fn get_latest_proven_block() -> u32 {
        self.storage.latest_proven_block.read()
    }

    #[external("utility")]
    unconstrained fn get_snapshot_height() -> u32 {
        self.storage.snapshot_height.read()
    }
}
