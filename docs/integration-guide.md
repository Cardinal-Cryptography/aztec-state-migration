---
layout: default
title: Integration Guide
---

[← Home](index.md)

# Integration Guide

## Overview

The migration system is organized into three tiers:

1. **Library tier: Noir `aztec_state_migration`** -- Core verification logic: proof verification, nullifier emission, signature checking. This is a library, not a contract.
2. **Application tier: App contracts** -- Wrappers that call library functions and handle app-specific state (minting, balance updates).
3. **Client SDK tier: TS `aztec-state-migration`** -- Client-side proof building, key derivation, transaction construction.

Integrators typically work at the Application and Client SDK tiers: writing an app contract that calls into `aztec_state_migration`, and using the TS client library to build proofs and submit transactions. The focus here is the Client SDK tier and the proof data types that bridge Noir and TypeScript.

## Minimal Flow at a Glance

**Mode A** (cooperative lock-and-claim):

1. `deriveMasterMigrationSecretKey(secretKey)` -- derive the migration key
2. `oldApp.lock_migration_notes_mode_a(amount, destRollup, mpk)` -- lock on old rollup
3. `migrateArchiveRootOnL1(...)` + `waitForL1ToL2Message(...)` -- bridge archive root via L1 to new rollup
4. `wallet.buildMigrationNoteProofs(blockNumber, lockNotes, events)` -- build proofs
5. `signMigrationModeA(signer, oldVersion, newVersion, notes, recipient, newApp)` -- sign
6. `newApp.migrate_mode_a(amount, mpk, signature, proofs, blockHeader)` -- claim on new rollup

**Mode B** (emergency snapshot, private notes):

1. `deriveMasterMigrationSecretKey(secretKey)` -- derive the migration key
2. `keyRegistry.register(mpk)` -- register key on old rollup (before snapshot)
3. `migrateArchiveRootOnL1(...)` + `waitForL1ToL2Message(...)` + `archiveRegistry.set_snapshot_height(...)` -- bridge archive root and set snapshot height
4. `wallet.buildFullNoteProofs(blockNumber, notes, UintNote.fromNote)` -- build inclusion + non-nullification proofs
5. `wallet.buildKeyNoteProofData(keyRegistry, owner, blockNumber)` -- build key proof
6. `signMigrationModeB(signer, oldVersion, newVersion, notes, recipient, newApp)` -- sign
7. `newApp.migrate_mode_b(amount, signature, proofs, blockHeader, owner, publicKeys, partialAddress, keyProof, nhk)` -- claim on new rollup

Details for each function follow below.

## Migration Key Rationale

Migration uses a dedicated keypair (`msk`/`mpk`) rather than the account's existing signing keys for three reasons:

1. **Account contract independence.** Migration claims must not depend on the old rollup's account contract executing correctly -- the old rollup may have been upgraded precisely because of bugs in those contracts. A separate keypair avoids this dependency.
2. **Cross-rollup proof compatibility.** The migration circuit needs to verify a signature against a key that is provably bound to the note owner. Standard Aztec account keys are not committed in a form that is easily provable across rollups.
3. **Scoped risk.** If the migration key is compromised, only migration claims are at risk -- not the user's general account security. See [threat model](threat-model.md#migration-key-compromise) for the full analysis.

The `msk` is derived deterministically from the account's secret key, so no additional key management is needed. See [Key Derivation](#key-derivation) for details.

## Proof Data Types

The following types represent the proof structures exchanged between the Noir library and the TS client. Field-level details are documented in the [spec](spec/migration-spec.md); this section provides a summary for integrators.

### Proof Structures

| Type | Source | Purpose |
|------|--------|---------|
| `NoteProofData<T>` | `note_proof_data.nr` | Note-hash inclusion proof (generic over note type). Fields: `data`, `randomness`, `nonce`, `leaf_index`, `sibling_path`. |
| `MigrationNoteProofData<MigrationData>` | `mode_a/mod.nr` (type alias) | Type alias for `NoteProofData<MigrationData>`. Used in Mode A claim flows. |
| `FullNoteProofData<Note>` | `mode_b/mod.nr` | Combines `NoteProofData<Note>` with `NonNullificationProofData`. Used in Mode B private migration. |
| `NonNullificationProofData` | `mode_b/non_nullification_proof_data.nr` | Low-nullifier membership witness proving a note has not been nullified. Fields: `low_nullifier_value`, `low_nullifier_next_value`, `low_nullifier_next_index`, `low_nullifier_leaf_index`, `low_nullifier_sibling_path`. |
| `PublicStateSlotProofData` | `mode_b/public_state_proof_data.nr` | Single public data tree leaf proof. Fields: `next_slot`, `next_index`, `leaf_index`, `sibling_path`. Note: there is no `value` field -- the value comes from `data.pack()` in the parent `PublicStateProofData`. |
| `PublicStateProofData<T, N>` | `mode_b/public_state_proof_data.nr` | Bundle of `data: T` and `slot_proof_data: [PublicStateSlotProofData; N]`, one proof per packed field. |
| `KeyNoteProofData` | type alias for `NoteProofData<MigrationKeyNote>` | Inclusion proof for the `MigrationKeyNote` in the old rollup's note hash tree. Used in Mode B for key ownership verification. |

### Additional Structs

| Type | Source | Fields | Notes |
|------|--------|--------|-------|
| `MigrationNote` | `mode_a/migration_note.nr` | `note_creator: AztecAddress`, `mpk: Point`, `destination_rollup: Field`, `migration_data_hash: Field` | Created by `lock_migration_notes`. Consumed by `migrate_notes_mode_a`. |
| `MigrationKeyNote` | `migration-key-registry/migration_key_note.nr` | `mpk: Point` | Used by `MigrationKeyRegistry`. TS counterpart is `KeyNote` (from `mode-b/types.ts`), which has a different representation (`mpk` is expanded into `{ x, y, is_infinite }`). |
| `MigrationDataEvent<T>` | `mode_a/migration_data_event.nr` | `migration_data: T` | Emitted by `lock_migration_notes`. No dedicated TS type -- events are decoded via the general event decoding mechanism. Integrators receive raw event data, not a typed `MigrationDataEvent<T>`. |
| `MigrationSignature` | `signature.nr` | `bytes: [u8; 64]` | Accepted by all `migrate_*` functions. TS counterpart is `MigrationSignature` interface in `ts/aztec-state-migration/types.ts`. |

### Noir-to-TS Type Mapping

| Noir Type | Noir File | TS Type | TS File | Re-exported from `index.ts`? |
|-----------|-----------|---------|---------|------------------------------|
| `NoteProofData<T>` | `note_proof_data.nr` | `NoteProofData<Note>` | `ts/aztec-state-migration/types.ts` | Yes |
| `MigrationNoteProofData<MigrationData>` | `mode_a/mod.nr` (alias) | `MigrationNoteProofData<T>` | `ts/aztec-state-migration/mode-a/index.ts` | No (import from `mode-a/`) |
| `FullNoteProofData<Note>` | `mode_b/mod.nr` | `FullProofData<Note>` | `ts/aztec-state-migration/mode-b/types.ts` | No (import from `mode-b/`) |
| `NonNullificationProofData` | `mode_b/non_nullification_proof_data.nr` | `NonNullificationProofData` | `ts/aztec-state-migration/mode-b/types.ts` | No (import from `mode-b/`) |
| `PublicStateProofData<T, N>` | `mode_b/public_state_proof_data.nr` | `PublicDataProof<T>` | `ts/aztec-state-migration/mode-b/types.ts` | No (import from `mode-b/`) |
| `PublicStateSlotProofData` | `mode_b/public_state_proof_data.nr` | `PublicDataSlotProof` | `ts/aztec-state-migration/mode-b/types.ts` | No (import from `mode-b/`) |
| `KeyNoteProofData` (alias) | `mode_b/` | `NoteProofData<KeyNote>` | `ts/aztec-state-migration/mode-b/types.ts` | No (`KeyNote` from `mode-b/`) |
| `MigrationKeyNote` | `migration_key_note.nr` | `KeyNote` | `ts/aztec-state-migration/mode-b/types.ts` | No (import from `mode-b/`) |
| `MigrationNote` | `mode_a/migration_note.nr` | `MigrationNote` | `ts/aztec-state-migration/mode-a/index.ts` | No (import from `mode-a/`) |
| `MigrationSignature` | `signature.nr` | `MigrationSignature` | `ts/aztec-state-migration/types.ts` | No (returned by signing helpers, not independently re-exported) |
| `Point` (alias for `EmbeddedCurvePoint`) | `lib.nr` re-export | `Point` (from `@aztec/foundation/schemas`) | Aztec native type | N/A |
| `Scalar` (alias for `EmbeddedCurveScalar`) | `lib.nr` re-export | `Scalar` (Aztec native type) | Aztec native type | N/A |

**Naming discrepancies to note:**
- `PublicStateSlotProofData` (Noir) vs `PublicDataSlotProof` (TS)
- `PublicStateProofData` (Noir) vs `PublicDataProof` (TS)
- `MigrationKeyNote` (Noir) vs `KeyNote` (TS)
- `MIGRATION_MODE_A_STORAGE_SLOT` (Noir) vs `MIGRATION_NOTE_SLOT` (TS) -- same value, different names

## TS Client Data Flow -- Mode A

The Mode A (cooperative lock-and-claim) client flow follows this sequence:

1. **Derive migration key:** `deriveMasterMigrationSecretKey(secretKey)` returns a `GrumpkinScalar` used for signing.
2. **Sign the claim message:** `signMigrationModeA(signer, oldRollupVersion, newRollupVersion, migrationNotes, recipient, newAppAddress)` produces a `MigrationSignature` over `poseidon2_hash([CLAIM_DOMAIN_A, oldVersion, newVersion, notesHash, recipient, newApp])`.
3. **Build migration note proofs:** `buildMigrationNoteProof(node, blockNumber, noteDao, migrationDataEvent)` builds a `MigrationNoteProofData<T>` that includes the note inclusion proof with the original migration data from the encrypted event.
4. **Build block header:** `buildArchiveProof(node, blockHash)` or `buildBlockHeader(node, blockReference)` produces the Noir-compatible block header for archive verification.
5. **Submit transaction** to the new rollup's app contract.

**Retrieving encrypted events:** `MigrationBaseWallet.getMigrationDataEvents(abiType, eventFilter)` retrieves encrypted `MigrationDataEvent` data emitted during the lock step. The method filters on the `MigrationDataEvent` event selector and decodes the event payload using the provided ABI type.

> **Known behavior:** `getMigrationNotes()` returns all migration notes including already-migrated ones. Filtering by nullifier status requires cross-rollup queries (nullifiers are on the new rollup, notes on the old), which is non-trivial. Integrators should filter on the client side.

## TS Client Data Flow -- Mode B (Private)

The Mode B (emergency snapshot) private note migration flow:

1. **Derive migration key:** `deriveMasterMigrationSecretKey(secretKey)` -- same as Mode A.
2. **Sign the claim message:** `signMigrationModeB(signer, oldRollupVersion, newRollupVersion, notes, recipient, newAppAddress)` produces a `MigrationSignature` over `poseidon2_hash([CLAIM_DOMAIN_B, oldVersion, newVersion, notesHash, recipient, newApp])`.
3. **Build note proofs:** Use `MigrationBaseWallet.buildFullNoteProofs(blockNumber, notes, noteMapper)` to construct combined inclusion and non-nullification proofs (`FullProofData<Note>`). This internally calls `buildNoteProof` + `buildNullifierProof` for each note.
4. **Build archive proof:** `buildArchiveProof(node, blockHash)` -- same as Mode A.
5. **Submit transaction** to the new rollup's app contract.

Mode-B types are NOT re-exported from the top-level `index.ts`. Import them directly:

```typescript
import {
  FullProofData,
  NonNullificationProofData,
  PublicDataSlotProof,
  PublicDataProof,
  KeyNote,
} from "aztec-state-migration/mode-b";
```

## TS Client Data Flow -- Mode B (Public)

Public state migration uses a separate set of proof builders:

1. **Build public data proofs:**
   - `buildPublicDataProof(node, blockNumber, data, contractAddress, baseSlot, dataAbiType)` -- For standalone `PublicMutable<T>` values. Automatically determines the number of packed slots from the ABI type.
   - `buildPublicMapDataProof(node, blockNumber, data, contractAddress, baseSlot, mapKeys, dataAbiType)` -- For values inside `Map` storage. Derives the storage slot from `baseSlot` and `mapKeys` via `poseidon2_hash_with_separator([slot, key], DOM_SEP__PUBLIC_STORAGE_MAP_SLOT)` for each nesting level.
   - `buildPublicDataSlotProof(node, blockNumber, contractAddress, storageSlot)` -- Low-level single-slot proof builder.

2. **Sign for owned entries:** `signPublicStateMigrationModeB(signer, oldRollupVersion, newRollupVersion, data, abiType, recipient, newAppAddress)` produces a `MigrationSignature` over `poseidon2_hash([CLAIM_DOMAIN_B_PUBLIC, oldVersion, newVersion, dataHash, recipient, newApp])` where `dataHash = poseidon2_hash(pack(data))`.

3. **Submit transaction** to the new rollup's app contract.

## Wallet and Account Classes

The migration library provides two separate inheritance chains for managing accounts and constructing proofs.

### Account Hierarchy (Authentication Layer)

The account classes handle signing and key access:

- **`MigrationAccount`** (interface) -- Extends `Account` with `getMigrationPublicKey()`, `migrationKeySigner(msg)`, `getMaskedNhk(mask: Fq)`, `getNhkApp(contractAddress)`, and `getPublicKeys()`.
- **`MigrationAccountWithSecretKey`** (class, extends `AccountWithSecretKey`) -- Default implementation that derives and stores all migration keys in memory. Suitable for testing; production wallets should protect key material.
- **`SignerlessMigrationAccount`** (class, implements `MigrationAccount`) -- Placeholder for fee-less transactions using `DefaultMultiCallEntrypoint`. All signing methods throw. Used for public-only operations that do not require authentication.

### Wallet Hierarchy (State and Proof Building)

The wallet classes handle proof construction and note management:

- **`MigrationBaseWallet`** (abstract, extends `BaseWallet`) -- Contains the core proof-building and signing methods. Subclasses must implement `getMigrationPublicKey(account)` and `getPublicKeys(account)`.
- **`MigrationEmbeddedWallet`** (extends `MigrationBaseWallet`) -- Adds account registry and creation helpers. NOT re-exported from top-level `index.ts`; import from `aztec-state-migration/wallet`.
- **`NodeMigrationEmbeddedWallet`** (extends `MigrationEmbeddedWallet`) -- Node.js entrypoint with PXE creation and account deployment. Use for server-side / test environments.
- **`BrowserMigrationEmbeddedWallet`** (extends `MigrationEmbeddedWallet`) -- Browser entrypoint. Use for client-side web applications.

**Key methods on `MigrationBaseWallet`:**
- `buildFullNoteProofs(blockNumber, notes, noteMapper)` -- Build complete note proofs (inclusion + non-nullification) for Mode B private migration.
- `buildKeyNoteProofData(keyRegistry, owner, blockNumber)` -- Build proof data for the migration key note from the old rollup's key registry.
- `getMigrationDataEvents(abiType, eventFilter)` -- Retrieve encrypted migration data events from Mode A lock transactions.
- `buildMigrationNoteProofs(blockNumber, migrationNotes, migrationDataEvents)` -- Build note proofs for Mode A claim transactions, pairing each note with its corresponding event data.

These methods combine multiple lower-level proof-building functions into higher-level wrapper methods. Integrators should prefer these over calling `buildNoteProof`, `buildNullifierProof`, etc. directly.

For the end-to-end wallet flow in each migration mode, see the Wallet Integration sections in [Mode A](mode-a.md#wallet-integration) and [Mode B](mode-b.md#wallet-integration).

## Key Derivation

The master migration secret key (MSK) is derived from the account's secret key:

```
msk = sha512ToGrumpkinScalar([secretKey, MSK_M_GEN])
```

The migration public key (MPK) is the corresponding Grumpkin curve point.

**Constants** (defined only in TS `constants.ts` -- key derivation is entirely TS-side):
- `MSK_M_GEN = 2137` -- Domain separator for MSK derivation.
- `NHK_MASK_DOMAIN = 1670` -- Domain separator for nullifier hiding key masking. The `getMaskedNhk` implementation currently uses `mask = Fq.ZERO` (masking not yet enforced).

> **Known limitation:** TS constants (`constants.ts`) and Noir constants (`constants.nr`) are maintained independently with no cross-validation. Changes to domain separators or storage slots must be synchronized manually.

## Import Patterns

### Top-Level Exports (`aztec-state-migration`)

The top-level `index.ts` exports the following (wallet classes are NOT included):

- **Keys:** `deriveMasterMigrationSecretKey`, `signMigrationModeA`, `signMigrationModeB`, `signPublicStateMigrationModeB`
- **Proofs:** `buildNoteProof`, `buildArchiveProof`, `buildBlockHeader`
- **Bridge:** `waitForBlockProof`, `migrateArchiveRootOnL1`, `waitForL1ToL2Message`
- **Constants:** All from `constants.ts` (re-exported via `export *`)
- **Noir helpers:** `blockHeaderToNoir` (via `noir-helpers/index.ts`)
- **Polling:** `poll`, `PollOptions` (type)
- **Types:** `NoteProofData` (type), `ArchiveProofData` (type), `L1MigrationResult` (type)

### Wallet Sub-module (`aztec-state-migration/wallet`)

Wallet and account classes must be imported from the wallet sub-module:

- `MigrationAccount` (interface), `MigrationAccountWithSecretKey`, `SignerlessMigrationAccount`
- `MigrationBaseWallet`, `MigrationEmbeddedWallet`
- `NodeMigrationEmbeddedWallet` (from `aztec-state-migration/wallet/entrypoints/node`)
- `BrowserMigrationEmbeddedWallet` (from `aztec-state-migration/wallet/entrypoints/browser`)

### Mode-A Sub-module (`aztec-state-migration/mode-a/`)

- `MigrationNote`, `MigrationNoteProofData` (type), `buildMigrationNoteProof`

### Mode-B Sub-module (`aztec-state-migration/mode-b/`)

- `FullProofData` (type), `NonNullificationProofData` (type), `PublicDataSlotProof` (type), `PublicDataProof` (type)
- `KeyNote`
- `buildPublicDataSlotProof`, `buildPublicDataProof`, `buildPublicMapDataProof`

### NOT Re-exported (Import Directly)

- `UintNote`, `FieldNote` from `ts/aztec-state-migration/common-notes.ts`
- `MigrationSignature` from `ts/aztec-state-migration/types.ts` (returned by signing helpers; not independently re-exported)

## Common Pitfalls and Utilities

### Common Note Decoders

`ts/aztec-state-migration/common-notes.ts` provides `UintNote` and `FieldNote` decoder callbacks used as `noteMapper` parameters in proof-building functions:

```typescript
import { UintNote } from "aztec-state-migration/common-notes";

const proofs = await wallet.buildFullNoteProofs(blockNumber, notes, UintNote.fromNote);
```

- `UintNote.fromNote(note)` -- Decodes `note.items[0]` as a `bigint`.
- `FieldNote.fromNote(note)` -- Decodes `note.items[0]` as an `Fr`.

These are NOT re-exported from any `index.ts`; import directly from `common-notes.ts`.

### blockHeaderToNoir

`blockHeaderToNoir(header)` converts an L2 `BlockHeader` to the Noir-compatible struct format with snake_case keys. This is used internally by `buildArchiveProof` and `buildBlockHeader`, but is also available for direct use when constructing custom transaction payloads.

### poll and onPoll

The `poll(opts)` utility repeatedly calls a `check()` function until it returns a non-`undefined` value. The optional `onPoll` callback fires after each unsuccessful check -- commonly used to trigger block production in test environments.

### buildNullifierProof (NOT Exported)

`buildNullifierProof` is NOT exported from `mode-b/`'s public API. Integrators should use `MigrationBaseWallet.buildFullNoteProofs()` (or `buildNullifierProofs()`), which internally calls `buildNullifierProof` for each note.

### migrateArchiveRootAtBlock (No TS Wrapper)

The Solidity function `migrateArchiveRootAtBlock(uint256 oldVersion, uint256 blockNumber, DataStructures.L2Actor calldata l2Migrator)` has no TS wrapper in `bridge.ts`. Only `migrateArchiveRoot` (latest proven block) is wrapped. Integrators needing historical block bridging must call the Solidity contract directly via viem or ethers.

### On-Curve Assertion

`register()` (in `MigrationKeyRegistry`) and `lock_migration_notes()` (in `aztec-state-migration/src/mode_a/ops.nr`) include an on-curve assertion (`y^2 = x^3 - 17`) for Grumpkin points. If an invalid key is provided, the transaction will revert with `"mpk not on Grumpkin curve"`. Ensure the migration public key is a valid Grumpkin point before calling these functions.

### MIGRATION_DATA_FIELD_INDEX

`MIGRATION_DATA_FIELD_INDEX = 5` is defined in `ts/aztec-state-migration/constants.ts`. This refers to the index of `migration_data_hash` in the **serialized** `note.items` array produced by `#[derive(Serialize)]`, where `EmbeddedCurvePoint` (`mpk`) expands into three fields (`x`, `y`, `is_infinite`):

```
Serialized note.items:
[note_creator, mpk.x, mpk.y, mpk.is_infinite, destination_rollup, migration_data_hash]
 index 0       1      2       3                 4                   5
```

This is a different layout from the `compute_note_hash()` preimage, which omits `is_infinite` and appends `storage_slot` and `randomness`:

```
Hash preimage:
[note_creator, mpk.x, mpk.y, destination_rollup, migration_data_hash, storage_slot, randomness]
 index 0       1      2       3                   4                    5             6
```

The constant value `5` is correct for the serialized array. It is not currently used in active code but is available for integrators who need to access `migration_data_hash` from a raw `note.items` array.

## Deployment Checklist

Before running a migration, the following deployment steps are required:

1. **Set `old_rollup_app_address`:** Configure the old rollup's app contract address in the new rollup's app contract via the constructor. Incorrect configuration results in silent migration failures (see [threat model](threat-model.md)).

2. **Deploy `MigrationArchiveRegistry`:** The constructor requires:
   - `l1_migrator: EthAddress` -- Address of the `Migrator.sol` contract on L1.
   - `old_rollup_version: Field` -- Version identifier of the old rollup (read from `block_header.global_variables.version`).
   - `old_key_registry: AztecAddress` -- Address of the `MigrationKeyRegistry` on the old rollup (Mode B only, used for key note siloing via `get_old_key_registry()`).

3. **Bridge first archive root:** Call `migrateArchiveRootOnL1(...)` to bridge the old rollup's proven archive root to the new rollup via L1. Then wait for the L1-to-L2 message to sync (`waitForL1ToL2Message`). The new rollup's `MigrationArchiveRegistry` must have a registered block before any migration transactions can succeed.

## See Also

- [Migration Specification](spec/migration-spec.md) -- Proof data type field details, API tables
- [Mode A](mode-a.md) -- Cooperative lock-and-claim migration flow
- [Mode B](mode-b.md) -- Emergency snapshot migration flow (private and public)
- [Operations](operations.md) -- Testing, setup, troubleshooting
