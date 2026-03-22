use aztec::{
    hash::{compute_l1_to_l2_message_hash, compute_secret_hash},
    protocol::{
        address::{AztecAddress, EthAddress},
        constants::L1_TO_L2_MSG_TREE_HEIGHT,
        merkle_tree::root::root_from_sibling_path,
        traits::Serialize,
    },
};

/// Proof that an L1-to-L2 message exists in the L1-to-L2 message tree.
///
/// Contains the message fields needed to recompute the message hash (leaf),
/// plus a Merkle sibling path for inclusion verification.
#[derive(Serialize)]
pub struct L1ToL2MessageProofData {
    /// L1 sender (portal contract address)
    pub sender: EthAddress,
    /// Message content (application-specific payload)
    pub content: Field,
    /// The spending secret
    pub secret: Field,
    /// Index of the message leaf in the L1-to-L2 message tree
    pub leaf_index: Field,
    /// Merkle sibling path from the leaf to the root
    sibling_path: [Field; L1_TO_L2_MSG_TREE_HEIGHT],
}

impl L1ToL2MessageProofData {
    /// Compute the message hash (leaf value) using the protocol's formula.
    pub fn compute_message_hash(
        self,
        chain_id: Field,
        recipient: AztecAddress,
        version: Field,
    ) -> Field {
        let secret_hash = compute_secret_hash(self.secret);
        compute_l1_to_l2_message_hash(
            self.sender,
            chain_id,
            recipient,
            version,
            self.content,
            secret_hash,
            self.leaf_index,
        )
    }

    /// Verify that this message is included in the L1-to-L2 message tree.
    ///
    /// Returns the message hash on success.
    pub(crate) fn verify_message_inclusion(
        self,
        l1_to_l2_message_tree_root: Field,
        chain_id: Field,
        recipient: AztecAddress,
        version: Field,
    ) -> Field {
        let message_hash = self.compute_message_hash(chain_id, recipient, version);

        let computed_root =
            root_from_sibling_path(message_hash, self.leaf_index, self.sibling_path);
        assert(computed_root == l1_to_l2_message_tree_root, "L1-to-L2 message not in message tree");

        message_hash
    }
}
