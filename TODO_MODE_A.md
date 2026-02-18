# Mode A PoC - Known Limitations & Future Work

## 1. ~~Schnorr-Based Authentication~~ (Done)

- Nullifier uses note `randomness` instead of `msk`, fixing the dummy nullifier problem.
- `msk` removed from `MigrationArgs` — the circuit receives `mpk` directly.
- Schnorr signature authenticates the migrating user. The signed message binds the claim to a specific recipient and app contract, preventing front-running:
```
// off-chain (TS client):
notes_hash = poseidon2([note_hash_1, ..., note_hash_N])
msg = poseidon2(CLAIM_DOMAIN_A, old_rollup, new_rollup, notes_hash, recipient, new_app_address)
sig = schnorr_sign(msk, msg)

// in-circuit (Noir):
schnorr_verify(sig, mpk, msg)
```
`msk` stays entirely off-chain — only used for deriving `mpk` and signing.

## 2. Single Note per Migration Transaction (ExampleApp only)

The Noir circuit (`migrate_notes_mode_a`) already accepts `[MigrationNoteProofData; N]` and loops over all N notes. However the ExampleApp contract hardcodes `N = 1`, and the TS client builds a proof for exactly one note. For the ExampleApp this is sufficient — `lock_migration_notes_mode_a` consolidates multiple balance notes into a single `migration_data` hash (the total amount), producing one MigrationNote per lock call.

Apps that create multiple MigrationNotes per lock (e.g. locking distinct asset types) would need the TS client to retrieve all migration notes and build an array of `MigrationNoteProofData` proofs. The library circuit is ready; only the app contract's array size and TS client need updating.

## ~~3. migration_data_hash: Only a Hash is Stored in the Note~~ (Done)

`MigrationNote` stores `migration_data_hash: Field` — a `poseidon2_hash` of the original data's packed representation. The `MigrationNote::new<T: Packable>` constructor accepts any `T: Packable` and hashes it automatically.

The original data is now delivered via an encrypted `MigrationDataEvent<T>` emitted by `lock_migration_notes` alongside note creation. The event uses `emit_event_in_private` + `deliver_to` for end-to-end encryption (AES128 ECDH). The `#[event]` macro doesn't support generics, so `MigrationDataEvent` implements `EventInterface` manually with `#[derive(Serialize)]`.

On the TS side, `getMigrationDataEvents()` on the migration wallet retrieves the decrypted events, and `MigrationNoteProofData.fromProofDataAndEvent()` combines note proofs with event data. Events should be filtered by `txHash` to match them to the correct lock transaction.

**TODO:** Consider including a note-identifying hash in the event (e.g. `migration_note_hash`) so wallet clients can match events to notes without relying on `txHash` filtering. The full note hash requires randomness from `create_note`, which isn't easily accessible at event emission time.

## 4. Supply Cap

**Current:** No supply cap enforced. The new rollup's ExampleMigrationApp mints freely on each successful migration.

**Production:** Should enforce a `mintable_supply` cap set at deployment, ideally matching the total locked supply on the old rollup. Without this, a bug or compromised archive root could allow unlimited minting.

## 7. old_app_address is an Unchecked Witness

**Current:** On the new rollup, `old_app_address` is read from ExampleApp's `PublicImmutable` storage (set at deployment). The migration circuit trusts this value when siloing the reconstructed note hash.

**Problem:** If `old_app_address` is set incorrectly at deployment, migrations would silently fail (archive root mismatch). There is no on-chain verification that this address actually corresponds to a legitimate app on the old rollup.

**Production:** Consider an on-chain registry that maps old rollup app addresses to new rollup app addresses, verified via L1 or governance.

## 8. L1 migrateArchiveRoot is Permissionless

**Current:** Anyone can call `L1Migrator.migrateArchiveRoot()` to bridge an archive root snapshot. This is by design (users self-serve), but each call consumes an L1-to-L2 message slot.

**Consideration:** An attacker could spam `migrateArchiveRoot` calls to fill L1-to-L2 message trees or increase costs. Consider rate limiting or requiring a small bond.

## ~~9. MSK Persistence is Caller's Responsibility~~ (Done)

`deriveMasterMigrationSecretKey()` in `ts/migration-lib/keys.ts` now derives the MSK deterministically from the account's secret key via `sha512ToGrumpkinScalar([secretKey, MSK_M_GEN])`. No random generation and no explicit persistence needed — the key can be re-derived from the account secret at any time.

## 10. Decompose migration_lib into Separate Validation Functions

**Current:** `migrate_notes_mode_a` is a monolithic function that performs archive proof validation and note migration in a single call.

**Production:** Expose separate functions for archive proof validation. This allows app contracts to compose only the pieces they need and makes the library more reusable across different migration strategies.
