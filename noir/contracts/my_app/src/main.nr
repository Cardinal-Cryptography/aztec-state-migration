use aztec::macros::aztec as aztec_contract;

#[aztec_contract]
pub contract MyApp {
    use aztec::hash::compute_secret_hash;
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        protocol_types::{address::{AztecAddress, EthAddress}, hash::poseidon2_hash},
        state_vars::{owned::Owned, public_immutable::PublicImmutable},
    };
    use aztec::messages::message_delivery::MessageDelivery;
    use balance_set::balance_set::BalanceSet;

    #[storage]
    struct Storage<Context> {
        private_points_balances: Owned<BalanceSet<Context>, Context>,

        // Optional address of the aztec previous version migrator contract address for migration purposes
        old_aztec_migrator_address: PublicImmutable<EthAddress, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(old_aztec_migrator_address: Option<EthAddress>) {
        if old_aztec_migrator_address.is_some() {
            self.storage.old_aztec_migrator_address.initialize(old_aztec_migrator_address.unwrap());
        }
        // if this is the "origin" version, we keep it uninitialized
    }

    #[external("private")]
    fn claim(account: AztecAddress) {
        self.storage.private_points_balances.at(account).add(10).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
    }

    #[external("utility")]
    unconstrained fn get_balance(account: AztecAddress) -> u128 {
        self.storage.private_points_balances.at(account).balance_of()
    }

    #[external("private")]
    fn migrate_to_new_aztec_version(
        new_aztec_migrator_address: EthAddress,
        new_owner: AztecAddress,
        amount: u128,
        secret: Field,
    ) {
        let account = self.context.msg_sender().unwrap();
        self.storage.private_points_balances.at(account).sub(amount).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
        let secret_hash = compute_secret_hash(secret);
        let inner_content_hash = poseidon2_hash([new_owner.inner, amount as Field]);
        let content = poseidon2_hash([inner_content_hash, secret_hash]);
        self.context.message_portal(new_aztec_migrator_address, content);
    }

    #[external("private")]
    fn migrate_from_old_aztec_version(amount: u128, secret: Field, leaf_index: Field) {
        let owner = self.msg_sender().unwrap();
        let secret_hash = compute_secret_hash(secret);
        let inner_content_hash = poseidon2_hash([owner.inner, amount as Field]);
        let content = poseidon2_hash([inner_content_hash, secret_hash]);
        let old_aztec_migrator_address = self.storage.old_aztec_migrator_address.read();
        self.context.consume_l1_to_l2_message(
            content,
            secret,
            old_aztec_migrator_address,
            leaf_index,
        );
        self.storage.private_points_balances.at(owner).add(amount).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
    }
}

mod tests {
    use aztec::protocol_types::{traits::Serialize, address::EthAddress, hash::poseidon2_hash};
    #[test]
    unconstrained fn test_hash() {
        let a = 2137;
        let b = 42;

        let hash = poseidon2_hash([a, b]);

        println(f"POSEIDON2_HASH: {hash}");
    }

    #[test]
    unconstrained fn test_option_none() {
        let none: Option<EthAddress> = Option::none();
        let none_field = Serialize::serialize(none);
        println(f"NONE FIELD: {none_field}");
    }

}
