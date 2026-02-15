pub mod mode_a;
pub mod mode_b;

pub use std::embedded_curve_ops::EmbeddedCurvePoint as Point;
pub use std::embedded_curve_ops::EmbeddedCurveScalar as Scalar;

use aztec::protocol_types::{abis::block_header::BlockHeader, constants::ARCHIVE_HEIGHT, traits::Serialize};

#[derive(Serialize)]
pub struct ArchiveArgs {
    // Block header at snapshot height
    pub archive_block_header: BlockHeader,
    // Archive membership proof
    pub archive_leaf_index: Field,
    pub archive_sibling_path: [Field; ARCHIVE_HEIGHT],
}
