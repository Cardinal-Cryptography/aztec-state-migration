use aztec::macros::aztec as aztec_contract;

mod l2_actor;

#[aztec_contract]
pub contract MyApp {
    use crate::l2_actor::L2Actor;
    use aztec::{
        hash::compute_secret_hash,
        keys::getters::get_public_keys,
        macros::{functions::{external, initializer}, storage::storage},
        messages::message_delivery::MessageDelivery,
        protocol_types::{address::{AztecAddress, EthAddress}, hash::poseidon2_hash, traits::Hash},
        state_vars::{owned::Owned, public_immutable::PublicImmutable},
    };
    use balance_set::balance_set::BalanceSet;

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
    fn migrate_to_new_rollup(amount: u128, nsk_new_app: Field) {
        // this is app specific logic to create the inner content hash and debit the user
        let account = self.context.msg_sender().unwrap();
        self.storage.private_points_balances.at(account).sub(amount).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
        let inner_content_hash = poseidon2_hash([amount as Field]);

        // this is generic migration logic
        let secret_hash = compute_secret_hash(nsk_new_app);
        let content = poseidon2_hash([secret_hash, inner_content_hash]);

        let new_rollup_app = self.storage.new_rollup_app.read();
        let wrapped_content = poseidon2_hash([
            new_rollup_app.address.inner,
            new_rollup_app.rollup_version,
            content,
        ]);
        self.context.message_portal(self.storage.aztec_migrator_address.read(), wrapped_content);
    }

    #[external("private")]
    fn migrate_from_old_rollup(amount: u128, leaf_index: Field) {
        // this is app specific logic to create the inner content hash
        let inner_content_hash = poseidon2_hash([amount as Field]);

        // this is generic migration logic
        let account = self.context.msg_sender().unwrap();
        let npk_m_hash = get_public_keys(account).npk_m.hash();
        let nsk_app = self.context.request_nsk_app(npk_m_hash);
        let secret_hash = compute_secret_hash(nsk_app);
        let content = poseidon2_hash([secret_hash, inner_content_hash]);

        let old_rollup_app = self.storage.old_rollup_app.read();
        let wrapped_content = poseidon2_hash([
            old_rollup_app.address.inner,
            old_rollup_app.rollup_version,
            content,
        ]);
        self.context.consume_l1_to_l2_message(
            wrapped_content,
            nsk_app,
            self.storage.aztec_migrator_address.read(),
            leaf_index,
        );

        // this is app specific logic to credit the user
        self.storage.private_points_balances.at(account).add(amount).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
    }
}
