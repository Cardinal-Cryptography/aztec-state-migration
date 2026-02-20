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
- **Mode B:** private balances at snapshot height H (public deferred)

**Out of Scope:** L1-bridged assets and any forced-exit / bridge flows.

## Goals & Non-Goals

**Goals:** Trustless migration, routine (Mode A) and emergency snapshot (Mode B), privacy preservation (recipient privacy), double-claim prevention, recipient flexibility.

**Non-Goals:** Unlocking burns, automatic migration, key recovery.

## Key Design Decisions

1. **Burns/locks are permanent.** No unlock.
2. **TokenV2 deploys INACTIVE.** Governance calls `activate_mode_a()` OR `activate_mode_b()` once. Mode is immutable because Mode A and Mode B use different claim ids/nullifiers.
3. **TokenV2 has immutable config:** `old_rollup_id`, `TokenV1_address`, `root_registry_address` (new rollup), `migration_key_registry_address` (old rollup, for Mode B), `dest_rollup_id` (this rollup), `dest_token` (= TokenV2_address).
4. **Trusted anchors** are archive roots relayed from L1 via a portal to a shared **RootRegistry** contract, which verifies and stores block hashes (not raw archive roots). Migrating apps read verified block hashes from this single instance.
5. **Migration identity uses a separate keypair**, stored by the user (preferably in the wallet). The keypair is either committed in a registry contract (Mode B) or carried inside the lock note (Mode A). This spec does not assume migration keys are known at account creation—coordinating such a change close to mainnet launch is risky. Hence Mode B relies on an explicit MigrationKeyRegistry. Future account versions may embed migration keys in the salt preimage or a dedicated field (see Future work).

## Architecture

```
Old Rollup L2          L1 Portal              New Rollup L2
┌────────────┐      ┌──────────────┐      ┌──────────────┐
│  TokenV1   │      │   relays     │─────▶│ RootRegistry │
│  lock_*()  │      │ archive_root │ inbox│ stores block  │
├────────────┤      └──────────────┘      │   hashes     │
│ MigrationKey│                           └──────┬───────┘
│  Registry  │                                   │ reads
│  (Mode B)  │                            ┌──────▼───────┐
└────────────┘                            │   TokenV2    │
                                          │  claim_*()   │
                                          └──────────────┘

```

## L1 Portal + RootRegistry (currently being worked on)

A **portal** is an L1 contract that sends messages to Aztec L2 via the Inbox/Outbox system. In this design, the portal reads the old rollup's archive root at height `h` from the old rollup's L1 contracts and sends an L1→L2 Inbox message addressed to RootRegistry. It is permissionless in the sense that anyone can trigger portal action.  

The portal message content is:

```
(old_rollup_id, h, archive_root)
```

**RootRegistry** is a singleton contract on the new rollup, shared by all migrating apps—each app reads verified block hashes from this single instance rather than managing its own. `register_block(archive_root, block_number, secret, message_leaf_index, block_header, archive_sibling_path)` MUST:

- consume the corresponding Inbox message with content `H(old_rollup_id, archive_root, block_number)`,
- compute `block_hash = hash(block_header)`,
- verify `root_from_sibling_path(block_hash, block_number, archive_sibling_path) == archive_root` (proving the block header is a leaf in the archive tree), and
- store the verified `block_hash` keyed by `block_number`.

**Inbox message consumption** requires a `secret` because L1 messages commit to a `secretHash`, and L2 consumption reveals the preimage. For permissionless root syncing, the portal uses a public/deterministic secret (for example `0`). Reusing the same secret across many messages is safe because the message leaf index is part of consumption.

**Storage:** RootRegistry stores `block_number → block_hash` for all registered blocks. Any migrating app can call `verify_migration_mode_a(block_number, block_hash)` or `verify_migration_mode_b(block_hash)` to check a block hash against the stored value.

**App-level block hash policy:** Each migrating app (e.g., TokenV2) enforces its own policy on which block hashes it accepts:

- **Mode A:** accept any registered block hash.
- **Mode B:** accept only the block hash at snapshot height H (stored as `snapshot_block_hash`).

# Identity & migration key registry

### Overview

Migration claims must be authorized in a way that does **not** depend on successful execution of the user’s old account contract (because the old rollup may be upgraded due to bugs). This spec uses a dedicated **migration keypair**:

- **msk**: migration secret key (kept private in the wallet)
- **mpk**: migration public key (a point on the **Grumpkin curve**, an elliptic curve used in Aztec-friendly cryptography)

The migration keypair is used **only** to authorize migration claims. It is not used as an Aztec account transaction signing key.

**Security comparison with other Aztec keys:**
- **Signing key leak:** attacker can spend your funds on the current rollup
- **Nullifier key leak:** attacker can link your transactions (privacy loss), but cannot spend
- **Viewing key leak:** attacker can see your balances (privacy loss), but cannot spend
- **Migration key leak:** attacker can claim your tokens on the new rollup during migration (fund loss, scoped to migration)

We commit to the migration key on-chain using:

- `mpk_hash = poseidon2(mpk.x, mpk.y)`

### Claim authorization signature

For each claim, the claimant provides a **Schnorr signature** over a domain-separated message:

```
msg = poseidon2(CLAIM_DOMAIN, mode, old_rollup_id, dest_rollup_id, leaf_hash, recipient, TokenV2_address)
```

- `leaf_hash` is the note-tree leaf hash being claimed:
    - Mode A: the leaf hash of the MigrationLockNote on the old rollup
    - Mode B: the leaf hash of the original note at snapshot height H
- `recipient` is the new-rollup recipient (private or public, depending on claim function design)
- `CLAIM_DOMAIN` provides **domain separation** (a fixed tag included in a hash) to prevent signatures from being reused in other contexts.

On claim, TokenV2:

1. Verifies `sig` under `mpk`.
2. Computes `poseidon2(mpk.x, mpk.y)` and checks it matches the expected `mpk_hash` source for the active mode (see below).

This binds the claim to the chosen recipient and prevents third-party redirection.

### Where `mpk_hash` comes from

Mode A and Mode B intentionally use different `mpk_hash` sources.

### Mode A: `mpk_hash` is carried in the lock note

In Mode A the user creates a MigrationLockNote on the old rollup. The lock note preimage includes `mpk_hash`, so TokenV2 can recover the expected `mpk_hash` directly from the proven lock-note leaf hash.

This means Mode A does not require any separate identity registry.

### Mode B: `mpk_hash` must be committed before snapshot height H

In Mode B, TokenV2 must learn the correct `mpk_hash` for the owner of the original note **as of snapshot height H**, in a way that is provable against the old rollup header at height H.

This requires a public on-chain commitment on the old rollup **at or before height H**. Commitments after height H must not be usable for Mode B claims.

Concretely, Mode B uses a shared **MigrationKeyRegistry** contract on the old rollup:

- The registry stores a mapping from an owner identifier `owner_id` (the same identifier used in TokenV1 notes, typically the old-rollup Aztec address or equivalent owner field) to `mpk_hash`.
- The registry is written in **public state**, so its storage is committed under the old rollup’s **public data tree root** in each block header.

**Registry read / proof use (new rollup claim):**

- In `claim_emergency`, the claimant proves a membership path under `header_H.public_data_root` showing that:
    - the registry storage slot for `owner_id` contains `mpk_hash`, and
    - the contract address in the proof is the expected MigrationKeyRegistry address on the old rollup.

TokenV2 then checks `poseidon2(mpk.x, mpk.y) == mpk_hash` from that proof.

**Important constraint:** if a user did not register `mpk_hash` before snapshot height H, they cannot claim in Mode B.

### Mode B ownership binding for private notes

Even for private notes, Mode B must bind a claim to the rightful owner. Otherwise, anyone who learns a note’s preimage (for example a sender, a compromised device, or any system that had access to the plaintext note) could claim it on the new rollup.

Mode B therefore requires:

- the original note’s owner identifier `owner_id` to be provided as witness (as part of the note preimage),
- a proof that `owner_id → mpk_hash` is present in the registry at height H, and
- a valid signature under the corresponding `mpk`.

This makes “knowledge of the migration secret key” the authorization condition for claiming.

### Wallet guidance

Wallets should:

- generate and store `msk` securely,
- persist `msk` across rollups (so users can migrate multiple times),
- encourage or automate registry registration well before any planned snapshot migration.

The spec does not require how `msk` is derived. It may be derived from the wallet seed for backup purposes, but the migration proof system must not require exposing or proving over the wallet seed.

### Future work: protocol-level identity commitments

The [forum post](https://forum.aztec.network/t/request-for-grant-proposals-application-state-migration/8298/2?u=adamgagol) discusses several approaches to embed migration keys at the protocol level:

- Salt-based commitment: New accounts deploy with salt = h(actual_salt, h(mpk, root)), embedding the
migration key in address derivation. No registry transaction needed.
- Protocol-level field: A dedicated mpk_hash field in account data or address preimage.

A hybrid claim circuit could accept either salt preimage proofs (new accounts) or registry proofs
(existing accounts).

This spec uses an external registry because it works for all existing accounts without protocol changes, while remaining compatible with future approaches.

## Batching multiple notes

TODO

## Data Structures & Hashing

Claims prove inclusion over the **exact note-tree leaf hash** inserted into the note hash tree. In Aztec, the application computes a note hash that includes note content (and logically a "slot"), then the kernel siloes it by contract address and makes it unique by hashing in a `note_nonce`, producing the value inserted into the note hash tree.

**MigrationLockNote (Mode A lock note):**

```
note_preimage = (amount, mpk_hash, dest_rollup_id, dest_token, salt)
inner         = h(LOCK_SLOT, note_preimage) // type of note in the app
siloed        = h(TokenV1_address, inner)  //
leaf_hash     = h(note_nonce, siloed)   // value inserted into the note hash tree
```

**OriginalNote (Mode B):**

Membership proof is over the leaf hash inserted into TokenV1's balance slot.

## Migration Modes

| Mode | Scenario | Flow | Scope |  |
| --- | --- | --- | --- | --- |
| A | Routine | lock → claim | Public + private |  |
| B | Emergency | claim_emergency only | Private (public still in  discussion) |  |

**Mode B semantics:** claims reflect state at height H; post-H activity is intentionally ignored.

## Supply Control (optional cap)

TokenV2 may enforce a `mintable_supply` cap set at activation (turnstile).

- **Recommended:** enable the cap in both modes, but only if TokenV1 supply is frozen (mint/burn disabled) before activation and `mintable_supply` is set to the known total supply. If supply is not frozen, an incorrect cap can block valid claims, so it is advised to either set the cap with some leeway (depending on whether app developers decide to honor tokens minted after migration has started), or update the cap.
- Mode B may set `mintable_supply` to a safe cap (for example total supply as of H).

If implemented via a public `_decrement_supply(amount)`, amounts become public.

## Proof Requirements

All claims provide:

- an old rollup block header `header` with roots for the relevant trees,
- a proof that `header.hash()` matches a verified block hash stored in RootRegistry (Mode A checks against `block_hashes[block_number]`, Mode B checks against `snapshot_block_hash`), and
- membership / non-membership proofs against roots inside `header`.

**Mode A `claim` proves:**

1. `MigrationLockNote.leaf_hash` exists in the note tree (inclusion proof) under `header.note_root`.
2. `header.hash()` matches a verified block hash in RootRegistry for `header.height`.
3. `dest_rollup_id == TokenV2.dest_rollup_id` and `dest_token == TokenV2_address` from the lock note preimage.
4. Signature verifies for `mpk` matching `mpk_hash` in the lock note.

**Mode B `claim_emergency` proves:**

1. `OriginalNote.leaf_hash` exists under `header_H.note_root`, where `header_H.height == H`.
2. The note is not nullified at H (non-membership against `header_H.nullifier_root`).
3. `mpk_hash` for `owner_id` exists in MigrationKeyRegistry under `header_H.public_data_root`, and matches `poseidon2(mpk.x, mpk.y)`.
4. Signature verifies for `mpk`.

## API

### TokenV1 (Old Rollup)

| Function | Params | Returns |
| --- | --- | --- |
| `enable_migration` | `dest_rollup_id, dest_token` | `void` |
| `lock_private` | `amount, mpk_hash, salt` | `leaf_hash` |
| `lock_public` | `amount, mpk_hash, salt` | `leaf_hash` |

### MigrationKeyRegistry (Old Rollup, Mode B only)

| Function | Params | Returns |
| --- | --- | --- |
| `register` | `mpk_hash` | `void` |
| `get` | `owner_id` | `mpk_hash` |

### RootRegistry (New Rollup, shared)

| Function | Params | Returns |
| --- | --- | --- |
| `register_block` | `archive_root, block_number, secret, message_leaf_index, block_header, archive_sibling_path` | `void` |
| `set_snapshot_height` | `height, snapshot_block_header, reference_block_number, reference_block_header, archive_sibling_path` | `void` |
| `verify_migration_mode_a` | `block_number, block_hash` | `void` |
| `verify_migration_mode_b` | `block_hash` | `void` |

### TokenV2 (New Rollup)

| Function | Params | Returns |
| --- | --- | --- |
| `claim` | `lock_note, header, proofs, recipient, mpk, sig` | `void` |
| `claim_emergency` | `original_note, header_H, proofs, recipient, mpk, sig` | `void` |
| `activate_mode_a` | `mintable_supply` | `void` |
| `activate_mode_b` | `height_H, mintable_supply` | `void` |

## Migration Nullifiers

```
Mode A: poseidon2(MIGRATION_DOMAIN, A, lock_leaf_hash, TokenV2_address, dest_rollup_id)
Mode B: poseidon2(MIGRATION_DOMAIN, B, original_leaf_hash, TokenV2_address, dest_rollup_id)

```

## TODO

1. Finalize portal message encoding / hashing for `(old_rollup_id, archive_root, block_number)` (canonical library shared by L1 portal and L2 RootRegistry).
2. Evaluate salt-based commitment for new accounts (see Future work section).
3. Mode B public balances: add public data tree proof path.
4. Supply cap: for per-user migrated amounts, explore whether it’s possible to do some simple batching.
