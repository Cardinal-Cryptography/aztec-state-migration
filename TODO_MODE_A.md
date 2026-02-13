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

## 2. Single Note per Migration Transaction

**Current:** The TS client (`prepareMigrateModeA`) retrieves `lockNotes[0]` and builds a proof for exactly one `FullMigrationNote`. For the ExampleApp this is sufficient — `lock_migration_notes_mode_a` consolidates multiple balance notes into a single `migration_data` hash (the total amount), producing one MigrationNote per lock call.

**Production:** Apps that create multiple MigrationNotes per lock (e.g. locking distinct asset types) would need the TS client to retrieve all migration notes and build an array of `FullMigrationNote` proofs sharing the same `MigrationArgs`. The Noir circuit already supports `[FullMigrationNote; N]`.

## 3. migration_data is a Single Field

Each `MigrationNote` carries one `migration_data: Field`. This is intentionally minimal — apps handle complexity at their level:
- Hash multiple fields/nested data into a single field and reconstruct on the new rollup (as the ExampleApp does with `poseidon2(amount.serialize())`)
- Lock multiple `MigrationNote`s if distinct pieces of data need to be migrated independently

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

## 9. MSK Persistence is Caller's Responsibility

**Current:** `prepareMigrationNoteLock()` generates a random `msk` and returns it. The caller must persist it across the lock-bridge-migrate flow (potentially days or weeks). If lost, locked funds are unrecoverable.

**Production:** Consider built-in key derivation from the user's existing Aztec account keys (e.g. `msk = derive(account_secret, "migration", nonce)`), so the migration key can be re-derived without explicit storage. Since `msk` is now purely off-chain (item 1), wallet-managed key derivation is straightforward.
