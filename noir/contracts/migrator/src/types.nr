use aztec::protocol_types::{address::AztecAddress, traits::{Deserialize, Packable, Serialize}};

#[derive(Deserialize, Eq, Serialize, Packable)]
pub struct L2Actor {
    pub version: Field,
    pub address: AztecAddress,
}
