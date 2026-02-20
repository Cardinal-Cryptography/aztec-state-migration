mod types;

use aztec::macros::aztec;

/// Migration-enabled NFT contract matching the defi-wonderland/aztec-standards NFT data model.
///
/// Supports both Mode A (routine lock-and-claim) and Mode B (emergency snapshot) migration.
///
/// Mode A: Users call `lock_nft_mode_a()` on old rollup, then `migrate_nft_mode_a()` on new rollup.
/// Mode B: Users prove NFTNote existence + non-nullification at snapshot height H.
#[aztec]
pub contract NftMigrationApp {
    use crate::types::nft_note::NFTNote;
    use aztec::{
        macros::{functions::{external, initializer, only_self}, storage::storage},
        messages::message_delivery::MessageDelivery,
        note::{
            constants::MAX_NOTES_PER_PAGE, note_getter_options::NoteGetterOptions,
            note_interface::NoteProperties, note_viewer_options::NoteViewerOptions,
        },
        protocol_types::{
            abis::block_header::BlockHeader, address::AztecAddress, public_keys::PublicKeys,
        },
        state_vars::{Map, Owned, PrivateSet, PublicImmutable, PublicMutable},
        utils::comparison::Comparator,
    };
    use migration::{
        constants::CLAIM_DOMAIN_B_PUBLIC,
        MigrationSignature,
        mode_a::{lock_migration_notes, migrate_notes_mode_a, MigrationNoteProofData},
        mode_b::{
            FullNoteProofData, KeyNoteProofData, migrate_notes_mode_b,
            migrate_public_map_state_mode_b, PublicStateProofData,
        },
        Point,
        Scalar,
    };

    #[storage]
    struct Storage<Context> {
        archive_root_address: PublicImmutable<AztecAddress, Context>,
        old_rollup_app_address: PublicImmutable<AztecAddress, Context>,
        private_nfts: Owned<PrivateSet<NFTNote, Context>, Context>,
        nft_exists: Map<Field, PublicMutable<bool, Context>, Context>,
        public_owners: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        minter: PublicImmutable<AztecAddress, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(
        minter: Option<AztecAddress>,
        archive_root_address: Option<AztecAddress>,
        old_rollup_app_address: Option<AztecAddress>,
    ) {
        assert(
            archive_root_address.is_some() == old_rollup_app_address.is_some(),
            "Must provide both old rollup app address and archive root address, or neither",
        );
        if archive_root_address.is_some() {
            self.storage.archive_root_address.initialize(archive_root_address.unwrap());
            self.storage.old_rollup_app_address.initialize(old_rollup_app_address.unwrap());
        }
        if minter.is_some() {
            self.storage.minter.initialize(minter.unwrap());
        }
    }

    // ============================================================
    // Test helpers
    // ============================================================

    #[external("private")]
    fn mint_to_private(to: AztecAddress, token_id: Field) {
        assert(self.context.msg_sender().unwrap() == self.storage.minter.read(), "Only minter");
        let new_note = NFTNote { token_id };
        self.storage.private_nfts.at(to).insert(new_note).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
        NftMigrationApp::at(self.context.this_address())._set_nft_exists(token_id).enqueue(
            self.context,
        );
    }

    #[external("private")]
    fn mint_to_public(to: AztecAddress, token_id: Field) {
        assert(self.context.msg_sender().unwrap() == self.storage.minter.read(), "Only minter");
        assert(to != AztecAddress::zero(), "Cannot mint to zero address");
        NftMigrationApp::at(self.context.this_address())._set_public_owner(token_id, to).enqueue(
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
    // Mode A: Lock for Migration (on OLD rollup)
    // ============================================================

    /// Lock a private NFT for migration to a new rollup.
    /// Nullifies the NFTNote and creates a MigrationNote with the token_id.
    #[external("private")]
    fn lock_nft_mode_a(token_id: Field, destination_rollup: Field, mpk: Point) {
        let note_owner = self.context.msg_sender().unwrap();

        let notes = self.storage.private_nfts.at(note_owner).pop_notes(NoteGetterOptions::new()
            .select(NFTNote::properties().token_id, Comparator.EQ, token_id)
            .set_limit(1));
        assert(notes.len() == 1, "NFT not found");

        lock_migration_notes(
            self.context,
            note_owner,
            destination_rollup,
            mpk,
            [token_id],
        );
    }

    /// Lock a publicly owned NFT for migration to a new rollup.
    /// Creates a MigrationNote and enqueues clearing the public owner.
    #[external("private")]
    fn lock_public_nft_for_migration(token_id: Field, destination_rollup: Field, mpk: Point) {
        let note_owner = self.context.msg_sender().unwrap();

        lock_migration_notes(
            self.context,
            note_owner,
            destination_rollup,
            mpk,
            [token_id],
        );

        NftMigrationApp::at(self.context.this_address())
            ._clear_public_owner(note_owner, token_id)
            .enqueue(self.context);
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

        let old_app = self.storage.old_rollup_app_address.read();
        migrate_notes_mode_a(
            self.context,
            self.storage.archive_root_address.read(),
            mpk,
            signature,
            old_app,
            [note_proof_data],
            block_header,
        );

        let recipient = self.context.msg_sender().unwrap();
        let new_note = NFTNote { token_id };
        self.storage.private_nfts.at(recipient).insert(new_note).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
        NftMigrationApp::at(self.context.this_address())._set_nft_exists(token_id).enqueue(
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

        let old_app = self.storage.old_rollup_app_address.read();
        migrate_notes_mode_a(
            self.context,
            self.storage.archive_root_address.read(),
            mpk,
            signature,
            old_app,
            [note_proof_data],
            block_header,
        );

        let recipient = self.context.msg_sender().unwrap();
        NftMigrationApp::at(self.context.this_address())
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
        nsk: Scalar,
    ) {
        assert(full_proof_data.note_proof_data.data.token_id == token_id, "Token ID mismatch");

        let old_app = self.storage.old_rollup_app_address.read();
        // NOTE: assumes old and new contracts have identical storage layout
        let expected_storage_slot = STORAGE_LAYOUT_NftMigrationApp.fields.private_nfts.slot;

        migrate_notes_mode_b(
            self.context,
            self.storage.archive_root_address.read(),
            signature,
            old_app,
            [full_proof_data],
            expected_storage_slot,
            block_header,
            notes_owner,
            public_keys,
            partial_address,
            key_note,
            nsk,
        );

        let recipient = self.context.msg_sender().unwrap();
        let new_note = NFTNote { token_id };
        self.storage.private_nfts.at(recipient).insert(new_note).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
        NftMigrationApp::at(self.context.this_address())._set_nft_exists(token_id).enqueue(
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
        assert(proof_data.data != AztecAddress::zero(), "Cannot migrate zero-address ownership");

        let archive_registry = self.storage.archive_root_address.read();
        let old_app = self.storage.old_rollup_app_address.read();

        // 1. Verify public state existed at snapshot height
        // NOTE: assumes old and new contracts have identical storage layout
        migrate_public_map_state_mode_b(
            self.context,
            archive_registry,
            old_app,
            proof_data,
            STORAGE_LAYOUT_NftMigrationApp.fields.public_owners.slot,
            block_header,
            token_id,
        );

        // 2. Verify key note belongs to the proven owner
        let proven_owner = proof_data.data;
        let note_hash_tree_root = block_header.state.partial.note_hash_tree.root;
        let _ = key_note.verify_key_note_inclusion(
            self.context,
            archive_registry,
            proven_owner,
            note_hash_tree_root,
        );

        // 3. Verify signature over recipient (prevents front-running)
        let public_state_hash = proof_data.public_state_hash();
        let old_rollup = block_header.global_variables.version;
        let current_rollup = self.context.version();
        let recipient = self.context.msg_sender().unwrap();
        let new_app = self.context.this_address();

        signature.verify_migration_signature::<CLAIM_DOMAIN_B_PUBLIC>(
            old_rollup,
            current_rollup,
            public_state_hash,
            recipient,
            new_app,
            key_note.data.mpk,
        );

        // 4. Mint to authenticated recipient
        NftMigrationApp::at(self.context.this_address())
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

    #[external("public")]
    #[only_self]
    fn _clear_public_owner(owner: AztecAddress, token_id: Field) {
        let current_owner = self.storage.public_owners.at(token_id).read();
        assert(current_owner == owner, "Not the public owner of this NFT");
        self.storage.public_owners.at(token_id).write(AztecAddress::zero());
        // nft_exists stays true - monotonic flag prevents replay attacks
    }
}
