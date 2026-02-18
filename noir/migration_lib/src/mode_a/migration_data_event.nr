use aztec::event::{event_interface::EventInterface, event_selector::EventSelector};
use aztec::protocol_types::traits::Serialize;

/// Event emitted alongside MigrationNote creation to deliver the original migration data
/// (in encrypted form) to the recipient. Only the hash is stored in the note; the full data
/// travels via this event so the claimer can reconstruct it on the new rollup.
///
/// Implements EventInterface manually because the #[event] macro
/// does not support generic structs.
/// See https://github.com/AztecProtocol/aztec-packages/blob/c6b2615d5119cf306e8b9c903fb00dad08560d32/noir-projects/aztec-nr/aztec/src/macros/utils.nr#L154
#[derive(Serialize)]
pub struct MigrationDataEvent<T> {
    // TODO: consider including a hash of the migration data here as well,
    // to wallet clients can easily filter for relevant events.
    // pub migration_note_hash: Field,
    pub migration_data: T,
}

impl<T> EventInterface for MigrationDataEvent<T> {
    fn get_event_type_id() -> EventSelector {
        // "MigrationDataEvent(Field)" - would match what the #[event] macro would generate
        // if T were concretely instantiated as Field.
        // This is fine because the event selector is only used for event discovery and filtering,
        // and the recipient will know to decode the data as T.
        // To fix it #[event] macro would need to support generics.
        EventSelector::from_signature("MigrationDataEvent")
    }
}
