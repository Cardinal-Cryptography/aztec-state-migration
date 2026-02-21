---
layout: default
title: Architecture
---

[← Home](index.md)

# Architecture

This document provides a system-level overview of the dual-rollup migration framework: deployment topology, component catalog, composition pattern, and the L1-L2 bridge flow.

## Deployment Topology

```
Old Rollup L2                  L1                         New Rollup L2
+-----------------------+   +------------------+   +------------------------------+
| TokenV1               |   | Migrator.sol     |   | MigrationArchiveRegistry     |
|   lock_migration_*()  |   |   reads old      |   |   stores block hashes        |
+-----------------------+   |   archive root,  |   |   verify_migration_mode_a()  |
| MigrationKeyRegistry  |   |   sends L1->L2   |   |   verify_migration_mode_b()  |
|   register(mpk)       |   |   message via    |   +-------------+----------------+
|   (Mode B only)       |   |   Inbox          |                 | reads
+-----------------------+   +------------------+   +-------------v----------------+
                                                    | ExampleMigrationApp          |
                                                    |   migrate_mode_a()           |
                                                    |   migrate_mode_b()           |
                                                    |   migrate_to_public_*()      |
                                                    +------------------------------+
```

All migrating app contracts on the new rollup share a single `MigrationArchiveRegistry` instance for block hash verification. The `MigrationKeyRegistry` on the old rollup is used only by Mode B to bind migration keys to user addresses before snapshot height H.

## Component Catalog

### `migration_lib` (Noir library)

A Noir library (not a contract) providing core migration verification logic. App contracts call its functions directly.

Module structure (`noir/migration_lib/src/`):

| Module | Contents |
|--------|----------|
| `mode_a/ops` | `lock_migration_notes`, `migrate_notes_mode_a` |
| `mode_b/ops` | `migrate_notes_mode_b`, `migrate_public_state_mode_b`, `migrate_public_map_state_mode_b`, `migrate_public_map_owned_state_mode_b` |
| `note_proof_data` | `NoteProofData<T>` (shared by both modes) |
| `signature` | `MigrationSignature` (Schnorr signature wrapper) |
| `constants` | Domain separators, generator indices |

### `ExampleMigrationApp` (Noir contract)

A migration-aware token contract (`noir/contracts/example_app/src/main.nr`) that demonstrates both Mode A and Mode B. Wraps `migration_lib` functions to handle minting, balance updates, and public state migration. Uses `BalanceSet` for private balances and `PublicMutable`/`Map` for public state.

### `NftMigrationApp` (Noir contract)

An NFT migration contract implementing Mode A and Mode B for non-fungible tokens. Present in the codebase but **out of documentation scope**. The same `migration_lib` functions generalize to NFTs.

### `MigrationArchiveRegistry` (Noir contract, new rollup)

Singleton contract on the new rollup, shared by all migrating apps. Stores verified block hashes bridged from the old rollup via L1.

- **Constructor params:** `l1_migrator: EthAddress`, `old_rollup_version: Field`, `old_key_registry: AztecAddress`
- **Key functions:** `consume_l1_to_l2_message`, `register_block`, `set_snapshot_height`, `verify_migration_mode_a`, `verify_migration_mode_b`
- **Storage:** `archive_roots` (by proven block number), `block_hashes` (by block number), `snapshot_block_hash` (write-once for Mode B)

### `MigrationKeyRegistry` (Noir contract, old rollup)

Mode B identity contract. Uses `Owned<PrivateImmutable<MigrationKeyNote>>` for per-user write-once key storage.

- **`register(mpk: Point)`** -- creates a `MigrationKeyNote` bound to the caller, stored in the note hash tree
- **`get(owner: AztecAddress)`** -- unconstrained view; returns `point_at_infinity` if no key is registered

### `Migrator` (Solidity, L1)

Permissionless L1 contract (`solidity/contracts/Migrator.sol`) that bridges old rollup archive roots to the new rollup.

- **`migrateArchiveRoot(oldVersion, l2Migrator)`** -- reads the old rollup's latest `provenCheckpointNumber` and archive root, sends an L1-to-L2 message
- **`migrateArchiveRootAtBlock(oldVersion, blockNumber, l2Migrator)`** -- same, but for a specific block height
- **`getArchiveInfo(version)`** -- view function returning current archive root and proven checkpoint

## Three-Layer Composition Pattern

Migration logic is organized in three layers, each with a distinct responsibility:

```
Layer 3: TS migration-lib        Client-side proof building, key derivation,
  (ts/migration-lib/)             transaction construction, wallet helpers

Layer 2: App contracts            Wrappers that call library functions, handle
  (noir/contracts/example_app/)   app-specific state (minting, balance updates)

Layer 1: Noir migration_lib       Core verification logic: proof verification,
  (noir/migration_lib/)           nullifier emission, signature checking
```

**Layer 1 (Noir `migration_lib`)** verifies Merkle proofs, checks Schnorr signatures, emits migration nullifiers, and enqueues block hash verification. It is app-agnostic.

**Layer 2 (App contracts)** import library functions and add app-specific logic: minting tokens on claim, decrementing supply, managing `BalanceSet` or `PublicMutable` state.

**Layer 3 (TS `migration-lib`)** builds proof witnesses from Aztec node data, derives migration keys from account secrets, constructs Schnorr signatures, and orchestrates transaction submission. Exports are split by mode (`mode-a/`, `mode-b/`).

## L1-L2 Bridge Flow

The bridge flow anchors migration trust in L1-proven state:

```
Migrator.sol                          MigrationArchiveRegistry
    |                                         |
    |  1. Read archiveRoot from old rollup    |
    |  2. content = poseidon2_hash(oldVersion,     |
    |     archiveRoot, provenBlockNumber)      |
    |  3. inbox.sendL2Message(l2Migrator,     |
    |     content, SECRET_HASH_FOR_ZERO)       |
    |                                         |
    |  -------- L1-to-L2 message ---------->  |
    |                                         |
    |                 4. consume_l1_to_l2_message(archiveRoot,
    |                    provenBlockNumber, secret=0, leafIndex)
    |                    -> stores archive_roots[provenBlockNumber]
    |                                         |
    |                 5. register_block(provenBlockNumber,
    |                    blockHeader, archiveSiblingPath)
    |                    -> verifies header against archive root,
    |                       stores block_hashes[blockNumber]
```

The `SECRET_HASH_FOR_ZERO` constant enables permissionless consumption: anyone can consume the L1-to-L2 message using `secret=0`. The leaf index disambiguates messages with the same secret.

A convenience function `consume_l1_to_l2_message_and_register_block` combines steps 4 and 5 in a single call.

## Cross-Context Configuration

Storage fields such as `old_app_address`, `old_key_registry`, and `old_rollup_version` use `PublicImmutable` rather than constants or private state. This is because:

- They are set at deployment time (not known at compile time)
- They must be readable in both private and public execution contexts
- `PublicImmutable` supports private reads via `WithHash::historical_public_storage_read`, which reads from historical public storage at the anchor block without any note management overhead

This pattern allows private migration functions to access deployment configuration directly, avoiding the complexity of note-based state propagation.

## Related Documents

- [Home](index.md) -- entry point and documentation map
- [Migration Specification](spec/migration-spec.md) -- protocol-level design, data structures, proof requirements
- [Mode A](mode-a.md) -- cooperative lock-and-claim migration flow
- [Mode B](mode-b.md) -- emergency snapshot migration flow
- [Integration Guide](integration-guide.md) -- TS SDK, proof types, developer workflow
- [Threat Model](threat-model.md) -- trust assumptions and PoC limitations
- [Operations](operations.md) -- testing, setup, troubleshooting
