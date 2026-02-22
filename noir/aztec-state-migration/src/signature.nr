use aztec::protocol_types::{
    address::AztecAddress,
    hash::poseidon2_hash,
    traits::{Deserialize, Serialize, ToField},
};
use std::embedded_curve_ops::EmbeddedCurvePoint as Point;

/// Migration signature for state migration.
/// The signature is over a message hash of following fields:
/// - `CLAIM_DOMAIN` (to prevent replay across different migration modes)
/// - `old_rollup` version (to prevent migration from unintended rollup versions)
/// - `current_rollup` version (to prevent migration to unintended rollup versions)
/// - `notes_hash` (commitment to the migrated notes and their proofs)
/// - `recipient` address on the new rollup (to prevent front-running)
/// - `new_app_address` (to prevent replay to different app contracts)
/// The signature is produced by the migration private key (derived from the MigrationKeyNote's mpk), which proves ownership of the migrated notes and their inclusion proofs.
#[derive(Deserialize, Serialize)]
pub struct MigrationSignature {
    bytes: [u8; 64],
}

impl MigrationSignature {
    pub fn verify_migration_signature<let CLAIM_DOMAIN: Field>(
        self,
        old_rollup: Field,
        current_rollup: Field,
        notes_hash: Field,
        recipient: AztecAddress,
        new_app_address: AztecAddress,
        mpk: Point,
    ) {
        let msg = poseidon2_hash([
            CLAIM_DOMAIN,
            old_rollup,
            current_rollup,
            notes_hash,
            recipient.to_field(),
            new_app_address.to_field(),
        ]);
        assert(
            schnorr::verify_signature(mpk, self.bytes, msg.to_be_bytes::<32>()),
            "Invalid migration signature",
        );
    }

    pub fn from_bytes(bytes: [u8; 64]) -> Self {
        Self { bytes }
    }
}
