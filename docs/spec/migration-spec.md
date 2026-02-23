---
layout: default
title: Migration Specification
---

[← Home](..)

## Overview

This spec describes migration for Aztec-native tokens. Throughout the document, **TokenV1** refers to the original token contract on the old rollup, and **TokenV2** refers to its counterpart on the new rollup.

Burn-to-migrate pattern for Aztec rollup upgrades. Users lock/burn balances on old rollup (Mode A) or prove a safe snapshot (Mode B), then claim equivalent on new rollup using proofs against old rollup block hashes derived from archive roots relayed via L1.

## Scope

- **Mode A:** public + private balances (lock then claim)
- **Mode B:** private balances + public state at snapshot height H

**Out of Scope:** L1-bridged assets and any forced-exit / bridge flows.

## Goals & Non-Goals

**Goals:** Trustless migration, routine (Mode A) and emergency snapshot (Mode B), privacy preservation (recipient privacy), double-claim prevention, recipient flexibility.

**Non-Goals:** Unlocking burns, automatic migration, key recovery.

## Key Design Decisions

1. **Burns/locks are permanent.** No unlock.
2. **TokenV2 has immutable config:** `old_rollup_id`, `TokenV1_address`, `archive_registry_address` (new rollup), `dest_rollup_id` (this rollup). For Mode B, the `MigrationArchiveRegistry` also stores the `migration_key_registry_address` (old rollup).
3. **Trusted anchors** are archive roots relayed from L1 via a portal to a shared **MigrationArchiveRegistry** contract, which verifies and stores block hashes (not raw archive roots). Migrating apps read verified block hashes from this single instance.
4. **Migration identity uses a separate keypair**, stored by the user (preferably in the wallet). The keypair is either committed in a registry contract (Mode B) or carried inside the lock note (Mode A). This spec does not assume migration keys are known at account creation — coordinating such a change close to mainnet launch is risky. Hence Mode B relies on an explicit MigrationKeyRegistry. Future account versions may embed migration keys in the salt preimage or a dedicated field (see Future work).

## Architecture

```
Old Rollup L2          L1 Portal              New Rollup L2
┌────────────┐      ┌──────────────┐      ┌──────────────────────────┐
│  TokenV1   │      │  L1Migrator  │─────▶│ MigrationArchiveRegistry │
│  lock_*()  │      │  relays      │ inbox│                          │
└────────────┘      │ archive_root │      │   stores block hashes    │
┌─────────────┐     └──────────────┘      └──────────┬───────────────┘
│ MigrationKey│                                       │ reads
│  Registry   │                              ┌────────▼────────┐
│  (Mode B)   │                              │    TokenV2      │
└─────────────┘                              │  migrate_*()    │
                                             └─────────────────┘

```

## L1 Portal + MigrationArchiveRegistry

A **portal** (the `L1Migrator` contract) is an L1 contract that sends messages to Aztec L2 via the Inbox/Outbox system. It reads the old rollup's proven archive root from the old rollup's L1 contracts and sends an L1→L2 Inbox message addressed to the `MigrationArchiveRegistry`. It is permissionless — anyone can trigger the bridge action.

The portal message content is:

```
poseidon2(old_rollup_id, archive_root, proven_block_number)
```

**MigrationArchiveRegistry** is a singleton contract on the new rollup, shared by all migrating apps — each app reads verified block hashes from this single instance rather than managing its own. Block registration is a two-step process:

1. **`consume_l1_to_l2_message(archive_root, proven_block_number, secret, leaf_index)`** — consumes the L1→L2 Inbox message and stores the trusted `archive_root` keyed by `proven_block_number`.

2. **`register_block(proven_block_number, block_header, archive_sibling_path)`** — reads the stored `archive_root`, computes `block_hash = hash(block_header)`, verifies `root_from_sibling_path(block_hash, block_number, archive_sibling_path) == archive_root`, and stores the verified `block_hash` keyed by `block_number`.

A convenience function `consume_l1_to_l2_message_and_register_block` combines both steps in a single call.

**Inbox message consumption** requires a `secret` because L1 messages commit to a `secretHash`, and L2 consumption reveals the preimage. For permissionless root syncing, the portal uses a public/deterministic secret (for example `0`). Reusing the same secret across many messages is safe because the message leaf index is part of consumption.

**Storage:** MigrationArchiveRegistry stores `block_number → block_hash` for all registered blocks, and for Mode B, a write-once `snapshot_block_hash`. Any migrating app can call `verify_migration_mode_a(block_number, block_hash)` or `verify_migration_mode_b(block_hash)` to check a block hash against the stored value.

**App-level block hash policy:** Each migrating app (e.g., TokenV2) enforces its own policy on which block hashes it accepts:

- **Mode A:** accept any registered block hash.
- **Mode B:** accept only the block hash at snapshot height H (stored as `snapshot_block_hash`).

# Identity & migration key registry

### Overview

Migration claims must be authorized in a way that does **not** depend on successful execution of the user's old account contract (because the old rollup may be upgraded due to bugs). This spec uses a dedicated **migration keypair**:

- **msk**: migration secret key (kept private in the wallet)
- **mpk**: migration public key (a point on the **Grumpkin curve**, an elliptic curve used in Aztec-friendly cryptography)

The migration keypair is used **only** to authorize migration claims. It is not used as an Aztec account transaction signing key.

**Security comparison with other Aztec keys:**
- **Signing key leak:** attacker can spend your funds on the current rollup
- **Nullifier key leak:** attacker can link your transactions (privacy loss), but cannot spend
- **Viewing key leak:** attacker can see your balances (privacy loss), but cannot spend
- **Migration key leak:** attacker can claim your tokens on the new rollup during migration (fund loss, scoped to migration)

**Key derivation:** `msk` is derived deterministically from the account's secret key via `sha512ToGrumpkinScalar([secretKey, MSK_M_GEN])`. No random generation or explicit persistence needed — the key can be re-derived from the account secret at any time. `mpk` is the corresponding Grumpkin curve point.

### Claim authorization signature

For each claim, the claimant provides a **Schnorr signature** over a domain-separated message:

```
notes_hash = poseidon2([note_hash_1, ..., note_hash_N])
msg = poseidon2(CLAIM_DOMAIN, old_rollup_id, dest_rollup_id, notes_hash, recipient, TokenV2_address)
sig = schnorr_sign(msk, msg)
```

- `notes_hash` is the Poseidon2 hash of all note hashes being claimed in the batch.
- `CLAIM_DOMAIN` provides **domain separation** — each mode uses a distinct domain tag (`CLAIM_DOMAIN_A`, `CLAIM_DOMAIN_B`, `CLAIM_DOMAIN_B_PUBLIC`) to prevent signatures from being reused across modes.
- `recipient` is the new-rollup address that will receive the migrated tokens.

On claim, the migration circuit:

1. Reconstructs the message from the migration context (old/new rollup versions, notes hash, `msg_sender`, `this_address`).
2. Verifies the Schnorr signature under `mpk` (the full Grumpkin point).

This binds the claim to the chosen recipient and app contract, preventing front-running and third-party redirection.

### Where `mpk` comes from

Mode A and Mode B use different sources for the migration public key.

### Mode A: `mpk` is carried in the lock note

In Mode A the user creates a MigrationNote on the old rollup. The note preimage includes the full `mpk` (Grumpkin point), so the migration circuit can verify the signature directly against the `mpk` embedded in the proven note.

This means Mode A does not require any separate identity registry.

### Mode B: `mpk` must be committed before snapshot height H

In Mode B, the migration circuit must learn the correct `mpk` for the owner of the original note **as of snapshot height H**, in a way that is provable against the old rollup's note hash tree at height H.

Mode B uses a shared **MigrationKeyRegistry** contract on the old rollup:

- Users call `register(mpk)` which creates a `MigrationKeyNote` containing the full `mpk` point, bound to the caller's address.
- The note is stored in the old rollup's **note hash tree**, provable via Merkle inclusion proof at any block height.

**Key note verification (new rollup claim):**

- The claimant provides a `KeyNoteProofData` containing the `MigrationKeyNote` preimage, nonce, and sibling path.
- The migration circuit verifies inclusion of the key note in the note hash tree at snapshot height H.
- The circuit checks that the key note's owner matches the claimed note owner.
- The Schnorr signature is verified against the `mpk` from the key note.

**Important constraint:** if a user did not register their `mpk` before snapshot height H, they cannot claim in Mode B.

### Mode B ownership binding for private notes

Even for private notes, Mode B must bind a claim to the rightful owner. Otherwise, anyone who learns a note's preimage (for example a sender, a compromised device, or any system that had access to the plaintext note) could claim it on the new rollup.

Mode B therefore requires:

- The user's master nullifier secret key `nsk` as a witness — from which `npk_m` is derived via EC scalar multiplication and the owner address is recomputed from the full public key set and partial address.
- A proof that the owner's `MigrationKeyNote` (containing `mpk`) exists in the note hash tree at height H.
- A valid Schnorr signature under the corresponding `mpk`.

This makes "knowledge of the migration secret key + nullifier secret key" the authorization condition for claiming private notes.

### Mode B public state migration

For public state (non-owned), no signature or key note proof is needed — the data is publicly visible and anyone can trigger the migration. The circuit only verifies the data existed in the public data tree at snapshot height H.

For **owned** public state (e.g., `Map<AztecAddress, PublicMutable<T>>`), the same Schnorr signature and key note proof are required, using a separate domain tag (`CLAIM_DOMAIN_B_PUBLIC`). The signature binds the data hash (instead of note hashes) to the migration context.

### Wallet guidance

Wallets should:

- derive `msk` deterministically from the account secret key,
- encourage or automate registry registration well before any planned snapshot migration.

### Future work: protocol-level identity commitments

The [forum post](https://forum.aztec.network/t/request-for-grant-proposals-application-state-migration/8298/2?u=adamgagol) discusses several approaches to embed migration keys at the protocol level:

- Salt-based commitment: New accounts deploy with salt = h(actual_salt, h(mpk, root)), embedding the
migration key in address derivation. No registry transaction needed.
- Protocol-level field: A dedicated mpk field in account data or address preimage.

A hybrid claim circuit could accept either salt preimage proofs (new accounts) or registry proofs
(existing accounts).

This spec uses an external registry because it works for all existing accounts without protocol changes, while remaining compatible with future approaches.

## Batching multiple notes

Both Mode A and Mode B circuits accept arrays of note proof data (`[MigrationNoteProofData; N]` and `[FullNoteProofData; N]` respectively) and loop over all N notes in a single proof. The ExampleApp contract currently hardcodes `N = 1`, but the library circuits support arbitrary batch sizes.

For Mode A, `lock_migration_notes` already creates one `MigrationNote` per element in the input array, and emits a `MigrationDataEvent` for each. The TS client retrieves events filtered by `txHash` to match them to the correct lock transaction.

## Data Structures & Hashing

Claims prove inclusion over the **exact note-tree leaf hash** inserted into the note hash tree. In Aztec, the application computes a note hash that includes note content (and logically a "slot"), then the kernel siloes it by contract address and makes it unique by hashing in a `note_nonce`, producing the value inserted into the note hash tree.

**MigrationNote (Mode A lock note):**

```
note_hash = poseidon2_with_sep([note_creator, mpk.x, mpk.y, dest_rollup_id, migration_data_hash, storage_slot, randomness], DOM_SEP__NOTE_HASH)
siloed    = poseidon2_with_sep([TokenV1_address, note_hash], GENERATOR_INDEX__SILOED_NOTE_HASH)
unique    = poseidon2_with_sep([nonce, siloed], GENERATOR_INDEX__UNIQUE_NOTE_HASH)
```

**OriginalNote (Mode B):**

Membership proof is over the unique note hash inserted into TokenV1's balance slot. The circuit recomputes the full hash chain from the note preimage.

## Migration Modes

| Mode | Scenario | Flow | Scope |
| --- | --- | --- | --- |
| A | Routine | lock then claim | Public + private |
| B | Emergency | claim at snapshot H | Private + public state |

**Mode B semantics:** claims reflect state at height H; post-H activity is intentionally ignored.

## Supply Control (optional cap)

TokenV2 may enforce a `mintable_supply` cap set at activation (turnstile).

- **Recommended:** enable the cap in both modes, but only if TokenV1 supply is frozen (mint/burn disabled) before activation and `mintable_supply` is set to the known total supply. If supply is not frozen, an incorrect cap can block valid claims, so it is advised to either set the cap with some leeway (depending on whether app developers decide to honor tokens minted after migration has started), or update the cap.
- Mode B may set `mintable_supply` to a safe cap (for example total supply as of H).

If implemented via a public `_decrement_supply(amount)`, amounts become public.

## Proof Requirements

All claims provide:

- an old rollup block header `header` with roots for the relevant trees,
- the circuit computes `header.hash()` and enqueues a public call to MigrationArchiveRegistry to verify it matches a stored block hash (Mode A checks `block_hashes[block_number]`, Mode B checks `snapshot_block_hash`), and
- membership / non-membership proofs against roots inside `header`.

**Mode A `migrate_notes_mode_a` proves:**

1. Each `MigrationNote.leaf_hash` exists in the note tree (inclusion proof against `header.note_hash_tree.root`).
2. `dest_rollup_id` in the note preimage matches the current rollup version.
3. Schnorr signature verifies for `mpk` embedded in the MigrationNote.
4. Block hash verification is enqueued to MigrationArchiveRegistry (`verify_migration_mode_a(block_number, block_hash)`).

**Mode B `migrate_notes_mode_b` proves (private notes):**

1. Address verification: `nsk` -> `npk_m` via EC scalar mul, verify `AztecAddress::compute(public_keys, partial_address) == notes_owner`.
2. Each note's `leaf_hash` exists under `header_H.note_hash_tree.root`.
3. Each note is not nullified at H (non-membership against `header_H.nullifier_tree.root`) using constrained nullifier derivation from `nsk_app`.
4. `MigrationKeyNote` for the owner exists in the note hash tree at H.
5. Schnorr signature verifies for `mpk` from the key note.
6. Block hash verification is enqueued to MigrationArchiveRegistry (`verify_migration_mode_b(block_hash)`).

**Mode B public state migration proves:**

1. Each field of the struct existed in the public data tree at the derived storage slot (Merkle inclusion against `header_H.public_data_tree.root`).
2. For owned state: Schnorr signature and key note inclusion (same as private notes).
3. Block hash verification is enqueued to MigrationArchiveRegistry.

## API

### TokenV1 (Old Rollup)

| Function | Params | Description |
| --- | --- | --- |
| `lock_migration_notes_mode_a` | `amount, destination_rollup, mpk` | Lock private balance for migration, creates MigrationNote |
| `lock_public_for_migration` | `amount, destination_rollup, mpk` | Lock public balance for migration, creates MigrationNote + decrements public balance |

### MigrationKeyRegistry (Old Rollup, Mode B only)

| Function | Params | Description |
| --- | --- | --- |
| `register` | `mpk: Point` | Register migration public key (creates MigrationKeyNote) |
| `get` | `owner: AztecAddress` | View registered mpk for an owner (unconstrained) |

### MigrationArchiveRegistry (New Rollup, shared)

| Function | Params | Description |
| --- | --- | --- |
| `consume_l1_to_l2_message` | `archive_root, proven_block_number, secret, leaf_index` | Consume L1->L2 message, store trusted archive root |
| `register_block` | `proven_block_number, block_header, archive_sibling_path` | Verify block header against stored archive root, store block hash |
| `set_snapshot_height` | `height, snapshot_block_header, proven_block_number, archive_sibling_path` | Set Mode B snapshot height (write-once) |
| `verify_migration_mode_a` | `block_number, block_hash` | Assert block hash matches stored value |
| `verify_migration_mode_b` | `block_hash` | Assert block hash matches snapshot block hash |

### TokenV2 (New Rollup)

| Function | Params | Description |
| --- | --- | --- |
| `migrate_mode_a` | `amount, mpk, signature, note_proof_data, block_header` | Claim Mode A migration (private -> private) |
| `migrate_to_public_mode_a` | `amount, mpk, signature, note_proof_data, block_header` | Claim Mode A migration (private -> public) |
| `migrate_mode_b` | `amount, signature, full_proof_data, block_header, notes_owner, public_keys, partial_address, key_note, nsk` | Claim Mode B migration (private notes) |
| `migrate_to_public_*_mode_b` | `proof_data, block_header, [map_keys], [old_owner, signature, key_note]` | Claim Mode B migration (public state) |

## Migration Nullifiers

```
Mode A (private notes):  poseidon2_with_sep([note_hash, randomness], DOM_SEP__NOTE_NULLIFIER)
Mode B (private notes):  poseidon2_with_sep([unique_note_hash, randomness], DOM_SEP__NOTE_NULLIFIER)
Mode B (public state):   poseidon2_with_sep([old_app, storage_slot], GENERATOR_INDEX__PUBLIC_MIGRATION_NULLIFIER)
```

Mode A uses the MigrationNote's own randomness (not the user's secret key) to preserve privacy — observers cannot link old/new rollup identities by predicting the nullifier.

Mode B private notes use the unique note hash and randomness for the same reason.

Mode B public state uses a deterministic nullifier derived from the contract address, storage slot, and field index, since public state has no randomness.

## TODO

1. ~~Finalize portal message encoding / hashing for `(old_rollup_id, archive_root, block_number)`.~~ Done.
2. Evaluate salt-based commitment for new accounts (see Future work section).
3. ~~Mode B public balances: add public data tree proof path.~~ Done — `PublicStateProofData` verifies each field against the public data tree. Supports standalone values, maps, owned maps, and nested owned maps.
4. Supply cap: for per-user migrated amounts, explore whether it's possible to do some simple batching.
