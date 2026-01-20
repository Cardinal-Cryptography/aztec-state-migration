use aztec::protocol_types::{address::AztecAddress, traits::{Deserialize, Packable, Serialize}};
use std::meta::derive;

#[derive(Deserialize, Eq, Packable, Serialize)]
pub struct L2Actor {
    pub address: AztecAddress,
    pub rollup_version: Field,
}
