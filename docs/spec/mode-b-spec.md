---
layout: default
title: Mode B Specification -- Emergency Snapshot Migration
---

[← Home](../index.md)

# Mode B Specification -- Emergency Snapshot Migration

## Overview

Mode B enables state migration when users have **not** pre-locked their notes on the old rollup. It is designed for emergency scenarios where the old rollup becomes unavailable before users can perform orderly Mode A lock-and-claim. Instead of relying on a dedicated lock note, Mode B lets users prove directly that:

1. A note existed in the old rollup's note hash tree at a fixed snapshot height H
2. That note was not nullified (spent) at height H
3. The user registered a migration key before H
4. The user knows the corresponding migration secret key and nullifier hiding key

Mode B also supports **public state migration** -- proving that specific public storage values existed in the old rollup's public data tree at height H.

## Library Architecture

Migration logic is implemented as a **library** (`aztec_state_migration`) rather than separate contracts. App contracts call library functions directly:

- `migrate_notes_mode_b` -- for private note migration
- `migrate_public_state_mode_b` -- for standalone public state
- `migrate_public_map_state_mode_b` -- for map-based public state
- `migrate_public_map_owned_state_mode_b` -- for owned map-based public state (requires signature)

App state stays in one place regardless of which migration path was used. The library handles proof verification, signature checking, and nullifier emission, while the app contract handles its own state updates.

Mode B library decomposition:

- **Private note migration** (`migrate_notes_mode_b`) delegates per-note work to `migrate_note()` which handles inclusion proof, non-nullification proof, and nullifier emission independently.
- **Public state migration** is composed of `migrate_public_state_mode_b` -> `migrate_public_map_state_mode_b` -> `migrate_public_map_owned_state_mode_b`, each adding one concern (slot derivation, ownership authentication).
- **Proof data types** are separate modules: `KeyNoteProofData`, `NonNullificationProofData`, `PublicStateProofData`, `NoteProofData`.

`migrate_notes_mode_b` accepts `[FullNoteProofData<Note>; N]` and loops over all N notes in a single proof. Apps choose N based on their needs; the library circuit supports arbitrary batch sizes.

## Proof Chain

### Private Note Migration

Mode B's private function verifies a chain of Merkle proofs connecting user notes back to a trusted block hash:

```
App note hash ──Merkle proof──> note_hash_tree_root ──(embedded in)──> BlockHeader
                                                                           │
MigrationKeyNote hash ──Merkle proof──> note_hash_tree_root               │
                                                                           │
                                                   BlockHeader.hash() ──(== block_hash)──> snapshot_block_hash
                                                                                               │
                                                                                (verified at registration time
                                                                                 via archive Merkle proof)
```

Simultaneously, for each note, a **nullifier non-inclusion proof** is checked against the same block header's nullifier tree root.

At the code level, `note_proof_data.note_hash()` computes the note hash from data, owner, slot, and randomness, and `note_proof_data.verify_note_inclusion()` verifies the note is in the note hash tree via Merkle proof (returning the unique note hash).

### Public State Migration

For public state, the proof chain is simpler:

```
packed_field[i] ──public data tree proof──> public_data_tree_root ──(embedded in)──> BlockHeader
                                                                                         │
                                                                 BlockHeader.hash() ──(== block_hash)──> snapshot_block_hash
```

For map-based storage, the storage slot is first derived by iterating `poseidon2_hash_with_separator([slot, key], DOM_SEP__PUBLIC_STORAGE_MAP_SLOT)` for each map key. Public data leaf hashing uses `DOM_SEP__PUBLIC_LEAF_SLOT` for the siloed index computation.

At the code level, `PublicStateProofData.migrate_public_state()` performs the full public state migration: verifying inclusion per slot and emitting the migration nullifier.

The app developer can specify which parts of the public state belongs to which `AztecAddress` -- and thus who has the rights to migrate it. For instance, for storage maps representing balance, of the type `AztecAdress -> u128`, the owner of a particular entry corresponds to the entry key (the `AztecAddress`).

### Block Header Binding

The private migration function receives a `BlockHeader` and computes `block_header.hash()`. This hash is then passed to a public function (`verify_migration_mode_b`) that checks it against the stored `snapshot_block_hash`.

This private->public split is necessary because the block hashes are stored in public state. The private function computes the block hash and the public function checks it, connected via the enqueue mechanism.

For the shared two-step block registration process, see [General Specification -- Block Hash Verification](migration-spec.md#block-hash-verification).

## Note Hash Computation

### UintNote (Two-Step Hash)

UintNote uses a two-step hash that matches the `uint-note` library exactly:

```
partial = poseidon2_hash_with_separator([owner, storage_slot, randomness], DOM_SEP__NOTE_HASH)
note_hash = poseidon2_hash_with_separator([partial, value], DOM_SEP__NOTE_HASH)
siloed = compute_siloed_note_hash(old_rollup_app_address, note_hash)
unique = compute_unique_note_hash(nonce, siloed)
```

The two-step structure exists because UintNote uses `#[partial_note(quote { self.value })]` -- the value is hashed separately from the other fields to support note value hiding during partial note flows.

### MigrationKeyNote (Owner-Bound Hash)

The MigrationKeyNote hash includes the owner. The `#[note]` macro uses `Packable::pack(self)`, which flattens the `mpk` (`EmbeddedCurvePoint`) into its three component fields:

```
note_hash = poseidon2_hash_with_separator([mpk.x, mpk.y, mpk.is_infinite, owner, storage_slot, randomness], DOM_SEP__NOTE_HASH)
siloed = compute_siloed_note_hash(old_key_registry_address, note_hash)
unique = compute_unique_note_hash(nonce, siloed)
```

The preimage has 6 elements. The `mpk` point is packed as three separate field elements (`x`, `y`, `is_infinite`), not pre-hashed to a single field.

**Why include owner in the hash:** Without owner binding, any party who knows the note preimage (e.g., from observing note delivery messages) could claim any user's state by providing that user's key registration note hash. Including the owner means the migration circuit proves that *this specific address* registered *this specific mpk*. Since the app note is also bound to an owner, the two are linked through the shared `notes_owner` parameter used in both hash computations.

`MigrationKeyNote` uses the standard `#[note]` macro, which auto-generates `compute_note_hash` with owner binding.

## Nullifier Non-Inclusion (Low-Leaf Indexed Tree Pattern)

To prove a note has NOT been nullified, Mode B uses the nullifier tree's indexed structure. The nullifier tree is a sorted indexed Merkle tree where each leaf contains `(nullifier, next_nullifier, next_index)`.

The proof works as follows:

1. **Low-leaf identification.** Find the leaf whose `nullifier < target` and `next_nullifier > target` (or `next_index == 0` for the maximum element).
2. **Low-leaf membership.** Prove the low leaf is in the nullifier tree via `root_from_sibling_path(poseidon2_hash([value, next_value, next_index]), leaf_index, sibling_path)`.
3. **Bounds check.** Assert `low_value < target_nullifier` and `(next_value > target_nullifier || next_index == 0)`.

If these conditions hold, the target nullifier cannot exist in the tree -- there is no position where it could be inserted while maintaining the sorted invariant, which proves the note was not spent.


## Authentication Model

### Address Verification

The circuit computes both `inner_nullifier` and `siloed_nullifier` in-circuit from `nhk_app` (derived from the user's nullifier hiding key `nhk`). Address verification proves `nhk` matches the note owner by:

1. Deriving `npk_m` from `nhk` via EC scalar multiplication (`fixed_base_scalar_mul`).
2. Replacing `npk_m` in the provided `public_keys` with the derived value.
3. Computing `AztecAddress::compute(public_keys, partial_address)` and asserting it equals `notes_owner`.

Only the true owner of the nullifier hiding key can migrate their notes.

### Mode B Signature Details

Mode B uses two domain separators depending on what is being migrated:

**Private note migration** (`DOM_SEP__CLAIM_B`):

```
notes_hash = poseidon2_hash([note_hash_1, ..., note_hash_N])
msg = poseidon2_hash([DOM_SEP__CLAIM_B, old_rollup, current_rollup, notes_hash, recipient, new_app])
```

**Owned public state migration** (`DOM_SEP__CLAIM_B_PUBLIC`):

```
public_state_hash = poseidon2_hash(pack(data))
msg = poseidon2_hash([DOM_SEP__CLAIM_B_PUBLIC, old_rollup, current_rollup, public_state_hash, recipient, new_app])
```

The `mpk` is obtained from the `MigrationKeyNote` proven in the same circuit. `msk` stays entirely off-chain -- only used for signing.

For shared Schnorr signature mechanics and key derivation, see [General Specification -- Authentication](migration-spec.md#authentication).

## Migration Nullifier (Double-Claim Prevention)

### Private Notes

Each Mode B private note migration emits a nullifier:

```
migration_nullifier = poseidon2_hash_with_separator([unique_note_hash, randomness], DOM_SEP__NOTE_NULLIFIER)
```

This is pushed in the private function via `context.push_nullifier()`. Because nullifiers are globally unique and the new rollup's kernel enforces non-duplication, the same note cannot be migrated twice. The nullifier uses `randomness` (not the user's secret key) to preserve privacy -- observers cannot link old/new rollup identities by predicting the nullifier.

### Public State

For public state migration, a deterministic nullifier is used:

```
nullifier = poseidon2_hash_with_separator([old_app.to_field(), base_storage_slot], DOM_SEP__PUBLIC_MIGRATION_NULLIFIER)
```

Since public state has no randomness, the nullifier is derived from the old app contract address and the base storage slot. One nullifier is emitted per `PublicStateProofData` (per storage struct), covering all consecutive field slots S through S+N-1. The `base_storage_slot` uniquely identifies the struct, so a per-field nullifier is not needed.

For all nullifier formulas in one place, see [General Specification -- Migration Nullifiers](migration-spec.md#migration-nullifiers).

## Snapshot Height

Mode B migrates app state based on a particular finalized block height from the old rollup. All proofs are anchored at this height. This differs from Mode A, which allows proofs against any registered archive root.

**Why a fixed snapshot:** In an emergency, all users should prove against the same state. A moving target would allow race conditions where notes are spent between proof generation and verification.

In the PoC implementation, the snapshot height is selected globally for all apps by a distinguished account on the new rollup. This is completely flexible and can be easily changed to a version where each app chooses its own snapshot block, or where the choice is decentralized. Picking the snapshot block should be a result of social consensus among the Aztec community, and is considered a problem to be solved independently. See [General Specification -- Block Hash Verification](migration-spec.md#block-hash-verification) for more context.

The snapshot height is set once via `set_snapshot_height`, which:
1. Reads the trusted archive root for `proven_block_number`.
2. Verifies the snapshot block header is in the archive tree via Merkle proof.
3. Stores the snapshot height and block hash using `initialize()` (write-once -- subsequent calls revert).

The caller cannot set an arbitrary height -- it must correspond to a real block within a bridged archive. See the [PoC Limitations](#poc-limitations) section for production considerations.

## Public State Migration

Mode B supports migrating public storage values via Merkle proofs against the public data tree. The implementation provides composable functions at different levels of abstraction:

1. **`migrate_public_state_mode_b`** -- Base function for standalone public storage values. Verifies each packed field exists in the public data tree at the correct storage slot, emits a migration nullifier per struct, and enqueues block hash verification.

2. **`migrate_public_map_state_mode_b`** -- For map-based public storage. Derives the storage slot from `base_storage_slot` and `map_keys` via iterated `poseidon2_hash_with_separator([slot, key], DOM_SEP__PUBLIC_STORAGE_MAP_SLOT)`, then delegates to `migrate_public_state_mode_b`.

3. **`migrate_public_map_owned_state_mode_b`** -- For owned map entries. Adds Schnorr signature verification (domain `DOM_SEP__CLAIM_B_PUBLIC`) and `MigrationKeyNote` inclusion proof to authenticate the old owner.

A shared helper `derive_map_storage_slot` derives nested map slots by iterating `poseidon2_hash_with_separator([slot, key], DOM_SEP__PUBLIC_STORAGE_MAP_SLOT)` for each key.

The TS library provides `buildPublicDataProof` and `buildPublicMapDataProof` to construct the `PublicStateProofData` from the Aztec node's public data tree witnesses.

## Key Registry

### MigrationKeyRegistry Contract

The `MigrationKeyRegistry` contract (`noir/contracts/migration-key-registry/src/main.nr`) provides migration key registration on the old rollup. It uses `Owned<PrivateImmutable<MigrationKeyNote>>` for storage, where:

- The `Owned` wrapper provides per-user scoping via `.at(owner)`.
- `PrivateImmutable` with `initialize()` enforces write-once immutability. A second call to `register()` by the same user will fail because the initialization nullifier already exists.

Users register their migration public key (`mpk`) before snapshot height H by calling `register(mpk)`. The function validates the key is on the Grumpkin curve (`y^2 = x^3 - 17`) and is not the point at infinity before storing it.

### Cross-Rollup Key Note Siloing

Key note inclusion is siloed by the **old rollup's** key registry address. When verifying a `MigrationKeyNote` inclusion proof on the new rollup, the circuit needs the old key registry's address to correctly compute `compute_siloed_note_hash(old_key_registry_address, note_hash)`.

The `MigrationArchiveRegistry` on the new rollup stores this address (set at deployment via its constructor) and exposes it via `get_old_key_registry()` -- a `#[external("private")]` function callable from private context for cross-rollup siloing. The `KeyNoteProofData.verify_key_note_inclusion()` method internally reads this address from the archive registry.

### View Function

`MigrationKeyRegistry.get(owner)` is an unconstrained view function that returns the registered `mpk` for an owner. If no key is registered, it returns `Point::point_at_infinity()` as a sentinel value.

## Wallet Integration

A migration webapp will orchestrate the end-to-end Mode B flow. The wallet's role is to expose key management, signing, and key registration primitives. Mode B extends the Mode A wallet requirements (see [Mode A -- Wallet Integration](mode-a-spec.md#wallet-integration)) with the following additional responsibilities:

- **Key registration.** Before the snapshot height H, the wallet must support calling `keyRegistry.register(mpk)` on the old rollup's `MigrationKeyRegistry`. This is a one-time, write-once operation. If a user misses this window, Mode B migration is permanently unavailable for that account. Wallets should prompt registration early and confirm inclusion in a block before H.
- **Nullifier hiding key access.** Mode B requires the wallet to expose the nullifier hiding key (NHK) for address verification. The `MigrationAccount` interface provides `getMaskedNhk(mask)` and `getNhkApp(contractAddress)` for this purpose.
- **Public state signing.** In addition to `signMigrationModeB()` (private notes), the wallet must support `signPublicStateMigrationModeB()` for owned public state migration, which uses a distinct domain separator (`DOM_SEP__CLAIM_B_PUBLIC`).

For key derivation, Browser vs Node environments, and key persistence, see [General Specification -- Wallet Integration](migration-spec.md#wallet-integration-shared).

## PoC Limitations

The following limitations are specific to Mode B in the current proof-of-concept. For shared limitations (no supply cap, no access control on `mint()`/`burn()`), see [General Specification -- PoC Limitations](migration-spec.md#poc-limitations).

- **Snapshot height governance has no access control** beyond write-once (`initialize()`). See [Snapshot Height](#snapshot-height) for production considerations.
- **Identical storage layout assumed** between old and new rollup contracts for public state migration. If the storage layout changes, slot indices will not match.
- **Reference app simplifications:** No `#[only_self]` on public struct init functions. Production apps must add access control.

## See Also

- [General Specification](migration-spec.md) -- Shared protocol design, authentication, nullifiers, proof data types, API
- [Mode A Specification](mode-a-spec.md) -- Cooperative lock-and-claim migration
- [Integration Guide](../integration-guide.md) -- TS SDK, wallet classes, proof data types
- [Security](../security.md) -- Trust assumptions and PoC limitations
