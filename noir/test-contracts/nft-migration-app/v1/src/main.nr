mod types;

use aztec::macros::aztec;

/// V1 of the NFT migration contract.
///
/// Deployed on the OLD rollup. Supports normal NFT operations
/// and Mode A lock functions for migration.
#[aztec]
pub contract NftMigrationAppV1 {
    use crate::types::nft_note::NFTNote;
    use aztec::{
        macros::{functions::{external, initializer, only_self}, storage::storage},
        messages::message_delivery::MessageDelivery,
        note::{
            constants::MAX_NOTES_PER_PAGE, note_getter_options::NoteGetterOptions,
            note_interface::NoteProperties, note_viewer_options::NoteViewerOptions,
        },
        protocol_types::address::AztecAddress,
        state_vars::{Map, Owned, PrivateSet, PublicImmutable, PublicMutable},
        utils::comparison::Comparator,
    };
    use aztec_state_migration::{
        mode_a::lock_migration_notes,
        Point,
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
    fn constructor(minter: AztecAddress) {
        self.storage.minter.initialize(minter);
    }

    // ============================================================
    // Standard NFT operations
    // ============================================================

    #[external("private")]
    fn mint_to_private(to: AztecAddress, token_id: Field) {
        assert(self.context.msg_sender().unwrap() == self.storage.minter.read(), "Only minter");
        let new_note = NFTNote { token_id };
        self.storage.private_nfts.at(to).insert(new_note).deliver(
            MessageDelivery.CONSTRAINED_ONCHAIN,
        );
        NftMigrationAppV1::at(self.context.this_address())._set_nft_exists(token_id).enqueue(
            self.context,
        );
    }

    #[external("private")]
    fn mint_to_public(to: AztecAddress, token_id: Field) {
        assert(self.context.msg_sender().unwrap() == self.storage.minter.read(), "Only minter");
        assert(to != AztecAddress::zero(), "Cannot mint to zero address");
        NftMigrationAppV1::at(self.context.this_address())._set_public_owner(token_id, to).enqueue(
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

        NftMigrationAppV1::at(self.context.this_address())
            ._clear_public_owner(note_owner, token_id)
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
