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

/// Migration lock for Mode A (cooperative) migration.
///
/// ## Usage:
/// ```
///   MigrationLock::new(context, mpk, owner, destination_rollup)
///       .lock_state(migration_data)   // repeat for each piece of migration data
///       .finish();                    // finalize migration (no-op)
/// ```
///
/// It is recommended to "batch" migrated state into one `.lock_state(...)` call:
///
///```
///   #[derive(Packable, Serialize)]
///   struct MigrationData {
///       state1: ...,
///       state2: ...,
///        ...
///   }
///
/// ...
///
///   let migration_data = MigrationData { state1, state2, ... };
///
///   MigrationLock::new(context, mpk, owner, destination_rollup)
///       .lock_state(migration_data)
///       .finish();
///```
///
/// ## Multiple MigrationLock instances:
/// Each `.lock_state(...)` call creates a new migration note and emits a corresponding event
/// with the migration data. To avoid data ID collisions in the events, when using multiple `MigrationLock` instances,
/// you should use `MigrationLock::new_with_offset` to set a unique starting data ID for each instance.
///
/// ```
///   #[external("private")]
///   fn lock_for_migration_1(destination_rollup: Field, mpk: Point) {
///       ...
///
///       MigrationLock::new(self.context, mpk, note_owner, destination_rollup)
///           .lock_state(state1)
///           .finish();
///   }
///
///   #[external("private")]
///   fn lock_for_migration_2(destination_rollup: Field, mpk: Point) {
///       ...
///
///       MigrationLock::new_with_offset(self.context, mpk, note_owner, destination_rollup, 1)
///           .lock_state(state2)
///           .finish();
///   }
/// ```
///
/// The `.finish()` method is a no-op.
/// It's included to surpress warnings about unused variables and
/// to maintain a consistent builder pattern with `MigrationModeA`.
pub struct MigrationLock {
    context: &mut PrivateContext,
    mpk: Point,
    owner: AztecAddress,
    destination_rollup: Field,
    notes_creator: AztecAddress,
    next_data_id: Field,
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
        Self {
            context,
            mpk,
            owner,
            destination_rollup,
            notes_creator: context.this_address(),
            next_data_id: 0,
        }
    }

    pub fn new_with_offset(
        context: &mut PrivateContext,
        mpk: Point,
        owner: AztecAddress,
        destination_rollup: Field,
        data_id_offset: Field,
    ) -> Self {
        let mut lock = Self::new(context, mpk, owner, destination_rollup);
        lock.next_data_id = data_id_offset;
        lock
    }

    pub fn lock_state<T: Packable + Serialize>(mut self, migration_data: T) -> Self {
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
        emit_event_in_private(
            self.context,
            MigrationDataEvent { data_id: self.next_data_id, migration_data },
        )
            .deliver_to(self.owner, MessageDelivery.ONCHAIN_CONSTRAINED);
        self.next_data_id += 1;
        self
    }

    pub fn finish(self) {
        let _ = self;
        // No on-chain action needed to "finish" the migration from the source rollup's perspective.
    }
}
