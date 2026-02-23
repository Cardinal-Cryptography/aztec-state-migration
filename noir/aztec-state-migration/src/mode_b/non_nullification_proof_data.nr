use aztec::protocol::{
    address::AztecAddress,
    constants::{DOM_SEP__NOTE_NULLIFIER, NULLIFIER_TREE_HEIGHT},
    hash::{compute_siloed_nullifier, poseidon2_hash, poseidon2_hash_with_separator},
    merkle_tree::root::root_from_sibling_path,
    traits::{Packable, Serialize},
    utils::field::{full_field_greater_than, full_field_less_than},
};

/// A nullifier non-inclusion proof data.
#[derive(Serialize, Packable)]
pub struct NonNullificationProofData {
    pub low_nullifier_value: Field,
    pub low_nullifier_next_value: Field,
    pub low_nullifier_next_index: Field,
    pub low_nullifier_leaf_index: Field,
    pub low_nullifier_sibling_path: [Field; NULLIFIER_TREE_HEIGHT],
}

impl NonNullificationProofData {
    pub fn verify_nullifier_non_inclusion(
        self,
        nsk_app: Field,
        old_app: AztecAddress,
        note_hash_unique: Field,
        nullifier_tree_root: Field,
    ) -> Field {
        // Use the unique note hash for nullifier computation, matching the protocol's behavior
        // for settled notes (compute_nullifier receives the unique hash, not the inner hash).
        let inner_nullifier =
            poseidon2_hash_with_separator([note_hash_unique, nsk_app], DOM_SEP__NOTE_NULLIFIER);
        let siloed_nullifier = compute_siloed_nullifier(old_app, inner_nullifier);

        // Compute low leaf hash: poseidon2_hash([nullifier, next_nullifier, next_index])
        let low_leaf_hash = poseidon2_hash([
            self.low_nullifier_value,
            self.low_nullifier_next_value,
            self.low_nullifier_next_index,
        ]);
        // Verify low leaf is in the nullifier tree
        let computed_nullifier_root = root_from_sibling_path(
            low_leaf_hash,
            self.low_nullifier_leaf_index,
            self.low_nullifier_sibling_path,
        );
        assert(
            computed_nullifier_root == nullifier_tree_root,
            "Note low nullifier leaf not in nullifier tree",
        );
        // Sandwich check: low_value < target < next_value (or next is max)
        assert(
            full_field_less_than(self.low_nullifier_value, siloed_nullifier),
            "Note nullifier non-inclusion: low leaf not less than target",
        );
        assert(
            full_field_greater_than(self.low_nullifier_next_value, siloed_nullifier)
                | (self.low_nullifier_next_index == 0),
            "Note nullifier non-inclusion: next leaf not greater than target",
        );
        siloed_nullifier
    }
}
