use crate::constants::MIGRATION_NOTE_STORAGE_SLOT;
use super::{migration_data_event::MigrationDataEvent, migration_note::MigrationNote};
use aztec::{
    context::PrivateContext,
    event::event_emission::emit_event_in_private,
    messages::message_delivery::MessageDelivery,
    note::lifecycle::create_note,
    protocol::{address::AztecAddress, traits::{Packable, Serialize}},
};
use std::embedded_curve_ops::EmbeddedCurvePoint as Point;

pub struct MigrationLock {
    context: &mut PrivateContext,
    mpk: Point,
    owner: AztecAddress,
    destination_rollup: Field,
    notes_creator: AztecAddress,
}

impl MigrationLock {
    pub fn new(
        context: &mut PrivateContext,
        mpk: Point,
        owner: AztecAddress,
        destination_rollup: Field,
    ) -> Self {
        assert(
            (mpk.y * mpk.y == mpk.x * mpk.x * mpk.x - 17) & (!mpk.is_infinite),
            "mpk not on Grumpkin curve",
        );
        Self { context, mpk, owner, destination_rollup, notes_creator: context.this_address() }
    }

    pub fn lock_state<T: Packable + Serialize>(self, migration_data: T) -> Self {
        let migration_note = MigrationNote::new(
            self.notes_creator,
            self.mpk,
            self.destination_rollup,
            migration_data,
        );
        create_note(
            self.context,
            self.owner,
            MIGRATION_NOTE_STORAGE_SLOT,
            migration_note,
        )
            .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

        // Emit migration data as an encrypted private event so the recipient can
        // reconstruct the original data when claiming on the new rollup.
        emit_event_in_private(self.context, MigrationDataEvent { migration_data }).deliver_to(
            self.owner,
            MessageDelivery.ONCHAIN_CONSTRAINED,
        );
        self
    }

    pub fn finish(self) {
        let _ = self;
        // No on-chain action needed to "finish" the migration from the source rollup's perspective.
    }
}
