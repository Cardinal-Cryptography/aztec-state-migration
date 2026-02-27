---
layout: default
title: General Migration Specification
---

[← Home](../index.md)



# Problem Statement

The problem we are trying to solve is the one stated in [Request for Grant Proposals: Application State Migration](https://forum.aztec.network/t/request-for-grant-proposals-application-state-migration/8298). Roughly speaking, in the initial phase of Aztec Network, there might be need to upgrade the rollup in a way which does not copy the old state to the upgraded rollup. In other words, the upgraded rollup is essentially a fresh chain with only critical data migrated from the existing one. In particular no app data (contract storage) is moved. The reason for this is explained in the above linked forum, but one of the problems is user addresses. Because of how aztec addresses are technically designed, on a new rollup keeping the same address by the same user might not be possible. For this reasons copying state, like `AztecAddress -> u128` mappings wouldn't make much sense, because on the new rollup the old addresses would not be valid anymore. 

Now the question becomes: if addresses are not preserved, how can users migrate state from the old rollup to new, while preserving safety and privacy. This is what this project is about.

# General Migration Specification

In this project we designed two general ways to solve the above stated problem. We call them `Mode A` and `Mode B`. This document covers shared protocol concepts, architecture, and API used by both migration modes. For mode-specific details, see:

- [Mode A Specification](mode-a-spec.md) -- Cooperative lock-and-claim migration
- [Mode B Specification](mode-b-spec.md) -- Emergency snapshot migration

The app developers can choose whether they implement just mode A, or just mode B, or both. Also:
- For mode B the app developers don't really need to prepare for the possibility of a migration. Only when the rollup upgrade happens, they need to deploy an appropriately prepared version of their contract on the new rollup.
- For mode A, as long as the contract is upgradeable, the app developers also don't need to prepare. Only if the app contract is immutable, then the developer has to deploy the contract with mode A migration in mind.

## Scope

- **Mode A:** public + private balances (lock then claim)
- **Mode B:** private balances + public state at snapshot height H

**Out of Scope:** L1-bridged assets require L1 portal contract modifications and are not covered by this specification. See [Non-Native Assets](../non-native-assets.md) for constraints and approaches.


## Goals & Non-Goals

**Goals:** Trustless migration, routine (Mode A) and emergency snapshot (Mode B), privacy preservation (recipient privacy), double-claim prevention, recipient flexibility.

**Non-Goals:** automatic migration, key recovery, out-of-the-box non-native assets migration.

## Key Design Decisions


1. **Trusted anchors** are archive roots relayed from L1 via a portal to a shared **MigrationArchiveRegistry** contract on new (target) Aztec rollup, which verifies and stores block hashes (not raw archive roots). Migrating apps read verified block hashes from this single instance.
2. **Migration identity uses a separate keypair**, stored by the user (preferably in the wallet). The keypair is either committed in a registry contract (Mode B) or carried inside the lock note (Mode A). This spec does not assume migration keys are known at account creation, as that would require a protocol-level change to account deployment. Hence Mode B relies on an explicit MigrationKeyRegistry. Future account versions may embed migration keys in the salt preimage or a dedicated field (see Future work).

## Architecture

```
Old Rollup L2          L1                     New Rollup L2
┌────────────┐      ┌──────────────┐      ┌──────────────────────────┐
│   AppV1    │      │ Migrator (L1)│─────▶│ MigrationArchiveRegistry │
│  lock_*()  │      │  relays      │ inbox│                          │
└────────────┘      │ archive_root │      │   stores block hashes    │
┌─────────────┐     └──────────────┘      └──────────┬───────────────┘
│ MigrationKey│                                       │ reads
│  Registry   │                              ┌────────▼────────┐
│  (Mode B)   │                              │     AppV2       │
└─────────────┘                              │  migrate_*()    │
                                             └─────────────────┘

```

> **Note on generality.** The migration mechanism is fully general and can be adapted to almost any state that is native to the L2 -- token balances, NFT ownership, public storage structs, maps, etc. For concreteness, the spec often uses a token contract as the running example (AppV1/AppV2), but the same flows apply to any migrating application contract.

## L1 Portal + MigrationArchiveRegistry

A **portal** (the `Migrator` contract on L1) is an L1 contract that sends messages to Aztec L2 via the Inbox/Outbox system. It reads the old rollup's proven archive root from the old rollup's L1 contracts and sends an L1→L2 Inbox message addressed to the `MigrationArchiveRegistry`. It is permissionless -- anyone can trigger the bridge action.

The `Migrator` contract provides two bridge functions:

- **`migrateArchiveRoot(oldVersion, l2Migrator)`** -- bridges the latest proven archive root for the specified old rollup version.
- **`migrateArchiveRootAtBlock(oldVersion, blockNumber, l2Migrator)`** -- bridges the archive root at a specific historical block height, allowing migration against older proven state.

Both functions read the archive root from the old rollup's L1 contracts, compute a Poseidon2 hash, and send an L1→L2 message.

The portal message content is:

```
poseidon2_hash([old_rollup_version, archive_root, proven_block_number])
```

**MigrationArchiveRegistry** is a singleton contract on the new rollup, shared by all migrating apps -- each app reads verified block hashes from this single instance rather than managing its own. Block registration is a two-step process:

1. **`consume_l1_to_l2_message(archive_root, proven_block_number, secret, leaf_index)`** -- consumes the L1→L2 Inbox message and stores the trusted `archive_root` keyed by `proven_block_number`.

2. **`register_block(proven_block_number, block_header, archive_sibling_path)`** -- reads the stored `archive_root`, computes `block_hash = hash(block_header)`, verifies `root_from_sibling_path(block_hash, block_number, archive_sibling_path) == archive_root`, and stores the verified `block_hash` keyed by `block_number`.

A convenience function `consume_l1_to_l2_message_and_register_block` combines both steps in a single call.

**Inbox message consumption** requires a `secret` because L1 messages commit to a `secretHash`, and L2 consumption reveals the preimage. For permissionless root syncing, the portal uses a public/deterministic secret (just `0`). Reusing the same secret across many messages is safe because the message leaf index is part of consumption.

**Storage:** MigrationArchiveRegistry stores `block_number → block_hash` for all registered blocks, and for Mode B, a write-once `snapshot_block_hash`. Any migrating app can call `verify_migration_mode_a(block_number, block_hash)` or `verify_migration_mode_b(block_hash)` to check a block hash against the stored value.

**Snapshot Block in Mode B** In Mode B the app is migrated based on a particular finalized block height from the old rollup. In the PoC implementation this block_height is selected globally for all the apps by a distinguished account on the new rollup. This is completely flexible and can be easily changed to a version where:
- Each app chooses its own snapshot block.
- The choice of the snapshot block is decentralized.

Picking the snapshot block should be a result of social consensus among the Aztec community, and thus is considered a problem to be solved independently.

## Identity & Migration Key Registry

### Overview

Migration claims must be authorized in a way that does **not** depend on successful execution of the user's old account contract (because the old rollup may be upgraded due to bugs). This spec uses a dedicated **migration keypair**:

- **`msk`**: migration secret key (kept private in the wallet)
- **`mpk`**: migration public key (a point on the **Grumpkin curve**, an elliptic curve used in Aztec-friendly cryptography)

The migration keypair is used **only** to authorize migration claims. It is not used as an Aztec account transaction signing key.

**Security comparison with other Aztec keys:**
- **Signing key leak:** attacker can spend your funds on the current rollup (assuming they also have the nullifier key),
- **Nullifier key leak:** attacker can link your transactions (privacy loss), but cannot spend (unless they also have the signing key),
- **Viewing key leak:** attacker can see your balances (privacy loss), but cannot spend (unless they also have the signing key)
- **Migration key leak:** An attacker can claim your tokens on the new rollup during migration, resulting in fund loss scoped to the migration window. In Mode A, this is exploitable unconditionally. In Mode B, it is only exploitable if the attacker also knows the `nhk`.

### Where `mpk` comes from

Mode A and Mode B use different sources for the migration public key.

#### Mode A: `mpk` is carried in the lock note

In Mode A the user creates a `MigrationNote` on the old rollup. The note preimage includes the full `mpk` (Grumpkin point), so the migration circuit can verify the signature directly against the `mpk` embedded in the proven note.

Mode A does not require a separate identity registry. See [Mode A Specification](mode-a-spec.md) for the full lock-and-claim flow.

#### Mode B: `mpk` must be committed before snapshot height H

In Mode B, the migration circuit must learn the correct `mpk` for the owner of the original note **as of snapshot height H**, in a way that is provable against the old rollup's note hash tree at height H.

Mode B uses a shared **MigrationKeyRegistry** contract on the old rollup:

- Users call `register(mpk)` which creates a `MigrationKeyNote` containing the full `mpk` point, bound to the caller's address.
- The note is stored in the old rollup's **note hash tree**, provable via Merkle inclusion proof at any block height.


**Key note verification (new rollup claim):**

- The claimant provides a `KeyNoteProofData` containing the `MigrationKeyNote` preimage, nonce, and sibling path.
- The migration circuit verifies inclusion of the key note in the note hash tree at snapshot height H.
- The circuit checks that the key note's owner matches the claimed note owner.
- The Schnorr signature is verified against the `mpk` from the key note.

**Important constraint:** if a user did not register their `mpk` before snapshot height H, they cannot claim in Mode B. See [Mode B Specification](mode-b-spec.md) for key registry details and snapshot timing.

Luckily registration is required to be done just once per user, not once per every app.

### Mode B ownership binding for private notes

Even for private notes, Mode B must bind a claim to the rightful owner. Otherwise, anyone who learns a note's preimage (for example a sender, a compromised device, or any system that had access to the plaintext note) could claim it on the new rollup.

Mode B therefore requires:

- The user's nullifier hiding key `nhk` as a witness -- from which `npk_m` is derived via EC scalar multiplication and the owner address is recomputed from the full public key set and partial address.
- A proof that the owner's `MigrationKeyNote` (containing `mpk`) exists in the note hash tree at height H.
- A valid Schnorr signature generated using the `msk` key.

This makes "knowledge of the migration secret key + nullifier hiding key" the authorization condition for claiming private notes.

### Mode B public state migration

For public state (non-owned), no signature or key note proof is needed -- the data is publicly visible and anyone can trigger the migration. The circuit only verifies the data existed in the public data tree at snapshot height H.

For **owned** public state, the same Schnorr signature and key note proof are required, using a separate domain tag (`DOM_SEP__CLAIM_B_PUBLIC`). The signature binds the data hash (instead of note hashes) to the migration context.


### Future work: protocol-level identity commitments

The [forum post](https://forum.aztec.network/t/request-for-grant-proposals-application-state-migration/8298/2?u=adamgagol) discusses several approaches to embed migration keys at the protocol level:

- Salt-based commitment: New accounts deploy with salt = `h(actual_salt, h(mpk, root))`, embedding the
  migration key in address derivation. No registry transaction needed.
- Protocol-level field: A dedicated `mpk` field in account data or address preimage.

A hybrid claim circuit could accept either salt preimage proofs (new accounts) or registry proofs (existing accounts).

An external registry works for all existing accounts without protocol changes and remains compatible with future approaches.

## Authentication

Migration claims are authenticated via Schnorr signatures over a Poseidon2 message hash. The signature binds the claim to a specific recipient and app contract, preventing front-running.

### Schnorr Signature Mechanics

For each claim, the claimant provides a Schnorr signature over a domain-separated message:

```
data_hash = poseidon2_hash([hash_1, ..., hash_N])
msg = poseidon2_hash([CLAIM_DOMAIN, old_rollup, current_rollup, data_hash, recipient, new_app_address])
sig = schnorr_sign(msk, msg)
```

- `data_hash` is the Poseidon2 hash of all note hashes (or public state fields) being claimed in the batch.
- `CLAIM_DOMAIN` provides **domain separation** -- each mode uses a distinct domain tag (`DOM_SEP__CLAIM_A`, `DOM_SEP__CLAIM_B`) to prevent signatures from being reused across modes.
- `recipient` is the new-rollup address that will receive the migrated tokens.

On claim, the migration circuit:

1. Reconstructs the message from the migration context (old/new rollup versions, `data_hash`, `msg_sender`, `this_address`).
2. Verifies the Schnorr signature under `mpk` (the full Grumpkin point).

This binds the claim to the chosen recipient and app contract, preventing front-running and third-party redirection.

**Verification** (`signature.nr`, function `verify_migration_signature`):

```
schnorr::verify_signature(mpk, signature.bytes, msg.to_be_bytes::<32>())
```

For mode-specific domain separators and message fields, see [Mode A Specification -- Authentication](mode-a-spec.md#authentication) and [Mode B Specification -- Authentication](mode-b-spec.md#authentication-model).

### Key Derivation

The migration secret key (MSK) is derived deterministically from the account's secret key:

```
msk = sha512ToGrumpkinScalar([secretKey, DOM_SEP__MSK_M_GEN])
```

The migration public key (MPK) is the corresponding Grumpkin curve point. No random generation or explicit persistence is needed -- the key can be re-derived from the account secret at any time. The MSK stays entirely off-chain -- it is used only for deriving `mpk` and signing. The circuit receives `mpk` directly.

(`ts/aztec-state-migration/keys.ts`, export `deriveMasterMigrationSecretKey`)

## Block Hash Verification

Block hash trust is established in two steps, both on the `MigrationArchiveRegistry`:

1. **`register_block`:** Verifies a block header against a consumed L1-bridged archive root via Merkle proof. Stores the mapping `block_number -> block_hash`.
2. **Mode-specific verification:** Mode A calls `verify_migration_mode_a(block_number, block_hash)` to check against any registered block hash. Mode B calls `verify_migration_mode_b(block_hash)` to check against the snapshot block hash.

This separation allows block registration to happen once per block, with multiple migration claims referencing the same registered block.

### Block Header Binding

The private migration function receives a `BlockHeader` and computes `block_header.hash()`. This hash is then passed to a private function that checks it against the stored block hash.

The L1 Migrator contract reads the old rollup's `provenCheckpointNumber` and sends it to the new rollup via the inbox.

## Migration Nullifiers

```
Mode A (private notes):  poseidon2_hash_with_separator([note_hash, randomness], DOM_SEP__NOTE_NULLIFIER)
Mode B (private notes):  poseidon2_hash_with_separator([unique_note_hash, randomness], DOM_SEP__NOTE_NULLIFIER)
Mode B (public state):   poseidon2_hash_with_separator([old_app.to_field(), base_storage_slot], DOM_SEP__PUBLIC_MIGRATION_NULLIFIER)
```

Mode A uses the MigrationNote's own randomness (not the user's secret key) to preserve privacy -- observers cannot link old/new rollup identities by predicting the nullifier.

Mode B private notes use the unique note hash and randomness for the same reason.

Mode B public state uses a deterministic nullifier derived from the old app contract address and the base storage slot. One nullifier is emitted per `PublicStateProofData` (per storage struct), covering all consecutive field slots.

## Batching Multiple Notes

Both Mode A and Mode B circuits accept arrays of note proof data (`[MigrationNoteProofData; N]` and `[FullNoteProofData; N]` respectively) and loop over all N notes in a single proof. Apps choose N based on their needs; the library circuits support arbitrary batch sizes.

For Mode A, `lock_migration_notes` already creates one `MigrationNote` per element in the input array, and emits a `MigrationDataEvent` for each.

## Data Structures & Hashing

Claims prove inclusion over the **exact note-tree leaf hash** inserted into the note hash tree. In Aztec, the application computes a note hash from note content and a logical "slot". The kernel then siloes it by contract address and makes it unique by hashing in a `note_nonce`. The result is the value inserted into the note hash tree.

**MigrationNote (Mode A lock note):**

```
note_hash = poseidon2_hash_with_separator([note_creator, mpk.x, mpk.y, destination_rollup, migration_data_hash, storage_slot, randomness], DOM_SEP__NOTE_HASH)
siloed    = compute_siloed_note_hash(old_rollup_app_address, note_hash)
unique    = compute_unique_note_hash(nonce, siloed)
```

**OriginalNote (Mode B):**

Membership proof is over the unique note hash inserted into the old-rollup app contract's (AppV1) storage slot. The circuit recomputes the full hash chain from the note preimage.

## Proof Data Types

The migration system uses a three-tier composition (Library, Application, and Client SDK): the Noir `aztec_state_migration` library provides core verification logic, app contracts wrap library functions with app-specific state handling, and a client SDK provides proof building and transaction construction. The proof data types below are defined in the Noir library and have corresponding representations in the client SDK.

### `NoteProofData<T>`

Defined in `note_proof_data.nr`. Contains the data needed to prove a note's inclusion in the note hash tree.

| Field | Type | Description |
|-------|------|-------------|
| `data` | `T` | The note preimage (generic) |
| `randomness` | `Field` | Note randomness |
| `nonce` | `Field` | Note nonce for unique hash computation |
| `leaf_index` | `Field` | Leaf index in note hash tree |
| `sibling_path` | `[Field; NOTE_HASH_TREE_HEIGHT]` | Merkle sibling path |

### `MigrationNoteProofData<MigrationData>`

Type alias defined in `mode_a/mod.nr`. This is NOT a separate struct -- it is a type alias:

```
pub type MigrationNoteProofData<MigrationData> = NoteProofData<MigrationData>;
```

Parameterizes `NoteProofData` with migration-specific data for Mode A claims.

### `FullNoteProofData<Note>`

Defined in `mode_b/mod.nr`. Combines note inclusion with non-nullification proof for Mode B claims.

| Field | Type | Description |
|-------|------|-------------|
| `note_proof_data` | `NoteProofData<Note>` | Note inclusion proof |
| `non_nullification_proof_data` | `NonNullificationProofData` | Non-nullification proof |

### `NonNullificationProofData`

Defined in `mode_b/non_nullification_proof_data.nr`. Proves a nullifier does NOT exist in the nullifier tree (non-membership).

| Field | Type | Description |
|-------|------|-------------|
| `low_nullifier_value` | `Field` | Value of the low nullifier leaf |
| `low_nullifier_next_value` | `Field` | Next value pointer of the low nullifier leaf |
| `low_nullifier_next_index` | `Field` | Next index pointer of the low nullifier leaf |
| `low_nullifier_leaf_index` | `Field` | Leaf index of the low nullifier in the tree |
| `low_nullifier_sibling_path` | `[Field; NULLIFIER_TREE_HEIGHT]` | Merkle sibling path for the low nullifier |

### `PublicStateSlotProofData`

Defined in `mode_b/public_state_proof_data.nr`. Inclusion proof for a single slot in the public data tree.

| Field | Type | Description |
|-------|------|-------------|
| `next_slot` | `Field` | Next slot in the indexed tree |
| `next_index` | `Field` | Next index in the indexed tree |
| `leaf_index` | `Field` | Leaf index in the public data tree |
| `sibling_path` | `[Field; PUBLIC_DATA_TREE_HEIGHT]` | Merkle sibling path |

### `PublicStateProofData<T, N>`

Defined in `mode_b/public_state_proof_data.nr`. Contains the public state value and one proof per packed field.

| Field | Type | Description |
|-------|------|-------------|
| `data` | `T` | The public state value |
| `slot_proof_data` | `[PublicStateSlotProofData; N]` | One proof per packed field (slots S through S+N-1) |

### `KeyNoteProofData`

Type alias for `NoteProofData<MigrationKeyNote>`. Inclusion proof for a `MigrationKeyNote` in the old rollup's note hash tree.

### `MigrationNote`

Defined in `mode_a/migration_note.nr`. Created by `lock_migration_notes`, consumed by `migrate_notes_mode_a`.

| Field | Type | Description |
|-------|------|-------------|
| `note_creator` | `AztecAddress` | Address of the note creator |
| `mpk` | `Point` | Migration public key (Grumpkin point) |
| `destination_rollup` | `Field` | Target rollup version identifier |
| `migration_data_hash` | `Field` | Poseidon2 hash of packed original data |

### `MigrationKeyNote`

Defined in `migration-key-registry/migration_key_note.nr`. Used by `MigrationKeyRegistry` to store the migration public key.

| Field | Type | Description |
|-------|------|-------------|
| `mpk` | `Point` | Migration public key (Grumpkin point) |

### `MigrationSignature`

Defined in `signature.nr`. Accepted by all `migrate_*` functions.

| Field | Type | Description |
|-------|------|-------------|
| `bytes` | `[u8; 64]` | Schnorr signature bytes |

## Migration Modes

| Mode | Scenario | Flow | Scope |
| --- | --- | --- | --- |
| A | Routine | lock then claim | Public + private |
| B | Emergency | claim at snapshot H | Private + public state |

**Mode B semantics:** claims reflect state at height H; post-H activity is intentionally ignored.

## Supply Control (optional cap)

AppV2 may enforce a `mintable_supply` cap set at activation (turnstile). This is most relevant for token contracts, but the pattern applies to any app that tracks a bounded quantity.

- **Recommended:** enable the cap in both modes, but only if AppV1 supply is frozen (mint/burn disabled) before activation and `mintable_supply` is set to the known total supply. If supply is not frozen, an incorrect cap can block valid claims, so it is advised to either set the cap with some leeway (depending on whether app developers decide to honor tokens minted after migration has started), or update the cap.
- Mode B may set `mintable_supply` to a safe cap (for example total supply as of H).

If implemented via a public `_decrement_supply(amount)`, amounts become public.

## Proof Requirements

All claims provide:

- an old rollup block header `header` with roots for the relevant trees,
- the circuit computes `header.hash()` and enqueues a public call to MigrationArchiveRegistry to verify it matches a stored block hash (Mode A checks `block_hashes[block_number]`, Mode B checks `snapshot_block_hash`), and
- membership / non-membership proofs against roots inside `header`.

**Mode A `migrate_notes_mode_a` proves:**

1. Each `MigrationNote.leaf_hash` exists in the note tree (inclusion proof against `header.state.partial.note_hash_tree.root`).
2. `destination_rollup` in the note preimage matches the current rollup version.
3. Schnorr signature verifies for `mpk` embedded in the MigrationNote.
4. Block hash verification is enqueued to MigrationArchiveRegistry (`verify_migration_mode_a(block_number, block_hash)`).

**Mode B `migrate_notes_mode_b` proves (private notes):**

1. Address verification: `nhk` -> `npk_m` via EC scalar mul, verify `AztecAddress::compute(public_keys, partial_address) == notes_owner`.
2. Each note's `leaf_hash` exists under `header_H.state.partial.note_hash_tree.root`.
3. Each note is not nullified at H (non-membership against `header_H.state.partial.nullifier_tree.root`) using constrained nullifier derivation from `nhk_app`.
4. `MigrationKeyNote` for the owner exists in the note hash tree at H.
5. Schnorr signature verifies for `mpk` from the key note.
6. Block hash verification is enqueued to MigrationArchiveRegistry (`verify_migration_mode_b(block_hash)`).

**Mode B public state migration proves:**

1. Each field of the struct existed in the public data tree at the derived storage slot (Merkle inclusion against `header_H.state.partial.public_data_tree.root`).
2. For owned state: Schnorr signature and key note inclusion (same as private notes).
3. Block hash verification is enqueued to MigrationArchiveRegistry.

## API

The migration API is organized in three layers:

1. **Migration Library** (`aztec_state_migration`): Core Noir functions that implement proof verification, nullifier emission, signature checking, and block hash verification. These are generic and reusable across any migrating application.
2. **App Contracts**: Wrappers that call library functions and handle app-specific state such as minting, balance updates, and access control.
3. **TypeScript Client** (`aztec-state-migration`): Client-side proof building, key derivation, and transaction construction.

The tables below list library functions first, then app-level interfaces.

### Migration Library Functions

| Function | Module | Key Params | Description |
|----------|--------|-----------|-------------|
| `lock_migration_notes` | `mode_a/ops` | `migration_data: [T; N], ...` | Create MigrationNotes and emit encrypted MigrationDataEvents |
| `migrate_notes_mode_a` | `mode_a/ops` | `note_proof_data: [MigrationNoteProofData; N], block_header, signature, mpk, migration_archive_registry, recipient, old_app` | Verify Mode A inclusion proofs, check Schnorr signature, emit nullifiers, enqueue block verification |
| `migrate_notes_mode_b` | `mode_b/ops` | `full_proof_data: [FullNoteProofData; N], block_header, signature, key_note, nhk, migration_archive_registry, old_app, ...` | Verify Mode B inclusion + non-nullification proofs, check Schnorr signature, verify key note |
| `migrate_public_state_mode_b` | `mode_b/ops` | `proof: PublicStateProofData, block_header, base_storage_slot, migration_archive_registry, old_app` | Verify public data tree inclusion at snapshot height, emit nullifiers |
| `migrate_public_map_state_mode_b` | `mode_b/ops` | `proof: PublicStateProofData, block_header, base_storage_slot, map_keys, migration_archive_registry, old_app` | Derive map storage slot via `poseidon2_hash_with_separator([slot, key], DOM_SEP__PUBLIC_STORAGE_MAP_SLOT)`, delegate to `migrate_public_state_mode_b` |
| `migrate_public_map_owned_state_mode_b` | `mode_b/ops` | `proof: PublicStateProofData, block_header, base_storage_slot, map_keys, signature, key_note, old_owner, recipient, migration_archive_registry, old_app` | Owned map migration with Schnorr auth |

> **Note:** Mode B library functions accept an `expected_storage_slot` parameter to bind the proof to a specific storage location, preventing slot substitution attacks.

### Shared Contract Interfaces

#### MigrationKeyRegistry (Old Rollup, Mode B only)

| Function | Params | Description |
| --- | --- | --- |
| `register` | `mpk: Point` | Register migration public key (creates MigrationKeyNote) |
| `get` | `owner: AztecAddress` | View registered mpk for an owner (unconstrained); returns `point_at_infinity` if no key registered |

#### MigrationArchiveRegistry (New Rollup, shared)

| Function | Params | Description |
| --- | --- | --- |
| `consume_l1_to_l2_message` | `archive_root, proven_block_number, secret, leaf_index` | Consume L1->L2 message, store trusted archive root |
| `register_block` | `proven_block_number, block_header, archive_sibling_path` | Verify block header against stored archive root, store block hash |
| `consume_l1_to_l2_message_and_register_block` | `archive_root, proven_block_number, secret, leaf_index, block_header, archive_sibling_path` | Convenience: consume message and register block in a single call |
| `set_snapshot_height` | `height, snapshot_block_header, proven_block_number, archive_sibling_path` | Set Mode B snapshot height (write-once) |
| `verify_migration_mode_a` | `block_number, block_hash` | Assert block hash matches stored value |
| `verify_migration_mode_b` | `block_hash` | Assert block hash matches snapshot block hash |
| `get_block_hash` | `block_number` | View: return stored block hash for a given block number |
| `get_snapshot_height` | -- | View: return the Mode B snapshot height |
| `get_snapshot_block_hash` | -- | View: return the Mode B snapshot block hash |
| `get_latest_proven_block` | -- | View: return the latest proven block number |
| `get_old_key_registry` | -- | Return old rollup's key registry address (`#[external("private")]` -- callable from private context for cross-rollup siloing) |

**Constructor:** `l1_migrator: EthAddress`, `old_rollup_version: Field`, `old_key_registry: AztecAddress`

#### Migrator (L1)

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `migrateArchiveRoot` | `uint256 oldVersion, DataStructures.L2Actor calldata l2Migrator` | `bytes32 leaf, uint256 leafIndex` | Bridge latest proven archive root to new rollup via L1->L2 message |
| `migrateArchiveRootAtBlock` | `uint256 oldVersion, uint256 blockNumber, DataStructures.L2Actor calldata l2Migrator` | `bytes32 leaf, uint256 leafIndex` | Bridge archive root at a specific historical block height |
| `getArchiveInfo` | `uint256 version` | `bytes32 archiveRoot, uint256 provenCheckpointNumber` | View: archive root and proven checkpoint number for the given version |

| Event | Params | Description |
|-------|--------|-------------|
| `ArchiveRootMigrated` | `uint256 indexed oldVersion, uint256 indexed newVersion, bytes32 indexed l2Migrator, bytes32 archiveRoot, uint256 provenBlockNumber, bytes32 messageLeaf, uint256 messageLeafIndex` | Emitted on successful bridge (3 indexed, 4 non-indexed params) |

> **Note on naming:** The Solidity event uses `provenBlockNumber` while `getArchiveInfo` returns `provenCheckpointNumber`. The Noir/spec convention uses `proven_block_number`. These refer to the same value.

## PublicImmutable for Cross-Context Configuration

Storage fields like `old_rollup_app_address` (in migrating app contracts), `old_key_registry`, and `old_rollup_version` (in `MigrationArchiveRegistry`) use `PublicImmutable` rather than constants or private state because:

- They need to be set at deployment time (not known at compile time)
- They need to be readable in both private and public contexts
- In Aztec V4, `PublicImmutable` supports direct `.read()` calls in private contexts, reading from historical public storage at the anchor block -- it does NOT use notes, despite the private context

Private migration functions can read deployment configuration without note management overhead.

## Wallet Integration (Shared)

### Key Management

The wallet derives a dedicated migration secret key (MSK) and migration public key (MPK) via `deriveMasterMigrationSecretKey(secretKey)`. The MSK is derived deterministically from the account's secret key, so no additional key storage is needed. The MPK is passed to migration transactions. The MSK stays entirely off-chain and is used only for signing claim messages.

### Browser vs Node Environments

The migration library provides two wallet entrypoints:

- **`NodeMigrationEmbeddedWallet`** -- Uses LMDB for persistent storage and bundles all account contract providers eagerly. Suitable for server-side processes, CLI tools, and test environments.
- **`BrowserMigrationEmbeddedWallet`** -- Uses IndexedDB for persistent storage and lazy-loads account contract providers via dynamic imports (enabling code splitting in bundlers). Suitable for web applications.

Both entrypoints accept `nodeOrUrl: string | AztecNode` and namespace their storage directories by rollup address, so multiple rollup connections do not conflict. Key derivation uses the same `deriveMasterMigrationSecretKey(secretKey)` path in both environments -- there is no WebCrypto or HSM integration yet.

For the old-rollup wallet instance in Mode B, browser wallets may use the ephemeral storage option (`openTmpStore`) if the old rollup's PXE data does not need to persist beyond the migration session.

### Key Persistence

`MigrationAccountWithSecretKey` stores the account secret key in memory. `MigrationEmbeddedWallet` persists account metadata (secret key, salt, signing key, account type) to its backing store via `WalletDB` -- IndexedDB in the browser, LMDB in Node. The migration secret key (MSK) is derived deterministically from the account secret key via `sha512ToGrumpkinScalar([secretKey, DOM_SEP__MSK_M_GEN])` and can be re-derived at any time, so it does not require separate persistence.

Production wallets should protect the account secret key (the MSK derivation source) via hardware-backed storage, encrypted keystores, or similar mechanisms. The current `MigrationAccountWithSecretKey` implementation is designed for testing and development.

For mode-specific wallet responsibilities, see [Mode A Specification -- Wallet Integration](mode-a-spec.md#wallet-integration) and [Mode B Specification -- Wallet Integration](mode-b-spec.md#wallet-integration).

## PoC Limitations

The following limitations apply to the current proof-of-concept implementation and are **not suitable for production**:

1. **No supply cap enforcement.** The PoC app contract mints freely on each successful migration. A production deployment should enforce a `mintable_supply` cap set at deployment.
2. **No access control on `mint()` / `burn()`.** The PoC app contract has no access control on `mint()` and `burn()` functions. A production token contract would restrict minting to authorized callers (e.g., migration-only minting).

For mode-specific limitations, see [Mode A Specification -- PoC Limitations](mode-a-spec.md#poc-limitations) and [Mode B Specification -- PoC Limitations](mode-b-spec.md#poc-limitations).

## Open Items

1. Evaluate salt-based commitment for new accounts (see Future work section).
2. Supply cap: for per-user migrated amounts, explore whether it's possible to do some simple batching.

## See Also

- [Mode A Specification](mode-a-spec.md) -- Cooperative lock-and-claim migration flow
- [Mode B Specification](mode-b-spec.md) -- Emergency snapshot migration flow
- [Architecture](../architecture.md) -- System overview, component catalog, L1-L2 bridge flow
- [Integration Guide](../integration-guide.md) -- TS SDK, wallet classes, proof data types
- [Security](../security.md) -- Trust assumptions and security considerations
