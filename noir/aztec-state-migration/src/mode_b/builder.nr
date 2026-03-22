use crate::{
    constants::{DOM_SEP__CLAIM_B, DOM_SEP__L1_TO_L2_MIGRATION_NULLIFIER},
    signature::MigrationSignature,
};
use super::{
    FullL1ToL2MessageProofData, FullNoteProofData, key_note_proof_data::KeyNoteProofData,
    public_state_proof_data::PublicStateProofData,
};
use aztec::{
    context::PrivateContext,
    note::note_interface::NoteHash,
    protocol::{
        abis::block_header::BlockHeader,
        address::{AztecAddress, partial_address::PartialAddress},
        constants::{DOM_SEP__NHK_M, DOM_SEP__NOTE_NULLIFIER, DOM_SEP__PUBLIC_STORAGE_MAP_SLOT},
        hash::poseidon2_hash_with_separator,
        public_keys::{NpkM, PublicKeys},
        traits::{Hash, Packable, ToField},
    },
};
use migration_archive_registry::MigrationArchiveRegistry;
use poseidon::poseidon2::Poseidon2Hasher;
use std::{
    embedded_curve_ops::{
        EmbeddedCurvePoint as Point, EmbeddedCurveScalar as Scalar, fixed_base_scalar_mul,
    },
    hash::Hasher,
};

/// Mode B (emergency snapshot) migration builder.
///
/// ## Usage:
///
/// ### Unowned public state:
///```
///   MigrationModeB::new(context, old_app, archive_registry, block_header)
///       .without_owner()
///       .with_public_state(proof, slot)                       // repeat for each unowned public state
///       .with_public_map_state(map_proof, map_slot, [key])    // keys for a single entry; use [k1, k2] for nested maps
///       .finish_at_snapshot();                                // or .finish_at_block(block_number);
///```
///
/// ### Owned public state:
///```
///   MigrationModeB::new(...)
///       .with_owner(owner, key_note)
///       .with_public_state(proof, slot)                       // repeat for each owned public state
///       .with_public_map_state(map_proof, map_slot, [key])    // keys for a single entry; use [k1, k2] for nested maps
///       .finish_at_snapshot(recipient, signature);            // or .finish_at_block(recipient, signature, block_number);
///```
///
/// ### Private notes:
///```
///   MigrationModeB::new(...)
///       .with_notes_owner(owner, key_note, public_keys, partial_address, nhk)
///       .with_note(proof, slot)                               // repeat for each note
///       .finish_at_snapshot(recipient, signature);            // or .finish_at_block(recipient, signature, block_number);
///```
///
/// ### Unconsumed L1-to-L2 messages:
///```
///   MigrationModeB::new(context, old_app, archive_registry, block_header)
///       .without_owner()
///       .with_l1_to_l2_message(full_message_proof, secret)
///       .finish_at_snapshot();
///```
///
/// ### Or mix and match as needed (e.g. owned public state and private notes).
///```
///   MigrationModeB::new(...)
///       .with_owner(owner, key_note)
///       .with_public_state(public_state_proof, public_state_slot)
///       .with_notes_owner(public_keys, partial_address, nhk)
///       .with_note(note_proof, note_slot)
///       .finish_at_snapshot(recipient, signature);
///```
///
/// # Important:
///
/// Ensure that at the end of the builder chain, you call **`finish_at_snapshot(...)`**
/// or **`finish_at_block(...)`** to trigger block hash verification and signature verification (if applicable).
///
/// ## **`finish_at_snapshot(...)`** vs **`finish_at_block(...)`**:
/// - `finish_at_snapshot(...)`: verifies that the migration is happening at a fixed snapshot set in
///   the migration archive registry (the same for all applications on the new rollup).
/// - `finish_at_block(...)`: verifies that the migration is happening at a specific block number.
///   Use it if you want to coordinate the migration of your application at a specific block.
///
/// ## Custom Notes:
/// For custom notes, the **`compute_nullifier`** method **must** follow the canonical formula:
/// ```
/// fn compute_nullifier(
///     self,
///     context: &mut PrivateContext,
///     owner: AztecAddress,
///     note_hash_for_nullification: Field,
/// ) -> Field {
///     let owner_npk_m = get_public_keys(owner).npk_m;
///     let owner_npk_m_hash = owner_npk_m.hash();
///     let secret = context.request_nhk_app(owner_npk_m_hash);
///     poseidon2_hash_with_separator(
///         [note_hash_for_nullification, secret],
///         DOM_SEP__NOTE_NULLIFIER,
///     )
/// }
/// ```
///
/// If the nullifier does not match this formula, there is a risk of
/// malicious actors migrating already nullified notes.
///
/// For certainty, you can use the provided helper function `assert_note_has_canonical_nullifier`
/// in your tests to verify that your custom note's nullifier is correctly computed.
/// ```
/// use aztec_state_migration::mode_b::assert_note_has_canonical_nullifier;
///
/// #[test]
/// unconstrained fn assert_canonical_nullifier() {
///     let note = NFTNote { token_id: 0x12345 };
///     assert_note_has_canonical_nullifier(note);
/// }
/// ```
pub struct MigrationModeB {
    context: &mut PrivateContext,
    old_app: AztecAddress,
    migration_archive_registry: AztecAddress,
    block_header: BlockHeader,
    current_rollup: Field,
}

pub struct MigrationWithoutOwnerModeB {
    inner: MigrationModeB,
}

pub struct MigrationWithOwnedStateModeB {
    inner: MigrationModeB,
    hasher: Poseidon2Hasher,
    owner: AztecAddress,
    mpk: Point,
}

pub struct MigrationWithOwnedNotesModeB {
    inner: MigrationWithOwnedStateModeB,
    nhk_app: Field,
}

impl MigrationModeB {
    pub fn new(
        context: &mut PrivateContext,
        old_app: AztecAddress,
        migration_archive_registry: AztecAddress,
        block_header: BlockHeader,
    ) -> Self {
        Self {
            context,
            old_app,
            migration_archive_registry,
            block_header,
            current_rollup: context.version(),
        }
    }

    fn _with_public_state<T: Packable>(
        mut self,
        proof_data: PublicStateProofData<T, <T as Packable>::N>,
        base_storage_slot: Field,
    ) -> Self {
        proof_data.migrate_public_state(
            self.context,
            base_storage_slot,
            self.old_app,
            self.block_header.state.partial.public_data_tree.root,
        );
        self
    }

    fn _with_public_map_state<T: Packable, K: ToField, let N: u32>(
        mut self,
        proof_data: PublicStateProofData<T, <T as Packable>::N>,
        base_storage_slot: Field,
        map_keys: [K; N],
    ) -> Self {
        let derived_storage_slot = derive_map_storage_slot(base_storage_slot, map_keys);
        proof_data.migrate_public_state(
            self.context,
            derived_storage_slot,
            self.old_app,
            self.block_header.state.partial.public_data_tree.root,
        );
        self
    }

    fn _finish_at_snapshot(self) {
        let block_hash = self.block_header.hash();
        MigrationArchiveRegistry::at(self.migration_archive_registry)
            .verify_migration_at_snapshot(block_hash)
            .call(self.context);
    }

    fn _finish_at_block(self, block_number: u32) {
        let block_hash = self.block_header.hash();
        MigrationArchiveRegistry::at(self.migration_archive_registry)
            .verify_migration_at_block(block_number, block_hash)
            .call(self.context);
    }

    fn _migrate_l1_to_l2_message(
        self,
        full_proof: FullL1ToL2MessageProofData,
        secret: Field,
    ) -> Field {
        let message_proof = full_proof.message_proof_data;
        let non_null_proof = full_proof.non_nullification_proof_data;

        // 1. Verify message inclusion in L1-to-L2 message tree
        let message_hash = message_proof.verify_message_inclusion(
            self.block_header.state.l1_to_l2_message_tree.root,
            self.block_header.global_variables.chain_id,
            self.old_app,
            self.block_header.global_variables.version,
        );

        // 2. Verify message was not consumed (nullifier non-inclusion)
        let _ = non_null_proof.verify_message_nullifier_non_inclusion(
            message_hash,
            secret,
            self.old_app,
            self.block_header.state.partial.nullifier_tree.root,
        );

        // 3. Push migration nullifier to prevent double-migration
        let migration_nullifier = poseidon2_hash_with_separator(
            [message_hash, self.old_app.to_field()],
            DOM_SEP__L1_TO_L2_MIGRATION_NULLIFIER,
        );
        self.context.push_nullifier(migration_nullifier);

        message_hash
    }

    pub fn without_owner(self) -> MigrationWithoutOwnerModeB {
        MigrationWithoutOwnerModeB { inner: self }
    }

    pub fn with_owner(
        self,
        owner: AztecAddress,
        key_note: KeyNoteProofData,
    ) -> MigrationWithOwnedStateModeB {
        let _ = key_note.verify_key_note_inclusion(
            self.context,
            self.migration_archive_registry,
            owner,
            self.block_header.state.partial.note_hash_tree.root,
        );
        MigrationWithOwnedStateModeB {
            inner: self,
            owner,
            mpk: key_note.data.mpk,
            hasher: Poseidon2Hasher::default(),
        }
    }

    pub fn with_notes_owner(
        self,
        owner: AztecAddress,
        key_note: KeyNoteProofData,
        public_keys: PublicKeys,
        partial_address: Field,
        nhk: Scalar,
    ) -> MigrationWithOwnedNotesModeB {
        self.with_owner(owner, key_note).with_notes_owner(public_keys, partial_address, nhk)
    }
}

impl MigrationWithoutOwnerModeB {
    pub fn with_public_state<T: Packable>(
        mut self,
        proof_data: PublicStateProofData<T, <T as Packable>::N>,
        base_storage_slot: Field,
    ) -> Self {
        let _ = self.inner._with_public_state(proof_data, base_storage_slot);
        self
    }

    pub fn with_public_map_state<T: Packable, K: ToField, let N: u32>(
        mut self,
        proof_data: PublicStateProofData<T, <T as Packable>::N>,
        base_storage_slot: Field,
        map_keys: [K; N],
    ) -> Self {
        let _ = self.inner._with_public_map_state(proof_data, base_storage_slot, map_keys);
        self
    }

    pub fn with_l1_to_l2_message(
        mut self,
        proof_data: FullL1ToL2MessageProofData,
        secret: Field,
    ) -> Self {
        let _ = self.inner._migrate_l1_to_l2_message(proof_data, secret);
        self
    }

    pub fn finish_at_snapshot(self) {
        self.inner._finish_at_snapshot()
    }

    pub fn finish_at_block(self, block_number: u32) {
        self.inner._finish_at_block(block_number)
    }

    pub fn with_owner(
        self,
        owner: AztecAddress,
        key_note: KeyNoteProofData,
    ) -> MigrationWithOwnedStateModeB {
        self.inner.with_owner(owner, key_note)
    }

    pub fn with_notes_owner(
        self,
        owner: AztecAddress,
        key_note: KeyNoteProofData,
        public_keys: PublicKeys,
        partial_address: Field,
        nhk: Scalar,
    ) -> MigrationWithOwnedNotesModeB {
        self.inner.with_owner(owner, key_note).with_notes_owner(public_keys, partial_address, nhk)
    }
}

impl MigrationWithOwnedStateModeB {
    pub fn with_public_state<T: Packable>(
        mut self,
        proof_data: PublicStateProofData<T, <T as Packable>::N>,
        base_storage_slot: Field,
    ) -> Self {
        self.inner = self.inner._with_public_state(proof_data, base_storage_slot);
        for d in proof_data.data.pack() {
            self.hasher.write(d);
        }
        self
    }

    pub fn with_public_map_state<T: Packable, K: ToField, let N: u32>(
        mut self,
        proof_data: PublicStateProofData<T, <T as Packable>::N>,
        base_storage_slot: Field,
        map_keys: [K; N],
    ) -> Self {
        let _ = self.inner._with_public_map_state(proof_data, base_storage_slot, map_keys);
        for d in proof_data.data.pack() {
            self.hasher.write(d);
        }
        self
    }

    pub fn with_l1_to_l2_message(
        mut self,
        proof_data: FullL1ToL2MessageProofData,
        secret: Field,
    ) -> Self {
        let message_hash = self.inner._migrate_l1_to_l2_message(proof_data, secret);
        self.hasher.write(message_hash);
        self
    }

    pub fn finish_at_snapshot(self, recipient: AztecAddress, signature: MigrationSignature) {
        self._verify_signature(recipient, signature);

        self.inner._finish_at_snapshot()
    }

    pub fn finish_at_block(
        self,
        recipient: AztecAddress,
        signature: MigrationSignature,
        block_number: u32,
    ) {
        self._verify_signature(recipient, signature);

        self.inner._finish_at_block(block_number)
    }

    fn _verify_signature(self, recipient: AztecAddress, signature: MigrationSignature) {
        let old_rollup = self.inner.block_header.global_variables.version;
        let new_app = self.inner.context.this_address();

        let final_hash = self.hasher.finish();

        signature.verify_migration_signature::<DOM_SEP__CLAIM_B>(
            old_rollup,
            self.inner.current_rollup,
            final_hash,
            recipient,
            new_app,
            self.mpk,
        );
    }

    pub fn with_notes_owner(
        self,
        public_keys: PublicKeys,
        partial_address: Field,
        nhk: Scalar,
    ) -> MigrationWithOwnedNotesModeB {
        // Derive npk_m from nhk
        let derived_npk_m = NpkM { inner: fixed_base_scalar_mul(nhk) };
        let public_keys = PublicKeys {
            npk_m: derived_npk_m,
            ivpk_m: public_keys.ivpk_m,
            ovpk_m: public_keys.ovpk_m,
            tpk_m: public_keys.tpk_m,
        };

        // Derive the note owner address from the provided public keys and partial address
        let computed_address =
            AztecAddress::compute(public_keys, PartialAddress::from_field(partial_address));
        assert(
            computed_address == self.owner,
            "Address does not match public keys derived from nhk",
        );

        // Derive nhk_app for the old app contract:
        let nhk_app = poseidon2_hash_with_separator(
            [nhk.hi, nhk.lo, self.inner.old_app.to_field()],
            DOM_SEP__NHK_M,
        );

        MigrationWithOwnedNotesModeB { inner: self, nhk_app }
    }
}

impl MigrationWithOwnedNotesModeB {
    pub fn with_note<Note: NoteHash>(
        mut self,
        proof_data: FullNoteProofData<Note>,
        expected_storage_slot: Field,
    ) -> Self {
        let note_hash = self.migrate_note(proof_data, expected_storage_slot);
        self.inner.hasher.write(note_hash);
        self
    }

    pub fn with_l1_to_l2_message(
        mut self,
        proof_data: FullL1ToL2MessageProofData,
        secret: Field,
    ) -> Self {
        let message_hash = self.inner.inner._migrate_l1_to_l2_message(proof_data, secret);
        self.inner.hasher.write(message_hash);
        self
    }

    pub fn finish_at_snapshot(self, recipient: AztecAddress, signature: MigrationSignature) {
        self.inner.finish_at_snapshot(recipient, signature)
    }

    pub fn finish_at_block(
        self,
        recipient: AztecAddress,
        signature: MigrationSignature,
        block_number: u32,
    ) {
        self.inner.finish_at_block(recipient, signature, block_number)
    }

    /// Verify a single note's inclusion in the note hash tree and non-nullification
    /// in the nullifier tree, then push a migration nullifier to prevent double-claiming.
    /// Returns the inner note hash (used to build the aggregate `notes_hash` for signature verification).
    fn migrate_note<Note: NoteHash>(
        self,
        full_note_proof_data: FullNoteProofData<Note>,
        expected_storage_slot: Field,
    ) -> Field {
        let note_proof_data = full_note_proof_data.note_proof_data;
        let non_nullification_proof_data = full_note_proof_data.non_nullification_proof_data;
        // ============================================================
        // 1. Compute Note hash and verify inclusion in note hash tree
        // ============================================================

        let note_hash = note_proof_data.note_hash(self.inner.owner, expected_storage_slot);
        let note_unique = note_proof_data.verify_note_inclusion(
            self.inner.inner.old_app,
            note_hash,
            self.inner.inner.block_header.state.partial.note_hash_tree.root,
        );

        // ============================================================
        // 2. Compute and verify Note non-nullification
        // ============================================================

        let _ = non_nullification_proof_data.verify_nullifier_non_inclusion(
            self.nhk_app,
            self.inner.inner.old_app,
            note_unique,
            self.inner.inner.block_header.state.partial.nullifier_tree.root,
        );

        // ============================================================
        // 3. Push migration nullifier (prevents double-claiming)
        // ============================================================
        let migration_nullifier = poseidon2_hash_with_separator(
            [note_unique, note_proof_data.randomness],
            DOM_SEP__NOTE_NULLIFIER,
        );
        self.inner.inner.context.push_nullifier(migration_nullifier);

        note_hash
    }
}

fn derive_map_storage_slot<K: ToField, let N: u32>(slot: Field, map_keys: [K; N]) -> Field {
    std::static_assert(N > 0, "map_keys must have at least one key");
    let mut derived_slot = slot;
    for i in 0..N {
        derived_slot = poseidon2_hash_with_separator(
            [derived_slot, map_keys[i].to_field()],
            DOM_SEP__PUBLIC_STORAGE_MAP_SLOT,
        );
    }
    derived_slot
}
