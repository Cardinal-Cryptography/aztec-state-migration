use crate::{constants::DOM_SEP__CLAIM_B, signature::MigrationSignature};
use super::{
    FullNoteProofData, key_note_proof_data::KeyNoteProofData,
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

pub struct MigrationFinished;

impl MigrationModeB {
    pub fn new<Env>(
        context: &mut PrivateContext,
        old_app: AztecAddress,
        migration_archive_registry: AztecAddress,
        block_header: BlockHeader,
        builder: fn[Env](MigrationModeB) -> MigrationFinished,
    ) {
        let _ = builder(
            Self {
                context,
                old_app,
                migration_archive_registry,
                block_header,
                current_rollup: context.version(),
            },
        );
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

    fn _finish(self) -> MigrationFinished {
        let block_hash = self.block_header.hash();
        MigrationArchiveRegistry::at(self.migration_archive_registry)
            .verify_migration_mode_b(block_hash)
            .call(self.context);
        MigrationFinished {}
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

    pub fn finish(self) -> MigrationFinished {
        self.inner._finish()
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

    pub fn finish(
        self,
        recipient: AztecAddress,
        signature: MigrationSignature,
    ) -> MigrationFinished {
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

        self.inner._finish()
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

    pub fn finish(
        self,
        recipient: AztecAddress,
        signature: MigrationSignature,
    ) -> MigrationFinished {
        self.inner.finish(recipient, signature)
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
