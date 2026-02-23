---
layout: default
title: Mode A -- Cooperative Migration
---

[← Home](index.md)

# Mode A -- Cooperative Migration

## Overview

Mode A is the standard migration path when the old rollup is still live and producing blocks. Users cooperatively lock their state on the old rollup, then claim equivalent state on the new rollup by proving the locked note's inclusion in the old rollup's note hash tree.

The flow has two phases:

1. **Lock (old rollup):** The app contract calls `lock_migration_notes` to burn or lock user state and create a `MigrationNote` committed to the old rollup's note hash tree.
2. **Claim (new rollup):** The user proves the `MigrationNote` exists in the old rollup's state (via an L1-bridged archive root) and the new rollup's app contract mints equivalent state.

Both private notes and public balances use the same lock-and-claim mechanism. The `MigrationNote` is identical in both cases; only the app-level operations that precede the lock and follow the claim differ.

**Prerequisite:** The old and new app contracts must agree on the `MigrationNote` format and the migration storage slot constant (`MIGRATION_MODE_A_STORAGE_SLOT`). Mode A migration notes are committed under a fixed migration slot and do not depend on the app's general public storage layout. (Identical storage layouts are required for Mode B public state migration, not Mode A.)

## Lock Flow (Library Level)

The library function `lock_migration_notes` (`aztec-state-migration/src/mode_a/ops.nr`, function `lock_migration_notes`) creates one `MigrationNote` per element in the `migration_data` array and emits a corresponding encrypted event for each.

**Steps:**

1. Assert that `mpk` (migration public key) is on the Grumpkin curve.
2. For each element in `migration_data`:
   a. Construct a `MigrationNote` via `MigrationNote::new(note_creator, mpk, destination_rollup, migration_data[i])`. The constructor hashes the packed data: `migration_data_hash = poseidon2_hash(migration_data.pack())`.
   b. Commit the note to the note hash tree under `MIGRATION_MODE_A_STORAGE_SLOT` via `create_note`.
   c. Emit a `MigrationDataEvent { migration_data: migration_data[i] }` encrypted to the `notes_owner` via `emit_event_in_private` + `deliver_to` (AES128 ECDH encryption).

### MigrationNote

`MigrationNote` (`aztec-state-migration/src/mode_a/migration_note.nr`) uses `#[custom_note]` because ownership is determined by `mpk`, not by a standard Aztec owner address. The note hash intentionally excludes the standard `owner` parameter.

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

`MigrationDataEvent<T>` (`aztec-state-migration/src/mode_a/migration_data_event.nr`) delivers the original migration data (before hashing) to the recipient. Only the hash is stored in the note; the full data travels via this event so the claimer can reconstruct it on the new rollup.

The `#[event]` macro does not support generic structs, so `MigrationDataEvent` implements `EventInterface` manually with `#[derive(Serialize)]`.

On the TS side, `getMigrationDataEvents()` on the migration wallet retrieves decrypted events. Events are matched to lock transactions by `txHash`.

> **Known limitation:** Events do not include a note-identifying hash (e.g., `migration_note_hash`), so wallet clients match events to notes via `txHash` filtering. The full note hash requires randomness from `create_note`, which is not available at event emission time. *(Source: `migration_data_event.nr:13`)*

## Claim Flow (Library Level)

The library function `migrate_notes_mode_a` (`aztec-state-migration/src/mode_a/ops.nr`, function `migrate_notes_mode_a`) verifies locked notes and authorizes the claim on the new rollup.

**Verification chain:**

1. **Note inclusion (per note):** For each `MigrationNoteProofData` element, reconstruct the `MigrationNote` and compute its hash via `MigrationNote::compute_note_hash`. Then call `note_proof_data.verify_note_inclusion(old_app, note_hash, note_hash_tree_root)`, which silos with the old app address (`compute_siloed_note_hash`), applies uniqueness (`compute_unique_note_hash` with nonce), and verifies the Merkle proof against the note hash tree root. Returns the unique note hash.
2. **Nullifier emission (per note):** Emit a nullifier via `MigrationNote::compute_nullifier` keyed to the note's randomness (see [Nullifier Derivation](#nullifier-derivation)).
3. **Signature verification:** Compute `notes_hash = poseidon2_hash(note_hashes)` over all verified note hashes, then call `signature.verify_migration_signature::<CLAIM_DOMAIN_A>(...)` (see [Authentication](#authentication)).
4. **Block hash verification (enqueued public call):** Compute `block_hash = block_header.hash()`, then enqueue a public call to `MigrationArchiveRegistry.verify_migration_mode_a(block_number, block_hash)` to confirm the block hash matches one registered on-chain (bridged from L1).

### Two-Step Archive Verification

Block hash trust is established in two steps, both on the `MigrationArchiveRegistry`:

1. **`register_block`:** Verifies a block header against a consumed L1-bridged archive root via Merkle proof. Stores the mapping `block_number -> block_hash`.
2. **`verify_migration_mode_a(block_number, block_hash)`:** Checks that the stored block hash matches the one computed by the claim circuit.

This separation allows block registration to happen once per block, with multiple migration claims referencing the same registered block.

## Public Balance Migration (App-Level)

Public balance migration reuses the same `MigrationNote` and claim circuit as private migration. The difference is in the app-level wrappers:

- **Lock (old rollup):** The app contract calls `lock_migration_notes` to create a `MigrationNote`, then applies its own state transition (e.g., decrementing a public balance). If the state transition fails, the entire transaction reverts.
- **Claim (new rollup):** The app contract calls `migrate_notes_mode_a` (same library function as private claim), then applies its own state transition (e.g., incrementing a public balance).

## Authentication

Migration claims are authenticated via Schnorr signatures over a Poseidon2 message hash. The signature binds the claim to a specific recipient and app contract, preventing front-running.

**Signed message:**

```
msg = poseidon2_hash([CLAIM_DOMAIN_A, old_rollup, current_rollup, notes_hash, recipient, new_app_address])
```

**Verification** (`signature.nr`, function `verify_migration_signature`):

```
schnorr::verify_signature(mpk, signature.bytes, msg.to_be_bytes::<32>())
```

**Message fields:**

| Field | Purpose |
|-------|---------|
| `CLAIM_DOMAIN_A` | Domain separator (prevents replay across migration modes) |
| `old_rollup` | Old rollup version from `block_header.global_variables.version` |
| `current_rollup` | New rollup version from `context.version()` |
| `notes_hash` | `poseidon2_hash(note_hashes)` over all note hashes being claimed |
| `recipient` | Recipient address on new rollup |
| `new_app_address` | New app contract address (`context.this_address()`) |

**Key derivation:** The migration secret key (MSK) is derived deterministically from the account's secret key via `sha512ToGrumpkinScalar([secretKey, MSK_M_GEN])` (`ts/aztec-state-migration/keys.ts`, export `deriveMasterMigrationSecretKey`). The MSK stays entirely off-chain -- it is used only for deriving `mpk` and signing. The circuit receives `mpk` directly.

> **Production requirement:** `CLAIM_DOMAIN_A` currently reuses `MIGRATION_MODE_A_STORAGE_SLOT`. A distinct domain separator should be assigned before production deployment. *(Source: `constants.nr:6`)*

## Nullifier Derivation

Mode A uses the `MigrationNote`'s randomness (not the user's secret key) to derive the nullifier. This prevents observers from linking old and new rollup identities by predicting the nullifier from public note fields.

**Formula** (`MigrationNote::compute_nullifier` in `migration_note.nr`):

```
nullifier = poseidon2_hash_with_separator([note_hash, randomness], DOM_SEP__NOTE_NULLIFIER)
```

Where `note_hash` is the note hash of the `MigrationNote` being claimed, and `randomness` is the `MigrationNote`'s randomness (passed as `wrapped_randomness.inner`). The kernel subsequently silos the nullifier by contract address before committing it to the nullifier tree.

## Batching

The library function `migrate_notes_mode_a` accepts `[MigrationNoteProofData<T>; N]` and loops over all N notes. The signature covers the hash of all N note hashes, so the entire batch is authenticated atomically.

However, the reference app contract sets `N = 1`. This is sufficient for the example because `lock_migration_notes_mode_a` consolidates multiple balance notes into a single `migration_data_hash` (the total amount), producing one `MigrationNote` per lock call.

Apps that create multiple `MigrationNote` instances per lock (e.g., locking distinct asset types) would set a larger N. The library circuit is ready; only the app contract's array size and TS client need updating.

## PoC Limitations

The following limitations apply to the current proof-of-concept implementation and are **not suitable for production**:

1. **No supply cap enforcement.** The reference app contract mints freely on each successful migration. A production deployment should enforce a `mintable_supply` cap set at deployment, ideally matching the total locked supply on the old rollup.

2. **`old_rollup_app_address` is a deployment-time configuration.** The address is read from the app contract's immutable public storage (set at deployment). If configured incorrectly, migrations silently fail due to archive root mismatch. There is no on-chain verification that this address corresponds to a legitimate app on the old rollup. See [threat model](threat-model.md) for details.

3. **L1 relay is permissionless.** Anyone can call `Migrator.sol`'s `migrateArchiveRoot()` to bridge an archive root snapshot. An attacker could spam calls to fill L1-to-L2 message trees or increase costs. Consider rate limiting or requiring a small bond.

4. **No access control on `mint()` / `burn()`.** The reference app contract has no access control on `mint()` and `burn()` functions. A production token contract would restrict minting to authorized callers (e.g., migration-only minting).

## See Also

- [Migration Specification](spec/migration-spec.md) -- Nullifier formulas, API tables, proof requirements
- [Mode B](mode-b.md) -- Alternative migration path when old rollup is unavailable
- [Integration Guide](integration-guide.md) -- TS SDK usage, wallet classes, proof data types
- [Threat Model](threat-model.md) -- Trust assumptions and PoC limitations
