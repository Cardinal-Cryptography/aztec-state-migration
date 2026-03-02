mod types;

use aztec::macros::aztec;

/// V2 of the NFT migration contract.
///
/// Deployed on the NEW rollup. Supports migration claim functions
/// for both Mode A (routine lock-and-claim) and Mode B (emergency snapshot).
#[aztec]
pub contract NftMigrationAppV2 {
    use crate::types::nft_note::NFTNote;
    use aztec::{
        macros::{functions::{external, initializer, only_self}, storage::storage},
        messages::message_delivery::MessageDelivery,
        note::{constants::MAX_NOTES_PER_PAGE, note_viewer_options::NoteViewerOptions},
        protocol::{abis::block_header::BlockHeader, address::AztecAddress, public_keys::PublicKeys},
        state_vars::{Map, Owned, PrivateSet, PublicImmutable, PublicMutable},
    };
    use aztec_state_migration::{
        MigrationSignature,
        mode_a::{MigrationModeA, MigrationNoteProofData},
        mode_b::{FullNoteProofData, KeyNoteProofData, MigrationModeB, PublicStateProofData},
        Point,
        Scalar,
    };
    use nft_migration_app_v1::NftMigrationAppV1::STORAGE_LAYOUT_NftMigrationAppV1;

    #[storage]
    struct Storage<Context> {
        // --- Fields matching V1 storage layout (order must match for migration proofs) ---
        private_nfts: Owned<PrivateSet<NFTNote, Context>, Context>,
        nft_exists: Map<Field, PublicMutable<bool, Context>, Context>,
        public_owners: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        minter: PublicImmutable<AztecAddress, Context>,
        // --- V2-only fields (not present in V1) ---
        archive_registry_address: PublicImmutable<AztecAddress, Context>,
        old_rollup_app_address: PublicImmutable<AztecAddress, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(
        minter: AztecAddress,
        archive_registry_address: AztecAddress,
        old_rollup_app_address: AztecAddress,
    ) {
        self.storage.minter.initialize(minter);
        self.storage.archive_registry_address.initialize(archive_registry_address);
        self.storage.old_rollup_app_address.initialize(old_rollup_app_address);
    }

    // ============================================================
    // Internal minting (used by migration functions)
    // ============================================================

    #[external("private")]
    fn mint_to_private(to: AztecAddress, token_id: Field) {
        assert(self.msg_sender() == self.storage.minter.read(), "Only minter");
        let new_note = NFTNote { token_id };
        self.storage.private_nfts.at(to).insert(new_note).deliver(
            MessageDelivery.ONCHAIN_CONSTRAINED,
        );
        NftMigrationAppV2::at(self.context.this_address())._set_nft_exists(token_id).enqueue(
            self.context,
        );
    }

    // ============================================================
    // Views
    // ============================================================

    #[external("utility")]
    unconstrained fn public_owner_of(token_id: Field) -> AztecAddress {
        self.storage.public_owners.at(token_id).read()
    }

    #[external("utility")]
    unconstrained fn get_private_nfts(
        owner: AztecAddress,
        page_index: u32,
    ) -> ([Field; MAX_NOTES_PER_PAGE], bool) {
        let offset = page_index * MAX_NOTES_PER_PAGE;
        let options = NoteViewerOptions::new().set_offset(offset);
        let notes = self.storage.private_nfts.at(owner).view_notes(options);

        let mut owned_nft_ids = [0; MAX_NOTES_PER_PAGE];
        for i in 0..options.limit {
            if i < notes.len() {
                owned_nft_ids[i] = notes.get_unchecked(i).token_id;
            }
        }

        let page_limit_reached = notes.len() == options.limit;
        (owned_nft_ids, page_limit_reached)
    }

    // ============================================================
    // Mode A: Claim Migration (on NEW rollup)
    // ============================================================

    /// Claim a Mode A migration: verify proof and mint private NFT on new rollup.
    #[external("private")]
    fn migrate_nft_mode_a(
        token_id: Field,
        mpk: Point,
        signature: MigrationSignature,
        note_proof_data: MigrationNoteProofData<Field>,
        block_header: BlockHeader,
    ) {
        assert(note_proof_data.data == token_id, "Migration data mismatch");

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

        let new_note = NFTNote { token_id };
        self.storage.private_nfts.at(recipient).insert(new_note).deliver(
            MessageDelivery.ONCHAIN_CONSTRAINED,
        );
        NftMigrationAppV2::at(self.context.this_address())._set_nft_exists(token_id).enqueue(
            self.context,
        );
    }

    /// Claim a Mode A migration: verify proof and set public owner on new rollup.
    #[external("private")]
    fn migrate_nft_to_public_mode_a(
        token_id: Field,
        mpk: Point,
        signature: MigrationSignature,
        note_proof_data: MigrationNoteProofData<Field>,
        block_header: BlockHeader,
    ) {
        assert(note_proof_data.data == token_id, "Migration data mismatch");

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
        NftMigrationAppV2::at(self.context.this_address())
            ._set_public_owner(token_id, recipient)
            .enqueue(self.context);
    }

    // ============================================================
    // Mode B: Emergency Snapshot Migration (on NEW rollup)
    // ============================================================

    /// Claim a Mode B migration for a private NFT.
    /// Proves note inclusion + non-nullification at snapshot height.
    #[external("private")]
    fn migrate_nft_mode_b(
        token_id: Field,
        signature: MigrationSignature,
        full_proof_data: FullNoteProofData<NFTNote>,
        block_header: BlockHeader,
        notes_owner: AztecAddress,
        public_keys: PublicKeys,
        partial_address: Field,
        key_note: KeyNoteProofData,
        nhk: Scalar,
    ) {
        assert(full_proof_data.note_proof_data.data.token_id == token_id, "Token ID mismatch");

        let recipient = self.msg_sender();
        let old_app = self.storage.old_rollup_app_address.read();
        // Use V1's storage layout to get the correct slot on the old rollup
        let expected_storage_slot = STORAGE_LAYOUT_NftMigrationAppV1.fields.private_nfts.slot;

        MigrationModeB::new(
            self.context,
            old_app,
            self.storage.archive_registry_address.read(),
            block_header,
        )
            .with_notes_owner(notes_owner, key_note, public_keys, partial_address, nhk)
            .with_note(full_proof_data, expected_storage_slot)
            .finish(recipient, signature);

        let new_note = NFTNote { token_id };
        self.storage.private_nfts.at(recipient).insert(new_note).deliver(
            MessageDelivery.ONCHAIN_CONSTRAINED,
        );
        NftMigrationAppV2::at(self.context.this_address())._set_nft_exists(token_id).enqueue(
            self.context,
        );
    }

    /// Claim a Mode B migration for a public NFT owner mapping entry.
    /// Proves public_owners[token_id] at snapshot height, verifies ownership via
    /// migration key signature, and mints to the authenticated recipient.
    #[external("private")]
    fn migrate_public_owner_mode_b(
        proof_data: PublicStateProofData<AztecAddress, 1>,
        block_header: BlockHeader,
        token_id: Field,
        signature: MigrationSignature,
        key_note: KeyNoteProofData,
    ) {
        let old_owner = proof_data.data;
        assert(old_owner != AztecAddress::zero(), "Cannot migrate zero-address ownership");

        let archive_registry = self.storage.archive_registry_address.read();
        let recipient = self.msg_sender();
        let old_app = self.storage.old_rollup_app_address.read();
        // Use V1's storage layout to get the correct slot on the old rollup
        let base_storage_slot = STORAGE_LAYOUT_NftMigrationAppV1.fields.public_owners.slot;

        // 1. Verify public state existed at snapshot height
        MigrationModeB::new(self.context, old_app, archive_registry, block_header)
            .with_owner(old_owner, key_note)
            .with_public_map_state(proof_data, base_storage_slot, [token_id])
            .finish(recipient, signature);

        // 2. Mint to authenticated recipient
        NftMigrationAppV2::at(self.context.this_address())
            ._set_public_owner(token_id, recipient)
            .enqueue(self.context);
    }

    // ============================================================
    // Internal helpers
    // ============================================================

    #[external("public")]
    #[only_self]
    fn _set_public_owner(token_id: Field, owner: AztecAddress) {
        assert(!self.storage.nft_exists.at(token_id).read(), "NFT already exists");
        self.storage.public_owners.at(token_id).write(owner);
        self.storage.nft_exists.at(token_id).write(true);
    }

    #[external("public")]
    #[only_self]
    fn _set_nft_exists(token_id: Field) {
        assert(!self.storage.nft_exists.at(token_id).read(), "NFT already exists");
        self.storage.nft_exists.at(token_id).write(true);
    }
}
