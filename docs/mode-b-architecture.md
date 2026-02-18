---
layout: default
title: Mode B Architecture
---

[← Home](.)

# Mode B Architecture: Emergency Snapshot Migration

This document describes the architectural choices made when implementing Mode B (Emergency Snapshot Migration) for Aztec cross-rollup token migration.

## Overview

Mode B enables token migration when users have **not** pre-locked their notes on the old rollup. It is designed for emergency scenarios where the old rollup becomes unavailable before users can perform orderly Mode A lock-and-claim. Instead of relying on a dedicated lock note, Mode B lets users prove directly that:

1. A balance note existed in the old rollup's note hash tree at a fixed snapshot height H
2. That note was not nullified (spent) at height H
3. The user registered a migration key before H
4. The user knows the corresponding migration secret key

## Contract Architecture

### Why a Separate MigratorModeB Contract

Mode A uses a single `Migrator` contract that handles both locking (on old rollup) and claiming (on new rollup). Mode B introduces a separate `MigratorModeB` contract rather than extending the existing Migrator for several reasons:

- **Different trust model.** Mode A verifies a purpose-built `MigrationNote` that the Migrator itself created. Mode B verifies *existing* application notes (`UintNote`) and key registration notes (`MigrationKeyNote`) created by other contracts. The storage requirements differ: Mode B needs `old_app_address` and `old_key_registry` for hash siloing, while Mode A needs `old_rollup_migrator`.
- **Snapshot height.** Mode B introduces a global `snapshot_height` that anchors all proofs to a single block. Mode A has no equivalent — users can prove against any registered archive root.
- **Separation of concerns.** Mode A and Mode B have fundamentally different activation conditions. Mode A is always available; Mode B is only activated during emergencies. Keeping them separate makes each contract easier to audit and reason about.

### ExampleMigrationApp as the Token Layer

Both modes use the same `ExampleMigrationApp` contract as the token-layer entry point. It calls into the appropriate Migrator contract for proof verification, then mints tokens on success. This keeps the token state (balances) in one place regardless of which migration path was used.

## Proof Chain

Mode B's private function verifies a chain of Merkle proofs connecting user notes back to a trusted archive root:

```
UintNote hash ──Merkle proof──> note_hash_tree_root ──(embedded in)──> BlockHeader
                                                                           │
MigrationKeyNote hash ──Merkle proof──> note_hash_tree_root               │
                                                                           │
                                                   BlockHeader.hash() ──Merkle proof──> archive_root
                                                                                            │
                                                                              (trusted from L1 bridge)
```

Simultaneously, for each note, a **nullifier non-inclusion proof** is checked against the same block header's nullifier tree root.

### Archive Root Trust Anchor

The archive root is bridged from L1 via `register_archive_root`, which consumes an L1-to-L2 message whose content is `poseidon2(old_rollup_version, archive_root, proven_block_number)`. This is the same pattern used in Mode A, reused without modification. The L1 Migrator contract reads the old rollup's `provenCheckpointNumber` and sends it to the new rollup via the inbox.

### Block Header Binding

The private function verifies that the provided `BlockHeader` has `global_variables.block_number == snapshot_height`. The block header hash is then proven to be a leaf in the archive tree, and the resulting archive root is passed to a public function (`complete_migration_mode_b`) that checks it against the stored trusted value.

This private→public split is necessary because the archive roots are stored in public state. The private function computes the archive root and the public function checks it, connected via the enqueue mechanism.

## Note Hash Computation

### UintNote (Two-Step Hash)

UintNote uses a two-step hash that matches the `uint-note` library exactly:

```
partial = poseidon2([owner, storage_slot, randomness], GENERATOR_INDEX__NOTE_HASH)
note_hash = poseidon2([partial, value], GENERATOR_INDEX__NOTE_HASH)
siloed = compute_siloed_note_hash(old_app_address, note_hash)
unique = compute_unique_note_hash(nonce, siloed)
```

The two-step structure exists because UintNote uses `#[partial_note(quote { self.value })]` — the value is hashed separately from the other fields to support note value hiding during partial note flows.

### MigrationKeyNote (Owner-Bound Hash)

The MigrationKeyNote hash was modified from its original form to include the owner:

```
note_hash = poseidon2([mpk_hash, owner, storage_slot, randomness], GENERATOR_INDEX__NOTE_HASH)
siloed = compute_siloed_note_hash(old_key_registry_address, note_hash)
unique = compute_unique_note_hash(nonce, siloed)
```

**Why include owner in the hash:** Without owner binding, any party who knows the note preimage (e.g., from observing note delivery messages) could claim any user's balance by providing that user's key registration note hash. Including the owner means the MigratorModeB circuit proves that *this specific address* registered *this specific mpk_hash*, and since the balance note is also bound to an owner, the two are linked through the shared `balance_note_owner` parameter used in both hash computations.

This was a deliberate breaking change from the initial MigrationKeyNote implementation. The `#[custom_note]` macro was used specifically because standard note types ignore the owner parameter in `compute_note_hash`.

## Nullifier Non-Inclusion (Low-Leaf Indexed Tree Pattern)

To prove a note has NOT been nullified, Mode B uses the nullifier tree's indexed structure. The nullifier tree is a sorted indexed Merkle tree where each leaf contains `(nullifier, next_nullifier, next_index)`.

The proof works as follows:

1. **Low-leaf identification.** Find the leaf whose `nullifier < target` and `next_nullifier > target` (or `next_index == 0` for the maximum element).
2. **Low-leaf membership.** Prove the low leaf is in the nullifier tree via `root_from_sibling_path(poseidon2([value, next_value, next_index]), leaf_index, sibling_path)`.
3. **Sandwich check.** Assert `low_value < target_nullifier` and `(next_value > target_nullifier || next_index == 0)`.

If these conditions hold, the target nullifier cannot exist in the tree — there is no position where it could be inserted while maintaining the sorted invariant, which proves the note was not spent.

The field comparisons use `full_field_less_than` and `full_field_greater_than` from protocol_types, which handle the full field range (not just u64 truncation).

## Authentication Model

### Current (PoC): Hash-Based

```
mpk_hash = poseidon2([msk])
```

The user proves knowledge of `msk` by deriving `mpk_hash` and showing it matches the value stored in their MigrationKeyNote. This is simple but weak — anyone who learns `msk` can claim.

### Production: Schnorr Signatures

Production should use Schnorr signatures over a domain-separated message that binds the claim to specific parameters:

```
msg = poseidon2(CLAIM_DOMAIN, "B", old_rollup_id, dest_rollup_id, leaf_hash, recipient, token_address)
sig = schnorr_sign(msk, msg)
```

The circuit would verify `sig` under the full Grumpkin point `mpk` (not just its hash). This prevents replay attacks and binds the claim to a specific recipient and token contract.

## Siloed Nullifier as Unchecked Witness

The `siloed_nullifier` values for both the balance note and key registration note are accepted as unchecked witnesses from PXE. This is the most significant security compromise in the PoC.

**Why it cannot be recomputed in-circuit:** Computing a siloed nullifier requires `nsk_app` (the app-scoped nullifier secret key). On the new rollup, `request_nsk_app()` is scoped to the *current* contract address, not the old rollup's contract address. There is no way to request the `nsk_app` for a contract that doesn't exist on the current rollup.

**The attack vector:** An attacker who knows `msk` but not the nullifier secret key (`nsk`) could fabricate a fake nullifier. Since the fake nullifier genuinely is not in the nullifier tree, the non-inclusion proof would pass — allowing claims on already-spent notes.

**Production mitigation:** The user would provide `nsk_app` as an additional witness. The circuit would verify:
1. `inner_nullifier = poseidon2([note_hash, nsk_app], GENERATOR_INDEX__NOTE_NULLIFIER)`
2. `siloed_nullifier = poseidon2([contract_address, inner_nullifier], GENERATOR_INDEX__OUTER_NULLIFIER)`
3. That `nsk_app` derives from the note owner's nullifier public key (requires protocol-level key registry integration)

## Migration Nullifier (Double-Claim Prevention)

Each Mode B migration emits a nullifier:

```
migration_nullifier = poseidon2([unique_note_hash, msk], GENERATOR_INDEX__NOTE_NULLIFIER)
```

This is pushed in the private function via `self.context.push_nullifier()`. Because nullifiers are globally unique and the new rollup's kernel enforces non-duplication, the same note cannot be migrated twice. The nullifier includes `msk` to prevent front-running — only the key holder can produce this nullifier.

## Snapshot Height

Mode B uses a single global `snapshot_height` — the block number at which all proofs are anchored. This differs from Mode A, which allows proofs against any registered archive root.

**Why a fixed snapshot:** In an emergency, all users should prove against the same state. A moving target would allow race conditions where notes are spent between proof generation and verification. The snapshot height is set once via `set_snapshot_height` and requires that an archive root is already registered for that height.


## PublicImmutable for Cross-Context Configuration

Storage fields like `old_app_address`, `old_key_registry`, and `old_rollup_version` use `PublicImmutable` rather than constants or private state. This is because:

- They need to be set at deployment time (not known at compile time)
- They need to be readable in both private and public contexts
- `PublicImmutable` supports private reads via `WithHash::historical_public_storage_read`, which reads from historical public storage at the anchor block — it does NOT use notes, despite the private context

This means the private `migrate_mode_b` function can read deployment configuration without any note management overhead.

## Test Architecture

The E2E test (`scripts/migration_mode_b.test.ts`) runs against two Aztec sandbox instances (ports 8080 and 8081) representing old and new rollups. The test:

1. Deploys contracts on the old rollup and mints tokens
2. Registers a migration key on the old rollup
3. Bridges the archive root via L1
4. Gathers all Merkle proofs and witnesses from the old rollup's node
5. Calls `migrate_mode_b` on the new rollup
6. Verifies the balance on the new rollup

Key implementation detail: the migration transaction is sent from a pre-deployed sandbox account (the deployer) rather than a freshly created account. This is because `createSchnorrAccount` only registers in PXE — it doesn't deploy the Schnorr account contract on-chain. Pre-deployed sandbox accounts already have their signing key notes available.
