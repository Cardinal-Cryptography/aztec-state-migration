use crate::constants::GENERATOR_INDEX__PUBLIC_MIGRATION_NULLIFIER;
use aztec::{
    context::private_context::PrivateContext,
    protocol_types::{
        address::AztecAddress,
        constants::{GENERATOR_INDEX__PUBLIC_LEAF_INDEX, PUBLIC_DATA_TREE_HEIGHT},
        hash::{poseidon2_hash, poseidon2_hash_with_separator},
        merkle_tree::root::root_from_sibling_path,
        traits::{Deserialize, Packable, Serialize, ToField},
    },
};

#[derive(Packable, Serialize, Deserialize)]
pub(crate) struct PublicStateSlotProofData {
    pub next_slot: Field,
    pub next_index: Field,
    pub leaf_index: Field,
    pub sibling_path: [Field; PUBLIC_DATA_TREE_HEIGHT],
}

impl PublicStateSlotProofData {
    /// Verify public data inclusion in the public data tree
    pub(crate) fn verify_slot(
        self,
        old_app: AztecAddress,
        slot: Field,
        slot_value: Field,
        public_state_tree_root: Field,
    ) {
        // Compute the siloed storage slot (public data tree index) using the protocol's domain separator
        let public_data_tree_index = poseidon2_hash_with_separator(
            [old_app.to_field(), slot],
            GENERATOR_INDEX__PUBLIC_LEAF_INDEX,
        );

        // Compute leaf hash from the preimage (must match PublicDataTreeLeafPreimage::hash())
        let leaf_hash = poseidon2_hash([
            public_data_tree_index,
            slot_value,
            self.next_index,
            self.next_slot,
        ]);

        // Verify the leaf is in the public data tree
        let computed_public_data_root =
            root_from_sibling_path(leaf_hash, self.leaf_index, self.sibling_path);
        assert(
            computed_public_data_root == public_state_tree_root,
            "Public data not in public data tree",
        );
    }
}

#[derive(Packable, Serialize, Deserialize)]
pub struct PublicStateProofData<T, let N: u32> {
    pub data: T,
    pub(crate) slot_proof_data: [PublicStateSlotProofData; N],
}

impl<T: Packable, let N: u32> PublicStateProofData<T, N> {
    pub fn public_state_hash(self) -> Field {
        poseidon2_hash(self.data.pack())
    }

    /// Verify public data existed in the public data tree
    pub fn migrate_public_state(
        self,
        context: &mut PrivateContext,
        base_storage_slot: Field,
        old_app: AztecAddress,
        public_state_tree_root: Field,
    ) {
        let data_fields = self.data.pack();
        assert(
            <T as Packable>::N == N,
            "Proof data length must match the number of fields in the struct",
        );

        // Each data field occupies a consecutive storage slot (S, S+1, ..., S+N-1).
        // We verify each field's inclusion in the public data tree separately.
        for i in 0..N {
            let slot_i = base_storage_slot + i as Field;
            self.slot_proof_data[i].verify_slot(
                old_app,
                slot_i,
                data_fields[i],
                public_state_tree_root,
            );
        }

        // After verifying the public state, we push a nullifier
        // to prevent double-migration of the same storage slots.
        let nullifier = poseidon2_hash_with_separator(
            [base_storage_slot],
            GENERATOR_INDEX__PUBLIC_MIGRATION_NULLIFIER,
        );
        context.push_nullifier(nullifier);
    }
}
