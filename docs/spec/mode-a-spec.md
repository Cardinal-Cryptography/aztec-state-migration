---
layout: default
title: Mode A Specification -- Cooperative Migration
---

[← Home](../index.md)

# Mode A Specification -- Cooperative Migration

## Overview

Mode A is the standard migration path when the old rollup is still live and producing blocks. Users cooperatively lock their state on the old rollup, then claim equivalent state on the new rollup by proving the locked note's inclusion in the old rollup's note hash tree.

The flow has two phases:

1. **Lock (old rollup):** The app contract uses the `MigrationLock` builder to burn or lock user state and create `MigrationNote`s committed to the old rollup's note hash tree.
2. **Claim (new rollup):** The user proves the `MigrationNote` exists in the old rollup's state (via an L1-bridged archive root) and the new rollup's app contract mints equivalent state.

Double spending is prevented in the following way: the lock notes on old rollup are not spendable (locking is one-directional) and upon claiming on the new rollup an appropriate nullifier is emitted.

Both private notes and public state use the same lock-and-claim mechanism. The `MigrationNote` is identical in both cases; only the app-level operations that precede the lock and follow the claim differ.

**Prerequisite:** The old and new app contracts must agree on the `MigrationNote` format and the migration storage slot constant (`MIGRATION_NOTE_STORAGE_SLOT`). Mode A migration notes are committed under a fixed migration slot and do not depend on the app's general public storage layout. (Identical storage layouts are required for Mode B public state migration, not Mode A.)

## Lock Flow (Library Level)

The `MigrationLock` builder (`noir/aztec-state-migration/src/mode_a/migration_lock.nr`) lets app developers chain multiple lock operations in a single call:

```
MigrationLock::new(context, mpk, owner, destination_rollup)
    .lock_state(migration_data_1)
    .lock_state(migration_data_2)
    .finish();
```

**Steps:**

1. `new(...)`: Assert that `mpk` (migration public key) is on the Grumpkin curve.
2. Each `.lock_state(migration_data)` call:
   - Constructs a `MigrationNote` via `MigrationNote::new(note_creator, mpk, destination_rollup, migration_data)`. The constructor hashes the packed data: `migration_data_hash = poseidon2_hash(migration_data.pack())`.
   - Commits the note to the note hash tree under `MIGRATION_NOTE_STORAGE_SLOT` via `create_note`.
   - Emits a `MigrationDataEvent { migration_data }` encrypted to `owner` via `emit_event_in_private` + `deliver_to` (AES128 ECDH encryption).
3. `finish()`: Consumes the builder. No on-chain action is needed from the source rollup's perspective; the method exists so that omitting it triggers compiler warnings about unused values, catching incomplete builder chains at compile time.

### MigrationNote

`MigrationNote` (`noir/aztec-state-migration/src/mode_a/migration_note.nr`) uses `#[custom_note]` because ownership is determined by `mpk`, not by a standard Aztec owner address. The note hash intentionally excludes the standard `owner` parameter.

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `note_creator` | `AztecAddress` | Address of the creating app contract |
| `mpk` | `Point` | Migration public key (Grumpkin curve point) |
| `destination_rollup` | `Field` | Target rollup version identifier (prevents cross-rollup replay) |
| `migration_data_hash` | `Field` | `poseidon2_hash` of the original data's packed representation |

**Note hash computation** (`MigrationNote::compute_note_hash`):

```
note_hash = poseidon2_hash_with_separator(
    [note_creator, mpk.x, mpk.y, destination_rollup, migration_data_hash, storage_slot, randomness],
    DOM_SEP__NOTE_HASH
)
```

### MigrationDataEvent

`MigrationDataEvent<T>` (`noir/aztec-state-migration/src/mode_a/migration_data_event.nr`) delivers the original migration data (before hashing) to the recipient. Only the hash is stored in the note; the full data travels via this event so the claimer can reconstruct it on the new rollup.

The `#[event]` macro does not support generic structs, so `MigrationDataEvent` implements `EventInterface` manually with `#[derive(Serialize)]`.

Each event carries a `data_id` field that identifies the kind of migration data it contains. Within a single `MigrationLock` chain, `data_id` auto-increments from 0. When a contract uses multiple `MigrationLock` instances (e.g. separate entrypoints for private and public state), use `MigrationLock::new_with_offset` to assign non-overlapping `data_id` ranges. Wallet clients match events to notes by **emission order** within a transaction: each `lock_state` call emits a `create_note` followed immediately by the corresponding `MigrationDataEvent`, so the i-th note and i-th event always correspond. *(Source: `migration_lock.nr`, `migration_data_event.nr`)*

## Claim Flow (Library Level)

The `MigrationModeA` builder (`noir/aztec-state-migration/src/mode_a/builder.nr`) verifies locked notes and authorizes the claim on the new rollup:

```
MigrationModeA::new(context, old_app, archive_registry, block_header, mpk)
    .with_note(note_proof_data_1)
    .with_note(note_proof_data_2)
    .finish(recipient, signature);
```

**Verification chain:**

1. **Note inclusion (per `.with_note()`):** Reconstruct the `MigrationNote` and compute its hash via `MigrationNote::compute_note_hash`. Then call `note_proof_data.verify_note_inclusion(old_app, note_hash, note_hash_tree_root)`, which silos with the old app address (`compute_siloed_note_hash`), applies uniqueness (`compute_unique_note_hash` with nonce), and verifies the Merkle proof against the note hash tree root. Returns the unique note hash.
2. **Nullifier emission (per `.with_note()`):** Emit a nullifier via `MigrationNote::compute_nullifier` keyed to the note's randomness (see [Nullifier Derivation](#nullifier-derivation)).
3. **Hash accumulation (per `.with_note()`):** Each verified note hash is fed into a running `Poseidon2Hasher`.
4. **Signature verification (`finish`):** Finalize the accumulated `notes_hash`, then call `signature.verify_migration_signature::<DOM_SEP__CLAIM_A>(...)`.
5. **Block hash verification (`finish`):** Compute `block_hash = block_header.hash()`, then call `MigrationArchiveRegistry.verify_migration_mode_a(block_number, block_hash)` via a private cross-contract call. See [General Specification -- Block Hash Verification](migration-spec.md#block-hash-verification) for the two-step registration process.

## Public State Migration (App-Level)

Public state migration reuses the same `MigrationNote` and claim circuit as private migration. The difference is in the app-level wrappers:

- **Lock (old rollup):** The app contract uses the `MigrationLock` builder to create `MigrationNote`s, then applies its own app-specific state transition. If the state transition fails, the entire transaction reverts.
- **Claim (new rollup):** The app contract uses the `MigrationModeA` builder to verify locked notes, then applies its own app-specific state transition.

## Authentication

Mode A claims use `DOM_SEP__CLAIM_A` as the domain separator. The signed message is:

```
msg = poseidon2_hash([DOM_SEP__CLAIM_A, old_rollup, current_rollup, notes_hash, recipient, new_app_address])
```

| Field | Purpose |
|-------|---------|
| `DOM_SEP__CLAIM_A` | Domain separator (prevents replay across migration modes) |
| `old_rollup` | Old rollup version from `block_header.global_variables.version` |
| `current_rollup` | New rollup version from `context.version()` |
| `notes_hash` | `poseidon2_hash(note_hashes)` over all note hashes being claimed |
| `recipient` | Recipient address on new rollup |
| `new_app_address` | New app contract address (`context.this_address()`) |

For shared Schnorr signature mechanics and key derivation, see [General Specification -- Authentication](migration-spec.md#authentication).

## Nullifier Derivation

Mode A uses the `MigrationNote`'s randomness (not the user's secret key) to derive the nullifier. This prevents observers from linking old and new rollup identities by predicting the nullifier from public note fields.

**Formula** (`MigrationNote::compute_nullifier` in `migration_note.nr`):

```
nullifier = poseidon2_hash_with_separator([note_hash, randomness], DOM_SEP__NOTE_NULLIFIER)
```

Where `note_hash` is the note hash of the `MigrationNote` being claimed, and `randomness` is the `MigrationNote`'s randomness (passed as `wrapped_randomness.inner`). The kernel subsequently silos the nullifier by contract address before committing it to the nullifier tree.

For all nullifier formulas, see [General Specification -- Migration Nullifiers](migration-spec.md#migration-nullifiers).

## Batching

The `MigrationModeA` builder chains `.with_note()` calls, each verifying one `MigrationNoteProofData` and feeding its hash into a running accumulator. The signature in `finish()` covers the hash of all accumulated note hashes, so the entire batch is authenticated atomically.

Apps choose the number of `.with_note()` calls based on their consolidation strategy. A common pattern is a single note, where the app consolidates multiple balance notes into one `migration_data_hash` before locking. Apps that create multiple `MigrationNote` instances per lock (e.g., locking distinct asset types) would chain additional calls.

## Wallet Integration

A migration webapp will orchestrate the end-to-end flow. The wallet's role is to expose the key management and signing primitives that the webapp needs. The TS library (`ts/aztec-state-migration/`) provides `MigrationBaseWallet`, an abstract class that already implements proof building, event retrieval, and archive bridging. Wallet developers must subclass it and implement:

- `getMigrationPublicKey(account)` -- return the Grumpkin migration public key for the account
- `getPublicKeys(account)` -- return the full set of public keys for the account
- `getMigrationSignerFromAddress(account)` -- return a signing function that produces Schnorr signatures over migration claim messages

See `wallet/entrypoints/node.ts` and `wallet/entrypoints/browser.ts` for reference implementations.

For key derivation, Browser vs Node environments, and key persistence, see [General Specification -- Wallet Integration](migration-spec.md#wallet-integration-shared).

## PoC Limitations

The following limitations are specific to Mode A in the current proof-of-concept. For shared limitations (no supply cap, no access control on `mint()`/`burn()`), see [General Specification -- PoC Limitations](migration-spec.md#poc-limitations).

1. **`old_rollup_app_address` is a deployment-time configuration.** The address is read from the app contract's immutable public storage (set at deployment). If configured incorrectly, migrations silently fail due to archive root mismatch. There is no on-chain verification that this address corresponds to a legitimate app on the old rollup. See [security](../security.md) for details.


## See Also

- [General Specification](migration-spec.md) -- Shared protocol design, authentication, nullifiers, proof data types, API
- [Mode B Specification](mode-b-spec.md) -- Emergency snapshot migration
- [Integration Guide](../integration-guide.md) -- TS SDK usage, wallet classes, proof data types
- [Security](../security.md) -- Trust assumptions and PoC limitations
