---
layout: default
title: Integration Guide
---

[← Home](index.md)

# Integration Guide

## Overview

The migration system is organized into three layers:

1. **Noir `migration_lib`** -- Core verification logic: proof verification, nullifier emission, signature checking. This is a library, not a contract.
2. **App contracts** (e.g. `ExampleMigrationApp`) -- Wrappers that call library functions and handle app-specific state (minting, balance updates).
3. **TS `migration-lib`** -- Client-side proof building, key derivation, transaction construction.

Integrators typically work at layers 2 and 3: writing an app contract that calls into `migration_lib`, and using the TS client library to build proofs and submit transactions. This guide covers the TS client layer and the proof data types that bridge Noir and TypeScript.

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
| `MigrationKeyNote` | `migration_key_registry/migration_key_note.nr` | `mpk: Point` | Used by `MigrationKeyRegistry`. TS counterpart is `KeyNote` (from `mode-b/types.ts`), which has a different representation (`mpk` is expanded into `{ x, y, is_infinite }`). |
| `MigrationDataEvent<T>` | `mode_a/migration_data_event.nr` | `migration_data: T` | Emitted by `lock_migration_notes`. No dedicated TS type -- events are decoded via the general event decoding mechanism. Integrators receive raw event data, not a typed `MigrationDataEvent<T>`. |
| `MigrationSignature` | `signature.nr` | `bytes: [u8; 64]` | Accepted by all `migrate_*` functions. TS counterpart is `MigrationSignature` interface in `ts/migration-lib/types.ts`. NOT re-exported from top-level `index.ts`. |

### Noir-to-TS Type Mapping

| Noir Type | Noir File | TS Type | TS File | Re-exported from `index.ts`? |
|-----------|-----------|---------|---------|------------------------------|
| `NoteProofData<T>` | `note_proof_data.nr` | `NoteProofData<Note>` | `ts/migration-lib/types.ts` | Yes |
| `MigrationNoteProofData<MigrationData>` | `mode_a/mod.nr` (alias) | `MigrationNoteProofData<T>` | `ts/migration-lib/mode-a/index.ts` | No (import from `mode-a/`) |
| `FullNoteProofData<Note>` | `mode_b/mod.nr` | `FullProofData<Note>` | `ts/migration-lib/mode-b/types.ts` | No (import from `mode-b/`) |
| `NonNullificationProofData` | `mode_b/non_nullification_proof_data.nr` | `NonNullificationProofData` | `ts/migration-lib/mode-b/types.ts` | No (import from `mode-b/`) |
| `PublicStateProofData<T, N>` | `mode_b/public_state_proof_data.nr` | `PublicDataProof<T>` | `ts/migration-lib/mode-b/types.ts` | No (import from `mode-b/`) |
| `PublicStateSlotProofData` | `mode_b/public_state_proof_data.nr` | `PublicDataSlotProof` | `ts/migration-lib/mode-b/types.ts` | No (import from `mode-b/`) |
| `KeyNoteProofData` (alias) | `mode_b/` | `NoteProofData<KeyNote>` | `ts/migration-lib/mode-b/types.ts` | No (`KeyNote` from `mode-b/`) |
| `MigrationKeyNote` | `migration_key_note.nr` | `KeyNote` | `ts/migration-lib/mode-b/types.ts` | No (import from `mode-b/`) |
| `MigrationNote` | `mode_a/migration_note.nr` | `MigrationNote` | `ts/migration-lib/mode-a/index.ts` | No (import from `mode-a/`) |
| `MigrationSignature` | `signature.nr` | `MigrationSignature` | `ts/migration-lib/types.ts` | No (internal use) |
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
4. **Build block header:** `buildArchiveProof(node, blockNumber)` or `buildBlockHeader(node, blockNumber)` produces the Noir-compatible block header for archive verification.
5. **Submit transaction** to the new rollup's app contract.

**Retrieving encrypted events:** `BaseMigrationWallet.getMigrationDataEvents(abiType, eventFilter)` retrieves encrypted `MigrationDataEvent` data emitted during the lock step. The method filters on the `MigrationDataEvent` event selector and decodes the event payload using the provided ABI type.

> **TODO (FIXME):** `getMigrationNotes()` currently returns ALL migration notes including already-migrated ones. Filtering for un-migrated notes should be added. *(Source: `migration-base-wallet.ts:179`)*

## TS Client Data Flow -- Mode B (Private)

The Mode B (emergency snapshot) private note migration flow:

1. **Derive migration key:** `deriveMasterMigrationSecretKey(secretKey)` -- same as Mode A.
2. **Sign the claim message:** `signMigrationModeB(signer, oldRollupVersion, newRollupVersion, notes, recipient, newAppAddress)` produces a `MigrationSignature` over `poseidon2_hash([CLAIM_DOMAIN_B, oldVersion, newVersion, notesHash, recipient, newApp])`.
3. **Build note proofs:** Use `BaseMigrationWallet.buildFullNoteProofs(blockNumber, notes, noteMapper)` to construct combined inclusion and non-nullification proofs (`FullProofData<Note>`). This internally calls `buildNoteProof` + `buildNullifierProof` for each note.
4. **Build archive proof:** `buildArchiveProof(node, blockNumber)` -- same as Mode A.
5. **Submit transaction** to the new rollup's app contract.

Mode-B types are NOT re-exported from the top-level `index.ts`. Import them directly:

```typescript
import {
  FullProofData,
  NonNullificationProofData,
  PublicDataSlotProof,
  PublicDataProof,
  KeyNote,
} from "migration-lib/mode-b";
```

## TS Client Data Flow -- Mode B (Public)

Public state migration uses a separate set of proof builders:

1. **Build public data proofs:**
   - `buildPublicDataProof(node, blockNumber, data, contractAddress, baseSlot, dataAbiType)` -- For standalone `PublicMutable<T>` values. Automatically determines the number of packed slots from the ABI type.
   - `buildPublicMapDataProof(node, blockNumber, data, contractAddress, baseSlot, mapKeys, dataAbiType)` -- For values inside `Map` storage. Derives the storage slot from `baseSlot` and `mapKeys` via `poseidon2_hash([slot, key])` for each nesting level.
   - `buildPublicDataSlotProof(node, blockNumber, contractAddress, storageSlot)` -- Low-level single-slot proof builder.

2. **Sign for owned entries:** `signPublicStateMigrationModeB(signer, oldRollupVersion, newRollupVersion, data, abiType, recipient, newAppAddress)` produces a `MigrationSignature` over `poseidon2_hash([CLAIM_DOMAIN_B_PUBLIC, oldVersion, newVersion, dataHash, recipient, newApp])` where `dataHash = poseidon2_hash(pack(data))`.

3. **Submit transaction** to the new rollup's app contract.

## Wallet and Account Classes

The migration library provides two separate inheritance chains for managing accounts and constructing proofs.

### Account Hierarchy (Authentication Layer)

The account classes handle signing and key access:

- **`MigrationAccount`** (interface) -- Extends `Account` with `getMigrationPublicKey()`, `migrationKeySigner(msg)`, `getMaskedNsk(newRollupAccount, contractAddress)`, and `getPublicKeys()`.
- **`BaseMigrationAccount`** (class, extends `BaseAccount`) -- Default implementation that derives and stores all migration keys in memory. Use `BaseMigrationAccount.create(account, secret)` to construct. Suitable for testing; production wallets should protect key material.
- **`SignerlessMigrationAccount`** (class, extends `SignerlessAccount`) -- Placeholder for fee-less transactions using `AztecAddress.ZERO`. All signing methods throw. Used for public-only operations that do not require authentication.

> **TODO:** `BaseMigrationAccount.getMask()` returns `Fq.ZERO` (masking is not functional). The mask is intended to be a Poseidon2-based derivation but is currently stubbed out. *(Source: `migration-account.ts:132-140`)*

> **TODO:** `SignerlessMigrationAccount.getEnryptedNskApp()` has a typo in the method name (`Enrypted` instead of `Encrypted`). *(Source: `migration-account.ts:167`)*

### Wallet Hierarchy (State and Proof Building)

The wallet classes handle proof construction and note management:

- **`BaseMigrationWallet`** (abstract, extends `BaseWallet`) -- Contains the core proof-building and signing methods. Subclasses must implement `getMigrationPublicKey(account)` and `getPublicKeys(account)`.
- **`MigrationTestBaseWallet`** (extends `BaseMigrationWallet`) -- Adds test infrastructure (in-memory account registry, account creation helpers). NOT re-exported from top-level `index.ts`.
- **`MigrationTestWallet`** (extends `MigrationTestBaseWallet`) -- Adds PXE creation and account deployment helpers (`createSchnorrAccount`, `createECDSARAccount`, `createECDSAKAccount`). Creates its own PXE instance via `MigrationTestWallet.create(node)`.

**Key methods on `BaseMigrationWallet`:**
- `buildFullNoteProofs(blockNumber, notes, noteMapper)` -- Build complete note proofs (inclusion + non-nullification) for Mode B private migration.
- `buildKeyNoteProofData(keyRegistry, owner, blockNumber)` -- Build proof data for the migration key note from the old rollup's key registry.
- `getMigrationDataEvents(abiType, eventFilter)` -- Retrieve encrypted migration data events from Mode A lock transactions.
- `buildMigrationNoteProofs(blockNumber, migrationNotes, migrationDataEvents)` -- Build note proofs for Mode A claim transactions, pairing each note with its corresponding event data.

These methods combine multiple lower-level proof-building functions into workflow-oriented APIs. Integrators should prefer these over calling `buildNoteProof`, `buildNullifierProof`, etc. directly.

## Key Derivation

The master migration secret key (MSK) is derived from the account's secret key:

```
msk = sha512ToGrumpkinScalar([secretKey, MSK_M_GEN])
```

The migration public key (MPK) is the corresponding Grumpkin curve point.

**Constants** (defined only in TS `constants.ts` -- key derivation is entirely TS-side):
- `MSK_M_GEN = 2137` -- Domain separator for MSK derivation.
- `NSK_MASK_DOMAIN = 1670` (vestigial -- defined in `constants.ts` but only referenced in a commented-out line at `migration-account.ts:137`; related to the non-functional `getMask()` documented above).

> **TODO:** TS constants should be generated from the same source as Noir constants to prevent drift. Currently the TS file (`constants.ts`) and the Noir file (`constants.nr`) are maintained independently with no cross-validation. *(Source: `constants.ts:1`)*

## Import Patterns

### Top-Level Re-exports (`migration-lib`)

The top-level `index.ts` re-exports the following:

- **Wallet:** `BaseMigrationWallet`, `MigrationTestWallet`, `BaseMigrationAccount`, `SignerlessMigrationAccount`, `MigrationAccount` (type)
- **Keys:** `deriveMasterMigrationSecretKey`, `signMigrationModeA`, `signMigrationModeB`, `signPublicStateMigrationModeB`
- **Proofs:** `buildNoteProof`, `buildArchiveProof`, `buildBlockHeader`
- **Bridge:** `waitForBlockProof`, `migrateArchiveRootOnL1`, `waitForL1ToL2Message`
- **Constants:** All from `constants.ts` (re-exported via `export *`)
- **Noir helpers:** `blockHeaderToNoir` (via `noir-helpers/index.ts`)
- **Polling:** `poll`, `PollOptions` (type)
- **Types:** `NoteProofData` (type), `ArchiveProofData` (type), `L1MigrationResult` (type)

### Mode-A Sub-module (`migration-lib/mode-a/`)

- `MigrationNote`, `MigrationNoteProofData` (type), `buildMigrationNoteProof`

### Mode-B Sub-module (`migration-lib/mode-b/`)

- `FullProofData` (type), `NonNullificationProofData` (type), `PublicDataSlotProof` (type), `PublicDataProof` (type)
- `KeyNote`
- `buildPublicDataSlotProof`, `buildPublicDataProof`, `buildPublicMapDataProof`

### NOT Re-exported (Import Directly)

- `UintNote`, `FieldNote` from `ts/migration-lib/common-notes.ts`
- `MigrationTestBaseWallet` from `ts/migration-lib/wallet/migration-test-base-wallet.ts`
- `MigrationSignature` from `ts/migration-lib/types.ts` (internal use)

## Common Pitfalls and Utilities

### Common Note Decoders

`ts/migration-lib/common-notes.ts` provides `UintNote` and `FieldNote` decoder callbacks used as `noteMapper` parameters in proof-building functions:

```typescript
import { UintNote } from "migration-lib/common-notes";

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

`buildNullifierProof` is NOT exported from `mode-b/`'s public API. Integrators should use `BaseMigrationWallet.buildFullNoteProofs()` (or `buildNullifierProofs()`), which internally calls `buildNullifierProof` for each note.

### migrateArchiveRootAtBlock (No TS Wrapper)

The Solidity function `migrateArchiveRootAtBlock(uint256 oldVersion, uint256 blockNumber, DataStructures.L2Actor calldata l2Migrator)` has no TS wrapper in `bridge.ts`. Only `migrateArchiveRoot` (latest proven block) is wrapped. Integrators needing historical block bridging must call the Solidity contract directly via viem or ethers.

### On-Curve Assertion

`register()` (in `MigrationKeyRegistry`) and `lock_migration_notes()` (in `migration_lib/mode_a/ops.nr`) include an on-curve assertion (`y^2 = x^3 - 17`) for Grumpkin points. If an invalid key is provided, the transaction will revert with `"mpk not on Grumpkin curve"`. Ensure the migration public key is a valid Grumpkin point before calling these functions.

### MIGRATION_DATA_FIELD_INDEX Discrepancy

`MIGRATION_DATA_FIELD_INDEX = 5` is defined in `ts/migration-lib/constants.ts:32`. The JSDoc says "Zero-based index of the `migration_data` field inside a `MigrationNote`" but the value `5` corresponds to `storage_slot` in the `MigrationNote.compute_note_hash()` preimage ordering:

```
[note_creator, mpk.x, mpk.y, destination_rollup, migration_data_hash, storage_slot, randomness]
 index 0       1      2       3                   4                    5             6
```

The constant `migration_data_hash` is at index 4, not 5. This constant is not used in active code and may be vestigial or may refer to a different field layout than the hash preimage.

## Deployment Checklist

Before running a migration, the following deployment steps are required:

1. **Set `old_app_address`:** Configure the old rollup's app contract address in the new rollup's app contract. This is an unchecked witness -- incorrect deployment results in silent failure (see [threat model](threat-model.md)).

2. **Deploy `MigrationArchiveRegistry`:** The constructor requires:
   - `l1_migrator: EthAddress` -- Address of the `Migrator.sol` contract on L1.
   - `old_rollup_version: Field` -- Version identifier of the old rollup (read from `block_header.global_variables.version`).
   - `old_key_registry: AztecAddress` -- Address of the `MigrationKeyRegistry` on the old rollup (Mode B only, used for key note siloing via `get_old_key_registry()`).

3. **Bridge first archive root:** Call `migrateArchiveRootOnL1(...)` to bridge the old rollup's proven archive root to the new rollup via L1. Then wait for the L1-to-L2 message to sync (`waitForL1ToL2Message`). The new rollup's `MigrationArchiveRegistry` must have a registered block before any migration transactions can succeed.

## Related Documents

- [Documentation Index](index.md) -- Entry point and documentation map
- [Migration Spec](spec/migration-spec.md) -- Protocol specification including proof data type field details
- [Architecture](architecture.md) -- System overview, deployment topology, three-layer composition
- [Mode A](mode-a.md) -- Cooperative lock-and-claim migration flows
- [Mode B](mode-b.md) -- Emergency snapshot migration flows (private and public)
- [Threat Model](threat-model.md) -- Trust assumptions, PoC limitations, security TODOs
