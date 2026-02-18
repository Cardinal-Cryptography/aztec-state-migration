use aztec::protocol_types::{
    abis::block_header::BlockHeader,
    constants::ARCHIVE_HEIGHT,
    merkle_tree::root::root_from_sibling_path,
    traits::{Hash, Serialize},
};

/// Archive membership proof: a block header together with its Merkle sibling path
/// in the archive tree. Used to prove a given block belongs to the old rollup.
#[derive(Serialize)]
pub struct ArchiveProofData {
    // Block header at snapshot height
    pub archive_block_header: BlockHeader,
    // Archive membership proof
    pub archive_leaf_index: Field,
    pub archive_sibling_path: [Field; ARCHIVE_HEIGHT],
}

impl ArchiveProofData {
    /// Verify the archive proof against a given archive root, recomputing the root
    /// from the block header and sibling path, and comparing it to the expected root.
    pub fn compute_archive_root(self) -> Field {
        root_from_sibling_path(
            self.archive_block_header.hash(),
            self.archive_leaf_index,
            self.archive_sibling_path,
        )
    }
}
