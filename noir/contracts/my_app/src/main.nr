use aztec::macros::aztec as aztec_contract;

mod l2_actor;

#[aztec_contract]
pub contract MyApp {
    use crate::l2_actor::L2Actor;
    use aztec::hash::compute_secret_hash;
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        protocol_types::{address::{AztecAddress, EthAddress}, hash::poseidon2_hash},
        state_vars::{owned::Owned, public_immutable::PublicImmutable},
    };
    use aztec::messages::message_delivery::MessageDelivery;
    use balance_set::balance_set::BalanceSet;
    use aztec::keys::getters::get_public_keys;

    #[storage]
    struct Storage<Context> {
        private_points_balances: Owned<BalanceSet<Context>, Context>,

        // Contract owner
        owner: PublicImmutable<AztecAddress, Context>,

        // Migration contract address (L1)
        aztec_migrator_address: PublicImmutable<EthAddress, Context>,
        // Old rollup app
        old_rollup_app: PublicImmutable<L2Actor, Context>,
        // New rollup app
        new_rollup_app: PublicImmutable<L2Actor, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(aztec_migrator_address: EthAddress, old_rollup_app: Option<L2Actor>) {
        self.storage.owner.initialize(self.context.msg_sender().unwrap());
        self.storage.aztec_migrator_address.initialize(aztec_migrator_address);
        if old_rollup_app.is_some() {
            self.storage.old_rollup_app.initialize(old_rollup_app.unwrap());
        }
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

    #[external("public")]
    fn set_new_rollup_app(new_rollup_app: L2Actor) {
        assert(self.msg_sender().unwrap() == self.storage.owner.read(), "Sender is not owner");
        self.storage.new_rollup_app.initialize(new_rollup_app);
    }

    #[external("private")]
    fn migrate_to_new_rollup(amount: u128, secret_salt: Field) {
        // this is app specific logic to create the inner content hash and debit the user
        let account_contract = self.context.msg_sender().unwrap();
        self.storage.private_points_balances.at(account_contract).sub(amount).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
        let inner_content_hash = poseidon2_hash([amount as Field]);

        // this is generic migration logic
        let npk_m = get_public_keys(account_contract).npk_m;
        let secret = poseidon2_hash([npk_m.inner.x, npk_m.inner.y, secret_salt]);
        let secret_hash = compute_secret_hash(secret);
        let content = poseidon2_hash([secret_hash, inner_content_hash]);
        let wrapped_content = poseidon2_hash([
            self.storage.new_rollup_app.read().address.inner,
            self.storage.new_rollup_app.read().rollup_version,
            content,
        ]);
        self.context.message_portal(self.storage.aztec_migrator_address.read(), wrapped_content);
    }

    #[external("private")]
    fn migrate_from_old_rollup(amount: u128, secret_salt: Field, leaf_index: Field) {
        // this is app specific logic to create the inner content hash
        let inner_content_hash = poseidon2_hash([amount as Field]);

        // this is generic migration logic
        let account_contract = self.msg_sender().unwrap();
        let npk_m = get_public_keys(account_contract).npk_m;
        let secret = poseidon2_hash([npk_m.inner.x, npk_m.inner.y, secret_salt]);
        let secret_hash = compute_secret_hash(secret);
        let content = poseidon2_hash([secret_hash, inner_content_hash]);
        let wrapped_content = poseidon2_hash([
            self.storage.old_rollup_app.read().address.inner,
            self.storage.old_rollup_app.read().rollup_version,
            content,
        ]);
        self.context.consume_l1_to_l2_message(
            wrapped_content,
            secret,
            self.storage.aztec_migrator_address.read(),
            leaf_index,
        );

        // this is app specific logic to credit the user
        self.storage.private_points_balances.at(account_contract).add(amount).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
    }
}
