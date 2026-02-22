import type { BlockHeader } from "@aztec/stdlib/tx";

/**
 * Convert TypeScript BlockHeader to Noir-compatible format with snake_case keys.
 * The Aztec.js encoder looks for exact field name matches from the ABI.
 */
export function blockHeaderToNoir(header: BlockHeader) {
  return {
    last_archive: {
      root: header.lastArchive.root,
      next_available_leaf_index: header.lastArchive.nextAvailableLeafIndex,
    },
    state: {
      l1_to_l2_message_tree: {
        root: header.state.l1ToL2MessageTree.root,
        next_available_leaf_index:
          header.state.l1ToL2MessageTree.nextAvailableLeafIndex,
      },
      partial: {
        note_hash_tree: {
          root: header.state.partial.noteHashTree.root,
          next_available_leaf_index:
            header.state.partial.noteHashTree.nextAvailableLeafIndex,
        },
        nullifier_tree: {
          root: header.state.partial.nullifierTree.root,
          next_available_leaf_index:
            header.state.partial.nullifierTree.nextAvailableLeafIndex,
        },
        public_data_tree: {
          root: header.state.partial.publicDataTree.root,
          next_available_leaf_index:
            header.state.partial.publicDataTree.nextAvailableLeafIndex,
        },
      },
    },
    sponge_blob_hash: header.spongeBlobHash,
    global_variables: {
      chain_id: header.globalVariables.chainId,
      version: header.globalVariables.version,
      block_number: header.globalVariables.blockNumber,
      slot_number: header.globalVariables.slotNumber,
      timestamp: header.globalVariables.timestamp,
      coinbase: header.globalVariables.coinbase,
      fee_recipient: header.globalVariables.feeRecipient,
      gas_fees: {
        fee_per_da_gas: header.globalVariables.gasFees.feePerDaGas,
        fee_per_l2_gas: header.globalVariables.gasFees.feePerL2Gas,
      },
    },
    total_fees: header.totalFees,
    total_mana_used: header.totalManaUsed,
  };
}
