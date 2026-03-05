use aztec::macros::aztec;

/// Minimal benchmark contract for measuring the cost of aztec-state-migration library functions.
///
/// Each function isolates a single migration path with zero business logic.
#[aztec]
pub contract MinimalBenchmark {
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        protocol::{abis::block_header::BlockHeader, address::AztecAddress, public_keys::PublicKeys},
        state_vars::{Map, Owned, PublicImmutable, PublicMutable},
    };
    use aztec_state_migration::{
        MigrationSignature,
        mode_a::{MigrationLock, MigrationModeA, MigrationNoteProofData},
        mode_b::{FullNoteProofData, KeyNoteProofData, MigrationModeB, PublicStateProofData},
        Point,
        Scalar,
    };
    use balance_set::BalanceSet;
    use uint_note::UintNote;

    #[storage]
    struct Storage<Context> {
        archive_registry_address: PublicImmutable<AztecAddress, Context>,
        old_rollup_app_address: PublicImmutable<AztecAddress, Context>,
        balances: Owned<BalanceSet<Context>, Context>,
        public_balances: Map<AztecAddress, PublicMutable<u128, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(archive_registry_address: AztecAddress, old_rollup_app_address: AztecAddress) {
        self.storage.archive_registry_address.initialize(archive_registry_address);
        self.storage.old_rollup_app_address.initialize(old_rollup_app_address);
    }

    // ============================================================
    // Mode A: lock (OLD rollup side)
    // ============================================================

    /// Mode A - lock 1 note for migration
    #[external("private")]
    fn bench_mode_a_lock_1_note(destination_rollup: Field, mpk: Point, amount: u128) {
        let owner = self.msg_sender();
        MigrationLock::new(self.context, mpk, owner, destination_rollup).lock_state(amount).finish();
    }

    /// Mode A - lock 2 notes for migration
    #[external("private")]
    fn bench_mode_a_lock_2_notes(
        destination_rollup: Field,
        mpk: Point,
        amount_0: u128,
        amount_1: u128,
    ) {
        let owner = self.msg_sender();
        MigrationLock::new(self.context, mpk, owner, destination_rollup)
            .lock_state(amount_0)
            .lock_state(amount_1)
            .finish();
    }

    /// Mode A - lock 3 notes for migration
    #[external("private")]
    fn bench_mode_a_lock_3_notes(
        destination_rollup: Field,
        mpk: Point,
        amount_0: u128,
        amount_1: u128,
        amount_2: u128,
    ) {
        let owner = self.msg_sender();
        MigrationLock::new(self.context, mpk, owner, destination_rollup)
            .lock_state(amount_0)
            .lock_state(amount_1)
            .lock_state(amount_2)
            .finish();
    }

    // ============================================================
    // Mode A: claim (NEW rollup side)
    // ============================================================

    /// Mode A - claim 1 private note (generic data = u128)
    #[external("private")]
    fn bench_mode_a_1_note(
        mpk: Point,
        signature: MigrationSignature,
        note_proof_data: MigrationNoteProofData<u128>,
        block_header: BlockHeader,
    ) {
        let recipient = self.msg_sender();
        let old_app = self.storage.old_rollup_app_address.read();
        MigrationModeA::new(
            self.context,
            old_app,
            self.storage.archive_registry_address.read(),
            block_header,
            mpk,
        )
            .with_note(note_proof_data)
            .finish(recipient, signature);
    }

    /// Mode A - migrate 2 private notes
    #[external("private")]
    fn bench_mode_a_2_notes(
        mpk: Point,
        signature: MigrationSignature,
        note_proof_data_0: MigrationNoteProofData<u128>,
        note_proof_data_1: MigrationNoteProofData<u128>,
        block_header: BlockHeader,
    ) {
        let recipient = self.msg_sender();
        let old_app = self.storage.old_rollup_app_address.read();
        MigrationModeA::new(
            self.context,
            old_app,
            self.storage.archive_registry_address.read(),
            block_header,
            mpk,
        )
            .with_note(note_proof_data_0)
            .with_note(note_proof_data_1)
            .finish(recipient, signature);
    }

    /// Mode A - migrate 3 private notes
    #[external("private")]
    fn bench_mode_a_3_notes(
        mpk: Point,
        signature: MigrationSignature,
        note_proof_data_0: MigrationNoteProofData<u128>,
        note_proof_data_1: MigrationNoteProofData<u128>,
        note_proof_data_2: MigrationNoteProofData<u128>,
        block_header: BlockHeader,
    ) {
        let recipient = self.msg_sender();
        let old_app = self.storage.old_rollup_app_address.read();
        MigrationModeA::new(
            self.context,
            old_app,
            self.storage.archive_registry_address.read(),
            block_header,
            mpk,
        )
            .with_note(note_proof_data_0)
            .with_note(note_proof_data_1)
            .with_note(note_proof_data_2)
            .finish(recipient, signature);
    }

    // ============================================================
    // Mode B: emergency snapshot - private notes
    // ============================================================

    /// Mode B - migrate 1 private note (UintNote)
    #[external("private")]
    fn bench_mode_b_1_note(
        signature: MigrationSignature,
        full_proof_data: FullNoteProofData<UintNote>,
        block_header: BlockHeader,
        notes_owner: AztecAddress,
        public_keys: PublicKeys,
        partial_address: Field,
        key_note: KeyNoteProofData,
        nhk: Scalar,
    ) {
        let recipient = self.msg_sender();
        let old_app = self.storage.old_rollup_app_address.read();
        let storage_slot = STORAGE_LAYOUT_MinimalBenchmark.fields.balances.slot;
        MigrationModeB::new(
            self.context,
            old_app,
            self.storage.archive_registry_address.read(),
            block_header,
        )
            .with_notes_owner(notes_owner, key_note, public_keys, partial_address, nhk)
            .with_note(full_proof_data, storage_slot)
            .finish(recipient, signature);
    }

    /// Mode B - migrate 2 private notes (UintNote)
    #[external("private")]
    fn bench_mode_b_2_notes(
        signature: MigrationSignature,
        full_proof_data_0: FullNoteProofData<UintNote>,
        full_proof_data_1: FullNoteProofData<UintNote>,
        block_header: BlockHeader,
        notes_owner: AztecAddress,
        public_keys: PublicKeys,
        partial_address: Field,
        key_note: KeyNoteProofData,
        nhk: Scalar,
    ) {
        let recipient = self.msg_sender();
        let old_app = self.storage.old_rollup_app_address.read();
        let storage_slot = STORAGE_LAYOUT_MinimalBenchmark.fields.balances.slot;
        MigrationModeB::new(
            self.context,
            old_app,
            self.storage.archive_registry_address.read(),
            block_header,
        )
            .with_notes_owner(notes_owner, key_note, public_keys, partial_address, nhk)
            .with_note(full_proof_data_0, storage_slot)
            .with_note(full_proof_data_1, storage_slot)
            .finish(recipient, signature);
    }

    // ============================================================
    // Mode B: emergency snapshot - public state
    // ============================================================

    /// Mode B - migrate 1 unowned public state slot (u128)
    #[external("private")]
    fn bench_mode_b_public_unowned(
        proof_data: PublicStateProofData<u128, 1>,
        block_header: BlockHeader,
    ) {
        let old_app = self.storage.old_rollup_app_address.read();
        let storage_slot = STORAGE_LAYOUT_MinimalBenchmark.fields.public_balances.slot;
        MigrationModeB::new(
            self.context,
            old_app,
            self.storage.archive_registry_address.read(),
            block_header,
        )
            .without_owner()
            .with_public_state(proof_data, storage_slot)
            .finish();
    }

    /// Mode B - migrate 1 owned public state slot (u128, with key note + signature)
    #[external("private")]
    fn bench_mode_b_public_owned(
        proof_data: PublicStateProofData<u128, 1>,
        block_header: BlockHeader,
        old_owner: AztecAddress,
        signature: MigrationSignature,
        key_note: KeyNoteProofData,
    ) {
        let recipient = self.msg_sender();
        let old_app = self.storage.old_rollup_app_address.read();
        let storage_slot = STORAGE_LAYOUT_MinimalBenchmark.fields.public_balances.slot;
        MigrationModeB::new(
            self.context,
            old_app,
            self.storage.archive_registry_address.read(),
            block_header,
        )
            .with_owner(old_owner, key_note)
            .with_public_map_state(proof_data, storage_slot, [old_owner])
            .finish(recipient, signature);
    }
}
