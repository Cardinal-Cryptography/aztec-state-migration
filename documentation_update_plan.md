# Documentation Update Plan

> **Generated:** 2026-02-21 (3 iterations of 7-agent analysis + synthesis)
> **Revised:** 2026-02-21 — Section 13 added (post-review improvements from 3 additional rounds of 7-agent analysis)
> **Supersedes:** Previous plan dated 2026-02-20
> **Source:** 6 total rounds of 7 independent code/doc analyses against commit `b63d294` (HEAD of `docs-rewrite` branch), each round verifying and correcting the previous
> **Scope:** Documentation changes only. NO code changes are planned in this document.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Key Decisions and Corrections](#2-key-decisions-and-corrections)
3. [Target File Structure](#3-target-file-structure)
4. [File-by-File Specifications](#4-file-by-file-specifications)
5. [Spec Updates (migration-spec.md)](#5-spec-updates)
6. [TODO/FIXME Inventory](#6-todofixme-inventory)
7. [Noir-to-TypeScript Type Mapping](#7-noir-to-typescript-type-mapping)
8. [Canonical Terminology Table](#8-canonical-terminology-table)
9. [CLAUDE.md Updates](#9-claudemd-updates)
10. [File Deletion and Archival Plan](#10-file-deletion-and-archival-plan)
11. [Writing Order and Dependencies](#11-writing-order-and-dependencies)
12. [Quality Standards and Verification](#12-quality-standards-and-verification)
13. [Improvements from Post-Review Analysis](#13-improvements-from-post-review-analysis)
14. [Appendix A: Content Sourcing Maps](#appendix-a-content-sourcing-maps)
15. [Appendix B: Open Decision Handling](#appendix-b-open-decision-handling)

---

## 1. Executive Summary

The documentation for the Aztec dual-rollup migration project has critical gaps: 4 stub files containing only "TODO", 1 substantive file to absorb and delete, 7 files referenced from CLAUDE.md that do not exist, 4 empty directories, a spec with multiple inaccuracies, and 12 code TODOs/FIXMEs that must be surfaced. Zero items from `inconsistencies.md` have been resolved.

This plan reorganizes all documentation into an **8-file structure** (down from the previous 15-file plan that was too granular, and better than a 5-file plan that would produce oversized files). The structure separates audiences (newcomers, protocol engineers, integrators, operators) while keeping each file between 60-450 lines.

**Key numbers:**
- 7 documentation files to create or rewrite
- 1 file to significantly update in place (`migration-spec.md`)
- 1 meta file to update (`CLAUDE.md`)
- 12 code TODOs/FIXMEs to surface as doc callouts
- 5 files to delete (4 stubs + 1 substantive file absorbed into new structure)
- 2 TODO files to archive
- 4 empty directories to remove

> **Note:** `docs/index.md` is counted as one of the 7 documentation files above, not separately. The 7 + 1 update = 8 files in Section 3.1.

**Critical correction from previous plan:** The nullifier formula for Mode B public state (`OD-1`) is a **NON-ISSUE**. The code already implements the correct 2-field formula `poseidon2_hash_with_separator([old_app.to_field(), base_storage_slot], GENERATOR_INDEX__PUBLIC_MIGRATION_NULLIFIER)`, and the spec text at line 294 already says `[old_app, storage_slot]`. The previous plan incorrectly claimed there was a code-spec mismatch. The `inconsistencies.md` item OD-1 references stale code (the 1-field version was already fixed).

---

## 2. Key Decisions and Corrections

### 2.1 Decisions Already Made

| ID | Decision | Rationale |
|----|----------|-----------|
| D-1 | NFTs are **out of scope** for documentation | `NftMigrationApp` code exists but docs focus on the `ExampleMigrationApp` (fungible token) pattern. A brief note acknowledges NFT code exists. |
| D-2 | Nullifier formula is `[old_app, base_storage_slot]` (2 fields) | Code at `public_state_proof_data.nr:93-94` already implements this correctly. Spec line 294 matches. No code change needed. |
| D-3 | OD-4 resolved: **Merge** Mode B docs into one file | `mode-b-architecture.md` (231 lines of irreplaceable content) becomes the base for the merged `mode-b.md`. The old `mode-b-details.md` stub is deleted. |
| D-4 | All code TODOs/FIXMEs surfaced as `> **TODO:**` callouts | 12 items from source code mapped to specific doc files (see Section 6). |

### 2.2 Corrections to Previous Plan

| Item | Previous Plan Said | Correct Statement |
|------|-------------------|-------------------|
| OD-1 nullifier | "Code does 1-field hash, spec says 3-field" -- marked BLOCKED | Code already does 2-field `[old_app, base_storage_slot]`. Spec says `[old_app, storage_slot]`. These **match**. NOT blocked. |
| `NoteProofData` fields | Listed as `note, nonce, note_hash_sibling_path, note_index` | Actual fields: `data: T`, `randomness: Field`, `nonce: Field`, `leaf_index: Field`, `sibling_path: [Field; NOTE_HASH_TREE_HEIGHT]` |
| `NonNullificationProofData` fields | Listed as `low_leaf, low_leaf_index, low_leaf_sibling_path` | Actual fields: `low_nullifier_value`, `low_nullifier_next_value`, `low_nullifier_next_index`, `low_nullifier_leaf_index`, `low_nullifier_sibling_path` |
| `PublicStateSlotProofData` fields | Listed as `value, sibling_path, leaf_index` | Actual fields: `next_slot`, `next_index`, `leaf_index`, `sibling_path` (no `value` field -- the value comes from `data.pack()` in the parent struct) |
| `migrateArchiveRoot()` params | Listed as "(none)" | Actual params: `uint256 oldVersion, DataStructures.L2Actor calldata l2Migrator` |
| `migrateArchiveRootAtBlock()` params | Listed as `blockNumber` | Actual params: `uint256 oldVersion, uint256 blockNumber, DataStructures.L2Actor calldata l2Migrator` |
| mode-b-architecture.md line 165 | Shows 3-field public nullifier: `[old_app, storage_slot, field_index]` | Code uses 2-field: `[old_app.to_field(), base_storage_slot]`. The doc `mode-b-architecture.md` line 165 needs updating, but the **spec** is already correct. |
| `old_rollup_id` location | Spec says TokenV2 stores it | Code reads dynamically from `block_header.global_variables.version`. `MigrationArchiveRegistry` stores `old_rollup_version` for L1 message verification, not TokenV2. |
| Spec "L1Migrator" | Appears in architecture diagram as `L1Migrator` | Solidity contract is named `Migrator` (no `L1` prefix in the contract name itself, though it runs on L1). |
| Mode-B exports | Previous plan didn't note | Mode-B types/functions are NOT re-exported from top-level `index.ts`. Must import from `./mode-b/` directly. |

### 2.3 Items Confirmed as Non-Issues

| Item | Why It Is Not an Issue |
|------|----------------------|
| OD-1 (nullifier formula) | Code and spec already agree on 2-field `[old_app, storage_slot]` |
| OD-2 (rollup IDs) | Demoted to ARCH-DYN long ago; only spec text update needed |
| ARCH-NEW-2 (TODO_MODE_B item 7) | Code already uses `PrivateImmutable` with `initialize()` |

---

## 3. Target File Structure

### 3.1 New Layout

```
docs/
  index.md                     # ~60 lines  -- Entry point, absorbs problem-and-solution scope note + NFT out-of-scope note
  spec/
    migration-spec.md          # ~450 lines -- Keep in place, update (9+ changes)
  architecture.md              # ~130 lines -- System overview, L1/L2 topology, component map
  mode-a.md                    # ~180 lines -- Mode A flows, authentication, limitations
  mode-b.md                    # ~310 lines -- Absorbs mode-b-architecture.md, adds public state details
  integration-guide.md         # ~320 lines -- TS SDK, wallet classes, API reference, proof types
  threat-model.md              # ~100 lines -- Trust assumptions, PoC limitations, security TODOs
  operations.md                # ~150 lines -- Testing, setup, troubleshooting, Solidity build notes, version info
```

**Total: 8 files, ~1,700 lines estimated.**

### 3.2 Why This Structure

| Alternative | Problem |
|-------------|---------|
| Previous 15-file plan | 6 files would be under 30 lines; `docs/solidity/overview.md`, `docs/ops/deploy.md`, and `docs/ops/troubleshooting.md` would be trivially small. Separate `arch/overview.md`, `arch/flows.md`, `arch/threat-model.md` fragments the architecture across too many tiny files. |
| 5-file plan | A monolithic `architecture.md` at 360-510 lines mixes system overview with detailed flows. No separate place for operational concerns. |
| 8-file plan (this plan) | Each file has a clear audience and stays between 60-450 lines. Operations content is consolidated. Architecture is a concise system map. Mode details are self-contained. |

### 3.3 File-to-Audience Map

| File | Primary Audience | Secondary Audience |
|------|-----------------|-------------------|
| `index.md` | Everyone (entry point) | -- |
| `spec/migration-spec.md` | Protocol engineers, auditors | App developers |
| `architecture.md` | Protocol engineers | Newcomers seeking overview |
| `mode-a.md` | App developers, auditors | Protocol engineers |
| `mode-b.md` | App developers, auditors | Protocol engineers |
| `integration-guide.md` | App developers | Wallet developers |
| `threat-model.md` | Auditors, security engineers | Protocol engineers |
| `operations.md` | Developers running tests locally | CI/CD engineers |

### 3.4 Migration from Old to New Structure

| Old File | Action | New Location |
|----------|--------|-------------|
| `docs/index.md` | **Rewrite** | `docs/index.md` (expanded) |
| `docs/problem-and-solution.md` | **Delete** (content absorbed into `index.md`) | `docs/index.md` "Problem and Solution" section |
| `docs/mode-a-details.md` | **Delete** (stub replaced) | `docs/mode-a.md` |
| `docs/mode-b-details.md` | **Delete** (stub replaced) | `docs/mode-b.md` |
| `docs/mode-b-architecture.md` | **Delete** after merging content into `mode-b.md` | `docs/mode-b.md` (preserves all substantive content verbatim) |
| `docs/integration-guide.md` | **Delete** (stub replaced) | `docs/integration-guide.md` (rewritten) |
| `docs/non-native-assets.md` | **Delete** (2 lines absorbed into `index.md` scope section) | `docs/index.md` "Scope" subsection |
| `docs/spec/migration-spec.md` | **Update in place** | `docs/spec/migration-spec.md` |
| `docs/arch/` (empty dir) | **Remove directory** | Content in `docs/architecture.md` and `docs/threat-model.md` |
| `docs/ops/` (empty dir) | **Remove directory** | Content in `docs/operations.md` |
| `docs/solidity/` (empty dir) | **Remove directory** | Solidity content split: protocol behavior in `spec/migration-spec.md`, build/test details in `docs/operations.md` |
| `docs/claude/` (empty dir) | **Remove directory** | Not needed |
| `TODO_MODE_A.md` | **Archive** (add header, retain for git history) | Content harvested into `mode-a.md`, `integration-guide.md`, `threat-model.md`, `architecture.md` |
| `TODO_MODE_B.md` | **Archive** (add header, fix item 7) | Content harvested into `mode-b.md`, `integration-guide.md`, `threat-model.md`, `architecture.md` |

---

## 4. File-by-File Specifications

> **Reading guide for content sources:** Percentages after source items indicate how much of that source's content should be harvested into the target section. For example, "`TODO_MODE_A.md` item 1 (80%)" means approximately 80% of item 1's text is relevant and should be adapted into the destination. The "Estimated" line at the end of each file spec (e.g., "~65% from existing, 35% original writing") indicates the overall ratio of harvested-vs-new content for the entire file.

> **Verbatim preservation rule (applies to `mode-b.md`):** "Verbatim" means no rewording of prose, formulas, or diagrams from `mode-b-architecture.md` UNLESS this plan explicitly marks a correction (e.g., Section 4.4 item 10 corrects the public nullifier formula). When merging TODO_MODE_B.md content, the TODO content adds material around the existing text; it does not replace it unless a correction is noted.

### 4.1 `docs/index.md` (~60 lines)

**Purpose:** Single entry point. Replaces both current `index.md` and absorbs `problem-and-solution.md` + `non-native-assets.md` scope note.

**Sections:**
1. **Title:** "Aztec Dual-Rollup Migration"
2. **Problem statement** (3-4 sentences): Aztec version upgrades create new rollup instances; user state is stranded; privacy constraints prevent simple export.
3. **Solution overview** (1 paragraph): Two migration modes anchored by L1 archive roots. Mode A (cooperative, lock-and-claim), Mode B (emergency snapshot).
4. **Scope note:** Native application state only. L1-bridged assets are out of scope (brief explanation of why: bridge custody model requires coordination with the bridge protocol).
5. **NFT note:** `NftMigrationApp` code exists in the repo and implements Mode A + Mode B for NFTs, but documentation focuses on the fungible token `ExampleMigrationApp` pattern. The same library functions generalize to NFTs.
6. **Documentation map:** Links to all 7 other docs with 1-line descriptions.
7. **Quick links:** Spec, architecture diagram, getting started (operations.md).

**Content sources:** `migration-spec.md` overview (lines 8-19), `problem-and-solution.md` stub outline, `non-native-assets.md` stub outline.

**Estimated: ~40% from existing, 60% original writing.**

### 4.2 `docs/architecture.md` (~130 lines)

**Purpose:** System-level overview. Components, their relationships, deployment topology. Does NOT go deep into mode-specific flows (those are in `mode-a.md` and `mode-b.md`).

**Sections:**
1. **Deployment topology diagram** (ASCII): Old Rollup L2 / L1 / New Rollup L2 with all contracts placed.
2. **Component catalog:**
   - Noir `migration_lib` (library, not a contract): `mode_a/ops`, `mode_b/ops`, shared modules
   - App contracts: `ExampleMigrationApp` (token), `NftMigrationApp` (NFT, out of doc scope)
   - `MigrationArchiveRegistry` (new rollup, singleton, shared by all apps)
   - `MigrationKeyRegistry` (old rollup, Mode B only)
   - `Migrator.sol` (L1, permissionless archive root bridge)
3. **Three-layer composition pattern:**
   - Layer 1: Noir `migration_lib` -- core verification logic (proof verification, nullifier emission, signature checking)
   - Layer 2: App contracts -- wrappers that call library functions, handle app-specific state (minting, balance updates)
   - Layer 3: TS `migration-lib` -- client-side proof building, key derivation, transaction construction
4. **L1-L2 bridge flow** (brief): `Migrator.sol` reads old rollup's proven archive root, poseidon2 hashes content, sends L1-to-L2 message, `MigrationArchiveRegistry` consumes and verifies.
5. **Cross-context configuration:** Why `PublicImmutable` is used (deployment-time config readable in both private and public contexts via `WithHash::historical_public_storage_read`).
6. **Related Documents**

**Three-layer composition overlap with `integration-guide.md`:** `architecture.md` describes the three layers at a system level (what each layer is responsible for, how they connect). `integration-guide.md` describes the same layers from a developer perspective (how to use each layer, concrete API calls). The split is: architecture = "what and why"; integration-guide = "how to use".

**Content sources:** `migration-spec.md` "Architecture" (lines 34-48), `mode-b-architecture.md` "Library Architecture" (lines 23-32) and "PublicImmutable" (lines 196-204), `TODO_MODE_A.md` item 10, `TODO_MODE_B.md` item 8.

**Estimated: ~55% from existing, 45% original writing.**

### 4.3 `docs/mode-a.md` (~180 lines)

**Purpose:** Complete Mode A documentation. Lock flow, claim flow, authentication, limitations.

**Sections:**
1. **Overview:** Cooperative migration when old rollup is live.
2. **Lock flow (library level):**
   - `lock_migration_notes` creates `MigrationNote` and emits encrypted `MigrationDataEvent`
   - `MigrationNote` stores `migration_data_hash` (poseidon2 hash of packed original data)
   - Event uses `emit_event_in_private` + `deliver_to` for AES128 ECDH encryption
   - Manual `EventInterface` implementation (generic `#[event]` macro not supported)
   > **TODO:** Consider including a note-identifying hash in the event (e.g., `migration_note_hash`) so wallet clients can match events to notes without relying on `txHash` filtering. The full note hash requires randomness from `create_note`, which is not easily accessible at event emission time. *(Source: `migration_data_event.nr:13`)*
3. **Claim flow (library level):**
   - `migrate_notes_mode_a`: verify `MigrationNote` inclusion, emit nullifier per note, check Schnorr signature, enqueue block hash verification
   - Two-step archive verification: (1) `register_block` verifies block header against consumed L1-bridged archive root; (2) `verify_migration_mode_a(block_number, block_hash)` checks stored value
4. **Public balance migration (app-level):**
   - `lock_public_for_migration` + `migrate_to_public_mode_a` are app-level wrappers
   > **TODO (FIXME):** `ExampleMigrationApp.migrate_mode_a` and `migrate_to_public_mode_a` have a redundant `amount` argument that duplicates `note_proof_data[0].data`. *(Source: `example_app/main.nr:203,239`)*
5. **Authentication:** Schnorr signature over `poseidon2(CLAIM_DOMAIN_A, old_rollup, new_rollup, notes_hash, recipient, new_app)`. MSK derived via `sha512ToGrumpkinScalar`.
   > **TODO:** `CLAIM_DOMAIN_A` currently reuses `MIGRATION_MODE_A_STORAGE_SLOT`. A distinct domain separator should be assigned. *(Source: `constants.nr:5`)*
6. **Nullifier derivation:** Uses `MigrationNote` randomness to prevent cross-rollup identity linking.
7. **Batching:** Library accepts `[MigrationNoteProofData; N]`. `ExampleApp` hardcodes N=1.
8. **PoC Limitations:**
   - No supply cap enforcement
   - `old_app_address` is an unchecked witness (see threat model)
   - L1 relay is permissionless (spam risk)
   - `ExampleMigrationApp` has no access control on `mint()`/`burn()` (intentional PoC simplification)
9. **Related Documents**

**Content sources:** `TODO_MODE_A.md` items 1 (80%), 2 (90%), 3 (70%), 5 (80%), 7 (90%), 8 (90%), 9 (70%), 10 (60%); `migration-spec.md` "Migration Nullifiers" (70%).

**Estimated: ~65% from existing, 35% original writing.**

### 4.4 `docs/mode-b.md` (~310 lines)

**Purpose:** Complete Mode B documentation. Absorbs ALL content from `mode-b-architecture.md` (preserving it verbatim where possible) plus public state details and key registry.

**CRITICAL:** The content of `mode-b-architecture.md` is irreplaceable and must be preserved. When absorbing, keep the prose, ASCII diagrams, formulas, and code blocks intact. Add new material around the existing content.

**Sections:**
1. **Overview** (from `mode-b-architecture.md` lines 14-21, verbatim)
2. **Library architecture** (from `mode-b-architecture.md` lines 23-32)
3. **Proof chain -- Private note migration** (from `mode-b-architecture.md` lines 38-49, verbatim ASCII diagram)
4. **Proof chain -- Public state migration** (from `mode-b-architecture.md` lines 56-63)
5. **Block hash trust anchor** (from `mode-b-architecture.md` lines 66-74)
6. **Block header binding** (from `mode-b-architecture.md` lines 77-81)
7. **Note hash computation** (from `mode-b-architecture.md` lines 84-109, verbatim formulas)
8. **Nullifier non-inclusion** (from `mode-b-architecture.md` lines 111-123)
9. **Authentication model** (from `mode-b-architecture.md` lines 125-150, merged with `TODO_MODE_B.md` item 1)
10. **Migration nullifier (double-claim prevention):**
    - Private notes: `poseidon2_hash_with_separator([unique_note_hash, randomness], GENERATOR_INDEX__NOTE_NULLIFIER)`
    - Public state: `poseidon2_hash_with_separator([old_app.to_field(), base_storage_slot], GENERATOR_INDEX__PUBLIC_MIGRATION_NULLIFIER)`
    - **Correction from `mode-b-architecture.md` line 165:** The public state nullifier uses 2 fields `[old_app, base_storage_slot]`, NOT 3 fields `[old_app, storage_slot, field_index]`. One nullifier is emitted per `PublicStateProofData` (per storage struct), not per individual field. This is because `base_storage_slot` uniquely identifies the struct, and all N fields occupy consecutive slots S through S+N-1.
    > **TODO:** `GENERATOR_INDEX__PUBLIC_MIGRATION_NULLIFIER` is a placeholder value `0x12345678`. A real Poseidon2-derived value must be assigned before production. *(Source: `constants.nr:15`)*
11. **Snapshot height** (from `mode-b-architecture.md` lines 170-181, merged with `TODO_MODE_B.md` item 5)
12. **Public state migration** (from `mode-b-architecture.md` lines 183-193, merged with `TODO_MODE_B.md` item 4):
    - `migrate_public_state_mode_b` -- standalone values
    - `migrate_public_map_state_mode_b` -- map-based (derives slot via `poseidon2_hash([slot, key])` chain)
    - `migrate_public_map_owned_state_mode_b` -- owned map entries (adds Schnorr + key note proof)
    > **TODO:** `CLAIM_DOMAIN_B_PUBLIC` is a placeholder value `0xdeafbeef`. A real domain separator must be assigned before production. *(Source: `constants.nr:12`)*
13. **Key registry:**
    - `MigrationKeyRegistry` uses `Owned<PrivateImmutable<MigrationKeyNote>>` with `initialize()` (the `Owned` wrapper provides per-user scoping via `.at(owner)`, and `PrivateImmutable` enforces write-once immutability)
    - Users register `mpk` before snapshot height H
    - Key note inclusion is siloed by the **old rollup's** key registry address (cross-rollup detail)
    - `get_old_key_registry()` on `MigrationArchiveRegistry` returns this address for siloing
    - `MigrationKeyRegistry.get()` view function returns the registered key note; returns `point_at_infinity` as sentinel value if no key is registered for the caller
14. **PublicImmutable for cross-context configuration** (from `mode-b-architecture.md` lines 196-204)
15. **PoC Limitations:**
    - No supply cap enforcement
    - Snapshot height governance has no access control beyond write-once
    - `ExampleMigrationApp` PoC simplifications (see Section 4.3 item 8)
16. **Test architecture** (from `mode-b-architecture.md` lines 206-232)
17. **Related Documents**

**Content sources:** `mode-b-architecture.md` (~90% preserved verbatim), `TODO_MODE_B.md` items 1 (85%), 2 (80%), 3 (done note), 4 (85%), 5 (85%), 6 (brief note), 7 (done note), 8 (done note).

**Estimated: ~75% from existing (primarily `mode-b-architecture.md`), 25% original writing.**

### 4.5 `docs/integration-guide.md` (~320 lines)

**Purpose:** Developer-facing guide for integrating migration into an app. Covers TS SDK, wallet classes, proof types, API reference.

**Sections:**
1. **Overview:** Three-layer architecture (Noir library, app contract, TS client).
2. **Proof data types** (with correct field names from code):

   **`NoteProofData<T>`** (`note_proof_data.nr`)
   - `data: T` -- The note preimage (generic)
   - `randomness: Field` -- Note randomness
   - `nonce: Field` -- Note nonce for unique hash computation
   - `leaf_index: Field` -- Leaf index in note hash tree
   - `sibling_path: [Field; NOTE_HASH_TREE_HEIGHT]` -- Merkle sibling path

   **`MigrationNoteProofData<MigrationData>`** (type alias in `mode_a/mod.nr`, line 11)
   - Type alias: `pub type MigrationNoteProofData<MigrationData> = NoteProofData<MigrationData>;`
   - This is NOT a struct. It is a type alias for `NoteProofData` parameterized with migration data.

   **`FullNoteProofData<Note>`** (`mode_b/mod.nr`, lines 20-23)
   - `note_proof_data: NoteProofData<Note>` -- Note inclusion proof
   - `non_nullification_proof_data: NonNullificationProofData` -- Non-nullification proof

   **`NonNullificationProofData`** (`mode_b/non_nullification_proof_data.nr`)
   - `low_nullifier_value: Field`
   - `low_nullifier_next_value: Field`
   - `low_nullifier_next_index: Field`
   - `low_nullifier_leaf_index: Field`
   - `low_nullifier_sibling_path: [Field; NULLIFIER_TREE_HEIGHT]`

   **`PublicStateSlotProofData`** (`mode_b/public_state_proof_data.nr`)
   - `next_slot: Field`
   - `next_index: Field`
   - `leaf_index: Field`
   - `sibling_path: [Field; PUBLIC_DATA_TREE_HEIGHT]`

   **`PublicStateProofData<T, N>`** (`mode_b/public_state_proof_data.nr`)
   - `data: T` -- The public state value
   - `slot_proof_data: [PublicStateSlotProofData; N]` -- One proof per packed field

   **`KeyNoteProofData`** (type alias: `NoteProofData<MigrationKeyNote>`)
   - Inclusion proof for the `MigrationKeyNote` in the old rollup's note hash tree

3. **Noir-to-TS type mapping table** (see Section 7 for full table; include inline here)
4. **TS client data flow -- Mode A:**
   - `deriveMasterMigrationSecretKey` -> `signMigrationModeA` -> `buildMigrationNoteProof` -> `buildArchiveProof` or `buildBlockHeader` -> submit transaction
   - `getMigrationDataEvents()` retrieves encrypted event data (method on `BaseMigrationWallet`)
   > **TODO (FIXME):** `getMigrationNotes()` currently returns ALL migration notes including already-migrated ones. Filtering for un-migrated notes should be added. *(Source: `migration-base-wallet.ts:179`)*
5. **TS client data flow -- Mode B (private):**
   - `deriveMasterMigrationSecretKey` -> `signMigrationModeB` -> `buildNoteProof` + `buildArchiveProof` -> submit
   - Note: Mode-B types must be imported from `./mode-b/` directly (NOT re-exported from top-level `index.ts`)
6. **TS client data flow -- Mode B (public):**
   - `buildPublicDataProof` / `buildPublicMapDataProof` / `buildPublicDataSlotProof`
   - `signPublicStateMigrationModeB` for owned entries
7. **Wallet and account classes:**

   **Account hierarchy** (authentication layer, extends `BaseAccount`/`SignerlessAccount`):
   - `MigrationAccount` interface (core migration capabilities)
   - `BaseMigrationAccount` class (base implementation, extends `BaseAccount`)
   - `SignerlessMigrationAccount` class (for public-only operations, extends `SignerlessAccount`)

   **Wallet hierarchy** (state and proof building, extends `BaseWallet`):
   - `BaseMigrationWallet` (abstract, contains `getMigrationNotes()`, `buildKeyNoteProofData()`, etc.)
   - `MigrationTestBaseWallet` (extends `BaseMigrationWallet` with test infrastructure; NOT re-exported from top-level `index.ts`)
   - `MigrationTestWallet` (extends `MigrationTestBaseWallet` with account deployment helpers)

   These are separate inheritance chains. Account classes handle signing and key access; wallet classes handle proof construction and note management.
   > **TODO:** `BaseMigrationAccount.getMask()` returns `Fq.ZERO` (masking is not functional). *(Source: wallet code)*
   > **TODO:** `SignerlessMigrationAccount.getEnryptedNskApp()` has a typo in the method name (`Enrypted` instead of `Encrypted`). *(Source: `migration-account.ts:167`)*
8. **Key derivation:** `msk = sha512ToGrumpkinScalar([secretKey, MSK_M_GEN])`. Constants: `MSK_M_GEN = 2137`, `NSK_MASK_DOMAIN = 1670` (both defined only in TS `constants.ts`, with no corresponding Noir-side definitions — key derivation is entirely TS-side). Note: `NSK_MASK_DOMAIN` is currently unused in active code (only in a commented-out line in `migration-account.ts:137`).
   > **TODO:** TS constants should be generated from the same source as Noir constants to prevent drift. *(Source: `constants.ts:1`)*
9. **Import patterns:**
   - Top-level `migration-lib` re-exports: `BaseMigrationWallet`, `MigrationTestWallet` (but NOT `MigrationTestBaseWallet`), `BaseMigrationAccount`, `SignerlessMigrationAccount`, key functions (`deriveMasterMigrationSecretKey`, `signMigrationModeA`, `signMigrationModeB`, `signPublicStateMigrationModeB`), proof builders (`buildNoteProof`, `buildArchiveProof`, `buildBlockHeader`), bridge utilities (`waitForBlockProof`, `migrateArchiveRootOnL1`, `waitForL1ToL2Message`), constants, `poll`/`PollOptions`, `blockHeaderToNoir`, types (`NoteProofData`, `ArchiveProofData`, `L1MigrationResult`)
   - Mode-A sub-module (`migration-lib/mode-a/`): `MigrationNote`, `MigrationNoteProofData`, `buildMigrationNoteProof`
   - Mode-B sub-module (`migration-lib/mode-b/`): `FullProofData`, `NonNullificationProofData`, `PublicDataSlotProof`, `PublicDataProof`, `KeyNote`, `buildPublicDataSlotProof`, `buildPublicDataProof`, `buildPublicMapDataProof`
   - NOT re-exported from any `index.ts`: `common-notes.ts` (`UintNote`, `FieldNote`), `MigrationTestBaseWallet`, `MigrationSignature` (internal). Import these directly from their source files.
10. **Common note decoders:**
    - `ts/migration-lib/common-notes.ts` provides `UintNote` and `FieldNote` decoder callbacks used as `noteMapper` parameters in proof-building functions. These are NOT re-exported from top-level `index.ts`; integrators must import directly from `common-notes.ts`.
11. **Utility functions:**
    - `blockHeaderToNoir`: Converts an L2 block header to the Noir-compatible struct format. Explain its role in proof building.
    - `poll` utility and `onPoll` callback pattern: Used for waiting on sandbox readiness and transaction confirmation.
    - Note: `buildNullifierProof` is NOT exported from mode-b's public API. Integrators should use `BaseMigrationWallet.buildFullNoteProofs()` (or `buildNullifierProofs()`), which internally calls `buildNullifierProof`.
    - Note: `migrateArchiveRootAtBlock` has no TS wrapper in `bridge.ts`. Integrators needing historical block bridging must call the Solidity contract directly.
12. **On-curve assertion:**
    - `register()` and `lock_migration_notes()` include an on-curve assertion (`y^2 = x^3 - 17`) for Grumpkin points. Document this as a potential revert condition if invalid keys are provided.
13. **`MIGRATION_DATA_FIELD_INDEX = 5` constant:**
    - Defined in `ts/migration-lib/constants.ts:32`. JSDoc says "Zero-based index of the `migration_data` field inside a `MigrationNote`" but the value `5` corresponds to `storage_slot` in the `MigrationNote.compute_note_hash()` preimage ordering, not `migration_data_hash` (which is at index 4). The constant is not used in active code. Document this discrepancy and note the constant may be vestigial or may refer to a different field layout than the hash preimage.
14. **Deployment checklist:** Set `old_app_address`, configure `MigrationArchiveRegistry` (constructor: `l1_migrator`, `old_rollup_version`, `old_key_registry`), bridge first archive root.
15. **Related Documents**

**Content sources:** `TODO_MODE_A.md` items 9 (70%), 10 (50%); `TODO_MODE_B.md` item 8 (50%); `inconsistencies.md` STUB-8 outline; test files for code patterns.

**Estimated: ~45% from existing, 55% original writing.**

### 4.6 `docs/threat-model.md` (~100 lines)

**Purpose:** Trust assumptions, threat scenarios, mitigations, and PoC limitations.

**Sections:**
1. **Trust assumptions:**
   - L1 is trusted as the anchor for archive root bridging
   - Old rollup's proven archive roots are assumed valid (inherited from L1 rollup contracts)
   - Migration keys are the sole authorization mechanism (separate from account signing keys)
2. **Threat scenarios and mitigations:**
   - Front-running: Schnorr signature binds claim to specific recipient + app contract
   - Double-claim: Nullifiers prevent re-migration (private: randomness-based; public: deterministic)
   - Replay across modes: Domain separation (`CLAIM_DOMAIN_A`, `CLAIM_DOMAIN_B`, `CLAIM_DOMAIN_B_PUBLIC`)
   - Cross-rollup identity linking: Nullifiers use randomness, not user secret keys
   - Migration key compromise: Attacker can claim tokens on new rollup (fund loss scoped to migration)
   - `set_snapshot_height` manipulation: Attacker with access could pick an unfavorable snapshot block to include or exclude specific state (mitigated by write-once `Owned<PrivateImmutable>`, but governance access control is PoC-limited)
3. **PoC limitations (NOT FOR PRODUCTION):**
   - No supply cap enforcement (unlimited minting on successful migration)
   - `old_app_address` is an unchecked witness (incorrect deployment = silent failure)
   - L1 `migrateArchiveRoot` is permissionless (spam risk for L1-to-L2 message trees)
   - Snapshot height governance has no access control beyond write-once
   - `ExampleMigrationApp`: no access control on `mint()`/`burn()`, no `#[only_self]` on public struct init functions
   - In-memory key storage (production should use secure storage)
   - Identical storage layout assumed between old and new rollup contracts (see `NOTE` comments in `nft_migration_app`)
   - On-curve assertion (`y^2 = x^3 - 17`) in `register()` and `lock_migration_notes()` will silently revert if invalid Grumpkin points are provided
   > **TODO:** Placeholder domain separators (`CLAIM_DOMAIN_A = MIGRATION_MODE_A_STORAGE_SLOT`, `CLAIM_DOMAIN_B_PUBLIC = 0xdeafbeef`, `GENERATOR_INDEX__PUBLIC_MIGRATION_NULLIFIER = 0x12345678`) must be replaced with properly derived values before production. *(Source: `constants.nr:5,12,15`)*
4. **Spec open items:**
   > **TODO:** Evaluate salt-based commitment for new accounts. *(Source: `migration-spec.md:307`, spec TODO item 2)*
   > **TODO:** Supply cap per-user batching. *(Source: `migration-spec.md:309`, spec TODO item 4)*
5. **Related Documents**

**Content sources:** `migration-spec.md` "Key Design Decisions" items 1-4 (50%); `TODO_MODE_A.md` items 4, 7, 8 (90%); `TODO_MODE_B.md` items 5, 6 (85%).

**Estimated: ~50% from existing, 50% original writing.**

### 4.7 `docs/operations.md` (~150 lines)

**Purpose:** How to run tests, set up dual-rollup environment, troubleshoot, and Solidity build notes.

**Sections:**
1. **Prerequisites:** Node.js, Yarn, Docker (for Aztec sandbox), Foundry (for Solidity).
2. **Version information:**
   - Noir/Aztec.nr: `v3.0.0-devnet.6-patch.1` (from `Nargo.toml`)
   - Solidity/Foundry: Aztec `v3.0.2` (from `foundry.toml`)
   - This version split is intentional -- Solidity and Noir follow separate Aztec release tracks.
3. **Compilation commands:**
   - `yarn noir:compile` -- Compile Noir contracts
   - `yarn noir:codegen` -- Generate TypeScript bindings
   - `yarn sol:deps` -- Install Solidity dependencies (MUST run before `sol:compile`)
   - `yarn sol:compile` -- Compile Solidity contracts
   - `yarn clean` -- Clean all artifacts
4. **Unit tests:**
   - `nargo test --show-output` -- Run Noir unit tests
5. **E2E test environment:**
   - `yarn test:setup` -- Starts dual rollup sandboxes via `dual-rollup-setup.sh`
   - Ports: `8545` (Anvil L1), `8080` (old rollup sandbox), `8081` (new rollup sandbox)
   - Environment variables: `AZTEC_NODE_URL`, `AZTEC_OLD_URL`, `AZTEC_NEW_URL`, `ETHEREUM_RPC_URL`
   - `dual-rollup-setup.sh` is a 14-step governance flow with Anvil time manipulation
6. **E2E test scripts:**
   - `yarn test:mode-a` -- Mode A migration test
   - `yarn test:mode-b` -- Mode B private note migration test
   - `yarn test:mode-b:public` -- Mode B public state migration test
   - `yarn test:registry` -- MigrationArchiveRegistry tests
   - `yarn test:hash` -- Hash verification tests
   - `yarn check:full` -- Runs mode-a + mode-b + mode-b:public (does NOT include `test:registry` or `test:hash`)
   - `yarn test:stop` -- Stop sandboxes and clean up
7. **Solidity contracts summary:**
   - `Migrator.sol`: 3 external functions (all permissionless):
     - `migrateArchiveRoot(uint256 oldVersion, DataStructures.L2Actor calldata l2Migrator)` -- Bridge latest proven archive root
     - `migrateArchiveRootAtBlock(uint256 oldVersion, uint256 blockNumber, DataStructures.L2Actor calldata l2Migrator)` -- Bridge at specific height
     - `getArchiveInfo(uint256 version)` -- View function returning archive root and proven checkpoint number for a given version
   - `Poseidon2Deploy.sol`: Helper for deploying the Poseidon2 precompile
   - `RegisterNewRollupVersionPayload.sol`: Governance payload for registering new rollup versions
   - `Migration.t.sol`: Tests only Poseidon2 hashing (does NOT test Migrator logic -- significant test gap)
   - Note: TS `bridge.ts` only wraps `migrateArchiveRoot`, not `migrateArchiveRootAtBlock`
8. **Troubleshooting:**
   - Ports in use (kill processes on 8080, 8081, 8545)
   - Sandbox timeout (increase wait time in setup)
   - Anvil time-warp issues (`start-node-with-time-sync.mjs`)
   - Genesis mismatch (sandbox configuration)
   - L1-L2 message consumption failures (check secret, leaf index)
   - Docker cleanup (sandbox lifecycle)
   - Nargo compilation errors (version sensitivity)
9. **Related Documents**

**Content sources:** `package.json` scripts (100% reference), `inconsistencies.md` "Docs Backlog" section (80%), `dual-rollup-setup.sh` (70%), Solidity source code (80%).

**Estimated: ~60% from existing (reference material), 40% original writing.**

### 4.8 `docs/spec/migration-spec.md` (update in place, ~450 lines after changes)

See Section 5 for all spec changes.

---

## 5. Spec Updates

All changes target `docs/spec/migration-spec.md`. Listed in document order.

> **Application order:** Apply changes in Section 5.x numerical order. Line number references are to the CURRENT (unmodified) spec. After all changes are applied, line numbers will have shifted — use section headings for final verification. Where "Current text" is quoted, it is a prefix of the actual line content; replace the full paragraph/decision point, not just the quoted prefix. Replacement text blocks marked with "Replace with:" should be adapted into the spec's existing voice, not necessarily copied verbatim.

### 5.1 ARCH-DYN: Dynamic Rollup ID Reads

**Location:** Line 30, Key Design Decision #2.

**Current text:**
> TokenV2 has immutable config: `old_rollup_id`, `TokenV1_address`, `archive_registry_address` (new rollup), `dest_rollup_id` (this rollup).

**Replace with:**
> TokenV2 has deployment-time config: `old_rollup_app_address`, `archive_registry_address` (new rollup). Rollup version identifiers are read dynamically: `old_rollup` from `block_header.global_variables.version` and `current_rollup` from `context.version()`. For Mode B, the `MigrationArchiveRegistry` also stores the `migration_key_registry_address` (old rollup) and `old_rollup_version` (for L1 message verification).

**Additional fix:** The spec's architecture diagram (line 39) names the L1 contract `L1Migrator`. The Solidity contract is actually named `Migrator`. Update the diagram label to `Migrator` with a parenthetical "(L1)".

### 5.2 Correct `old_rollup_id` Location

**Location:** Line 30 (same decision), and any references to "TokenV2 stores old_rollup_id".

**Required change:** The `old_rollup_version` is stored in `MigrationArchiveRegistry` (for L1 message verification), not in TokenV2/app contracts. App contracts read the old rollup version dynamically from the block header. Update all references accordingly.

### 5.3 ARCH-49: Library vs App-Level API Split

**Location:** Lines 254-288 (API section).

**Changes:**
1. Add introductory paragraph explaining the three-layer composition (library / app contract / TS client).
2. Add new "Migration Library Functions" table:

| Function | Module | Key Params | Description |
|----------|--------|-----------|-------------|
| `lock_migration_notes` | `mode_a/ops` | `migration_data: [T; N], ...` | Create MigrationNotes and emit encrypted MigrationDataEvents |
| `migrate_notes_mode_a` | `mode_a/ops` | `note_proof_data: [MigrationNoteProofData; N], block_header, signature, mpk` | Verify Mode A inclusion proofs, check Schnorr signature, emit nullifiers, enqueue block verification |
| `migrate_notes_mode_b` | `mode_b/ops` | `full_proof_data: [FullNoteProofData; N], block_header, signature, key_note, nsk, ...` | Verify Mode B inclusion + non-nullification proofs, check Schnorr signature, verify key note |
| `migrate_public_state_mode_b` | `mode_b/ops` | `proof: PublicStateProofData, block_header, base_storage_slot` | Verify public data tree inclusion at snapshot height, emit nullifiers |
| `migrate_public_map_state_mode_b` | `mode_b/ops` | `proof: PublicStateProofData, block_header, base_storage_slot, map_keys` | Derive map storage slot, delegate to `migrate_public_state_mode_b` |
| `migrate_public_map_owned_state_mode_b` | `mode_b/ops` | `proof: PublicStateProofData, block_header, base_storage_slot, map_keys, signature, key_note, old_owner, recipient` | Owned map migration with Schnorr auth |

3. Rename existing tables to "App-Level Interfaces" with note that app contracts wrap library functions.
4. Add `expected_storage_slot` note to Mode B library functions.

### 5.4 ARCH-50: Proof Data Type Definitions

**Location:** New section, inserted between "Data Structures & Hashing" and "Migration Modes".

**Title:** "Proof Data Types"

**Content:** Define all proof data types with CORRECT field names (as verified from code):

1. **`NoteProofData<T>`** -- fields: `data`, `randomness`, `nonce`, `leaf_index`, `sibling_path`
2. **`MigrationNoteProofData<MigrationData>`** -- type alias for `NoteProofData<MigrationData>` (defined in `mode_a/mod.nr`, NOT a struct with its own fields)
3. **`FullNoteProofData<Note>`** (defined in `mode_b/mod.nr`, lines 20-23) -- fields: `note_proof_data`, `non_nullification_proof_data`
4. **`NonNullificationProofData`** -- fields: `low_nullifier_value`, `low_nullifier_next_value`, `low_nullifier_next_index`, `low_nullifier_leaf_index`, `low_nullifier_sibling_path`
5. **`PublicStateSlotProofData`** -- fields: `next_slot`, `next_index`, `leaf_index`, `sibling_path`
6. **`PublicStateProofData<T, N>`** -- fields: `data`, `slot_proof_data`
7. **`KeyNoteProofData`** -- type alias for `NoteProofData<MigrationKeyNote>`

Include the Noir-to-TS type mapping table (see Section 7).

### 5.5 Items 10-14, 22, 22a: Undocumented API Entries

**Item 10 (NftMigrationApp):** Add brief note in API section: "An `NftMigrationApp` contract implementing Mode A + Mode B for NFTs exists in the codebase. Its API follows the same library composition pattern. See `noir/contracts/nft_migration_app/src/main.nr`." Do NOT add full API table (NFTs are out of doc scope).

**Item 11 (L1 Migrator):** Add new API table with CORRECT signatures:

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `migrateArchiveRoot` | `uint256 oldVersion, DataStructures.L2Actor calldata l2Migrator` | `bytes32 leaf, uint256 leafIndex` | Bridge latest proven archive root to new rollup via L1->L2 message |
| `migrateArchiveRootAtBlock` | `uint256 oldVersion, uint256 blockNumber, DataStructures.L2Actor calldata l2Migrator` | `bytes32 leaf, uint256 leafIndex` | Bridge archive root at a specific historical block height |
| `getArchiveInfo` | `uint256 version` | `bytes32 archiveRoot, uint256 provenCheckpointNumber` | View: archive root and proven checkpoint number for the given version |

| Event | Params | Description |
|-------|--------|-------------|
| `ArchiveRootMigrated` | `uint256 indexed oldVersion, uint256 indexed newVersion, bytes32 indexed l2Migrator, bytes32 archiveRoot, uint256 provenBlockNumber, bytes32 messageLeaf, uint256 messageLeafIndex` | Emitted on successful bridge (3 indexed, 4 non-indexed params). Note: the event uses `provenBlockNumber` while the `getArchiveInfo` return value uses `provenCheckpointNumber`. |

**Item 14 (public state migration variants):** Add to ExampleMigrationApp table:
- `migrate_to_public_struct_mode_b`
- `migrate_to_public_struct_map_mode_b`
- `migrate_to_public_owned_struct_map_mode_b`
- `migrate_to_public_owned_struct_nested_map_mode_b`

**Item 22 (MigrationArchiveRegistry expanded):** Add view functions and constructor params:
- View: `get_block_hash`, `get_snapshot_height`, `get_snapshot_block_hash`, `get_latest_proven_block`
- `get_old_key_registry` (`#[external("private")]` -- callable from private context for cross-rollup siloing)
- Constructor: `l1_migrator: EthAddress`, `old_rollup_version: Field`, `old_key_registry: AztecAddress`

**Item 22a:** Add `consume_l1_to_l2_message_and_register_block` convenience function.

### 5.6 Migration Nullifiers Section Update

**Location:** Lines 289-301.

**Current text (line 294):**
```
Mode B (public state):   poseidon2_hash_with_separator([old_app, storage_slot], GENERATOR_INDEX__PUBLIC_MIGRATION_NULLIFIER)
```

This is CORRECT. However, the description on line 301 says "derived from the contract address, storage slot, and field index" which is misleading -- there is no `field_index` in the formula. **Update line 301 to:**
> Mode B public state uses a deterministic nullifier derived from the old app contract address and the base storage slot. One nullifier is emitted per `PublicStateProofData` (per storage struct), covering all consecutive field slots.

### 5.7 Terminology Standardization

Apply throughout the spec:

| Change | Action |
|--------|--------|
| `dest_rollup_id` in body text | Replace with `destination_rollup` (matches code) |
| `TokenV1_address` in technical descriptions | Use `old_rollup_app_address` in API tables; keep `TokenV1_address` only in narrative/abstract sections with parenthetical |
| `proven_block_number` vs Solidity `getProvenCheckpointNumber` | Add note in L1 Migrator section |

### 5.8 Spec's Own TODO Section

Update the spec's TODO section (lines 303-309):
- Item 1: Already marked done. Keep.
- Item 2 (salt-based commitment): Keep as open. Surface in `threat-model.md` as well.
- Item 3: Already marked done. Keep.
- Item 4 (supply cap batching): Keep as open. Surface in `threat-model.md` as well.

### 5.9 `migrateArchiveRootAtBlock` Documentation

The spec currently does not mention `migrateArchiveRootAtBlock`. Add it to the L1 Portal section (lines 51-69) alongside the description of `migrateArchiveRoot`.

---

## 6. TODO/FIXME Inventory

### 6.1 Complete Source Code TODO/FIXME List

Every TODO and FIXME in source code, mapped to its target documentation file. Each must appear in the final docs as a `> **TODO:**` callout.

| # | Location | Type | Content | Target Doc File |
|---|----------|------|---------|----------------|
| 1 | `noir/migration_lib/src/constants.nr:5` | TODO | `CLAIM_DOMAIN_A` reuses `MIGRATION_MODE_A_STORAGE_SLOT`; use a different domain separator | `mode-a.md` (authentication section), `threat-model.md` |
| 2 | `noir/migration_lib/src/constants.nr:12` | TODO | `CLAIM_DOMAIN_B_PUBLIC = 0xdeafbeef` is a placeholder | `mode-b.md` (public state section), `threat-model.md` |
| 3 | `noir/migration_lib/src/constants.nr:15` | TODO | `GENERATOR_INDEX__PUBLIC_MIGRATION_NULLIFIER = 0x12345678` is a placeholder | `mode-b.md` (nullifier section), `threat-model.md` |
| 4 | `noir/migration_lib/src/mode_a/migration_data_event.nr:13` | TODO | Consider including note hash in event for filtering without `txHash` | `mode-a.md` (lock flow section) |
| 5 | `noir/contracts/example_app/src/main.nr:203` | FIXME | Redundant `amount` argument in `migrate_mode_a` | `mode-a.md` (claim flow section) |
| 6 | `noir/contracts/example_app/src/main.nr:239` | FIXME | Redundant `amount` argument in `migrate_to_public_mode_a` | `mode-a.md` (public balance section) |
| 7 | `ts/migration-lib/constants.ts:1` | TODO | Generate constants from same source as Noir | `integration-guide.md` (constants section) |
| 8 | `ts/migration-lib/wallet/migration-base-wallet.ts:179` | FIXME | `getMigrationNotes` returns all notes including already-migrated | `integration-guide.md` (TS client flow section) |
| 9 | `migration-spec.md:307` (spec TODO item 2) | TODO | Evaluate salt-based commitment for new accounts | `threat-model.md` (spec open items) |
| 10 | `migration-spec.md:309` (spec TODO item 4) | TODO | Supply cap per-user batching | `threat-model.md` (spec open items) |
| 11 | Wallet code (`BaseMigrationAccount`) | TODO | `getMask()` returns `Fq.ZERO` (masking is not functional) | `integration-guide.md` (wallet classes section) |
| 12 | `ts/migration-lib/wallet/migration-account.ts:167` | TODO | `getEnryptedNskApp()` has a typo in the method name (`Enrypted` instead of `Encrypted`) | `integration-guide.md` (wallet classes section) |

### 6.2 Non-TODO Annotations Worth Surfacing

These are `NOTE` comments and implicit assumptions that should be documented as callouts or prerequisites:

| Location | Content | Target Doc |
|----------|---------|-----------|
| `nft_migration_app` (NOTE comments) | Identical storage layout assumption between old and new contracts is a critical migration prerequisite | `threat-model.md` (assumptions), `mode-a.md` + `mode-b.md` (prerequisites) |
| Wallet code | In-memory key storage (production security implication) | `threat-model.md` (PoC limitations) |
| `TODO_MODE_A.md` item 8 | Permissionless L1 Migrator (spam risk) -- no TODO in code but documented concern | `threat-model.md` (threats) |

---

## 7. Noir-to-TypeScript Type Mapping

This table must appear in both `integration-guide.md` and `spec/migration-spec.md` (proof data types section).

| Noir Type | Noir File | TS Type | TS File | Re-exported from `index.ts`? |
|-----------|-----------|---------|---------|------------------------------|
| `NoteProofData<T>` | `note_proof_data.nr` | `NoteProofData<Note>` | `ts/migration-lib/types.ts` | Yes |
| `MigrationNoteProofData<MigrationData>` | `mode_a/mod.nr` (type alias) | `MigrationNoteProofData<T>` | `ts/migration-lib/mode-a/index.ts` | No (import from `mode-a/`) |
| `FullNoteProofData<Note>` | `mode_b/mod.nr` (lines 20-23) | `FullProofData<Note>` | `ts/migration-lib/mode-b/types.ts` | No (import from `mode-b/`) |
| `NonNullificationProofData` | `mode_b/non_nullification_proof_data.nr` | `NonNullificationProofData` | `ts/migration-lib/mode-b/types.ts` | No (import from `mode-b/`) |
| `PublicStateProofData<T, N>` | `mode_b/public_state_proof_data.nr` | `PublicDataProof<T>` | `ts/migration-lib/mode-b/types.ts` | No (import from `mode-b/`) |
| `PublicStateSlotProofData` | `mode_b/public_state_proof_data.nr` | `PublicDataSlotProof` | `ts/migration-lib/mode-b/types.ts` | No (import from `mode-b/`) |
| `KeyNoteProofData` (alias) | (type alias in `mode_b/`) | `NoteProofData<KeyNote>` | `ts/migration-lib/mode-b/types.ts` | No (`KeyNote` from `mode-b/`) |
| `MigrationKeyNote` | `migration_key_note.nr` | `KeyNote` | `ts/migration-lib/mode-b/types.ts` | No (import from `mode-b/`) |
| `MigrationNote` | `mode_a/migration_note.nr` | `MigrationNote` | `ts/migration-lib/mode-a/index.ts` | No (import from `mode-a/`) |
| `MigrationSignature` | (shared) | `MigrationSignature` | `ts/migration-lib/types.ts` | No (internal use) |
| `Point` (alias for `EmbeddedCurvePoint`) | `lib.nr` re-export | `Point` (from `@aztec/foundation/schemas`) | N/A | N/A (Aztec native type) |
| `Scalar` (alias for `EmbeddedCurveScalar`) | `lib.nr` re-export | `Scalar` (Aztec native type) | N/A | N/A (Aztec native type) |

**Naming discrepancies to highlight:**
- `PublicStateSlotProofData` (Noir) vs `PublicDataSlotProof` (TS) -- different naming convention
- `PublicStateProofData` (Noir) vs `PublicDataProof` (TS) -- different naming convention
- `MigrationKeyNote` (Noir) vs `KeyNote` (TS) -- abbreviated in TS
- `MIGRATION_MODE_A_STORAGE_SLOT` (Noir) vs `MIGRATION_NOTE_SLOT` (TS) -- different constant names, same value
- `Point`/`Scalar` (Noir `lib.nr` aliases) vs Aztec native `Point`/`Scalar` -- same types, re-exported for convenience

---

## 8. Canonical Terminology Table

Use these terms consistently. On first use in each document, show both canonical name and aliases.

| Canonical Term | Context | Alias(es) | First-Use Format |
|---------------|---------|-----------|-----------------|
| `destination_rollup` | Struct field in MigrationNote and signature messages | `dest_rollup_id` (deprecated spec text) | "`destination_rollup` (the new rollup's version identifier)" |
| `old_rollup_app_address` | Storage field for old rollup's app contract address | `TokenV1_address` (spec narrative) | "`old_rollup_app_address` (referred to as `TokenV1_address` in abstract spec text)" |
| `MIGRATION_MODE_A_STORAGE_SLOT` (Noir) | Mode A note storage slot constant | `MIGRATION_NOTE_SLOT` (TS) | "`MIGRATION_MODE_A_STORAGE_SLOT` (Noir) / `MIGRATION_NOTE_SLOT` (TS)" |
| `proven_block_number` / `provenCheckpointNumber` | Block number of latest proven checkpoint | `getProvenCheckpointNumber` (Solidity function return), `provenBlockNumber` (Solidity event param) | "`provenCheckpointNumber` (Solidity `getArchiveInfo` return name) / `provenBlockNumber` (Solidity `ArchiveRootMigrated` event param) / `proven_block_number` (Noir/spec usage). Note the naming inconsistency between the Solidity event and function." |
| `CLAIM_DOMAIN_B_PUBLIC` | Domain separator for Mode B public state claims | None | "`CLAIM_DOMAIN_B_PUBLIC` (placeholder `0xdeafbeef`, see threat model)" |
| `Migrator` | L1 Solidity contract | `L1Migrator` (spec diagram), `L1 Migrator` (prose) | "`Migrator.sol` (the L1 contract, sometimes referred to as 'L1 Migrator')" |

---

## 9. CLAUDE.md Updates

### 9.1 Section A2: Project Docs and Architecture

Replace the current A2 file listing with paths matching the new 8-file structure:

```markdown
### Spec and architecture files (standard layout)
We keep docs in `docs/` using a layout that can be reused across projects.

**Spec (migration design including Mode A / Mode B)**
- `docs/spec/migration-spec.md`  <- high level specification

**Architecture and Protocol**
- `docs/architecture.md`         <- system overview, components, deployment topology
- `docs/mode-a.md`               <- Mode A (cooperative lock-and-claim) details
- `docs/mode-b.md`               <- Mode B (emergency snapshot) details and architecture
- `docs/threat-model.md`         <- trust assumptions, threat model, PoC limitations

**Developer Guides**
- `docs/integration-guide.md`    <- TS SDK, wallet classes, API reference, proof types

**Operational Docs**
- `docs/operations.md`           <- testing, setup, troubleshooting, Solidity summary

**Entry Point**
- `docs/index.md`                <- documentation entry point, problem statement, scope, doc map
```

Note: `docs/index.md` is listed separately since it is the entry point linking to all other docs.

### 9.2 Section B5: Documentation Mandate

Update the file path references in "Required docs updates":

```markdown
### Required docs updates (when applicable)
- Setup/start changed -> update `README.md` and `docs/operations.md`
- Contract interface changed (public functions, events, externally visible behavior) -> update `docs/mode-a.md`, `docs/mode-b.md`, and/or `docs/spec/migration-spec.md`
- Test approach changed -> update `docs/operations.md`
- Security/trust assumptions changed -> update `docs/threat-model.md`
- Solidity interface changed -> update `docs/spec/migration-spec.md` (L1 Migrator API) and `docs/operations.md` (build details)
```

### 9.3 Section B6: Solidity Guidelines

Update the documentation reference:

```markdown
- Document Solidity-facing interfaces in `docs/spec/migration-spec.md` (L1 Migrator API table) and build/test details in `docs/operations.md`.
```

(Remove the reference to `docs/solidity/overview.md` which will not exist in the new structure.)

### 9.4 Section A3: Local Development Commands

CLAUDE.md A3 (lines 91-92) references `docs/ops/testing.md` which will not exist in the new structure. Update:

```markdown
### Recommended verification defaults
- Full E2E (only when needed): `yarn check:full`

Use `yarn check:full` when changes affect:
- migration flow logic across old/new rollup
- archive root verification
- L1↔L2 message consumption
- note hashing / nullifier behavior that the E2E test exercises
```

Update the testing reference in the "Rules" subsection of A3:

```markdown
**Rules**
1) When you change migration logic, run the E2E test flow unless it is impossible (then explain exactly why).
2) If you change ports, endpoints, or scripts, update:
   - `README.md`
   - `docs/operations.md`
```

(Replace `docs/ops/testing.md` with `docs/operations.md`.)

### 9.5 Section B5: Doc Style Rules

B5 "Doc style rules" bullet 3 says "link to the spec/flow doc" which implicitly references the now-deleted `docs/arch/flows.md`. Update to:

```markdown
- When describing behavior, link to the relevant mode doc (`mode-a.md`, `mode-b.md`) or spec where possible.
```

---

## 10. File Deletion and Archival Plan

### 10.1 Files to Delete (replaced by new structure)

These files are stubs or will be fully absorbed. Delete after new files are written and verified.

| File | Reason | Content Destination |
|------|--------|-------------------|
| `docs/problem-and-solution.md` | Stub (1 line of content). Absorbed into `docs/index.md`. | `docs/index.md` |
| `docs/mode-a-details.md` | Stub. Replaced by `docs/mode-a.md`. | `docs/mode-a.md` |
| `docs/mode-b-details.md` | Stub. Replaced by `docs/mode-b.md`. | `docs/mode-b.md` |
| `docs/mode-b-architecture.md` | Substantive content fully absorbed into `docs/mode-b.md`. | `docs/mode-b.md` |
| `docs/non-native-assets.md` | Stub. Scope note absorbed into `docs/index.md`. | `docs/index.md` |

### 10.2 Directories to Remove

| Directory | Current State | Reason |
|-----------|--------------|--------|
| `docs/arch/` | Empty | Content goes in `docs/architecture.md` and `docs/threat-model.md` |
| `docs/ops/` | Empty | Content goes in `docs/operations.md` |
| `docs/solidity/` | Empty | Content split between `spec/migration-spec.md` and `docs/operations.md` |
| `docs/claude/` | Empty | Not needed |

### 10.3 TODO Files to Archive

**Phase 1 (before starting Round 1 writing):** Add header to each TODO file:
```markdown
> **Status: Content being migrated.** Done items are being harvested into docs/.
> Do not add new content here. See `docs/index.md` for current documentation.
```

**Phase 2 (after all Round 1 and Round 2 files pass Section 12.3 checklist):** Mark `TODO_MODE_B.md` item 7 as done:
```markdown
## ~~7. Make registered_keys Immutable in MigrationKeyRegistry~~ (Done)

`PrivateImmutable` with `initialize()` already enforces write-once immutability.
```

**Phase 3 (after Section 12.4 global validation passes):** Add definitive archive header:
```markdown
> **ARCHIVED.** All content has been migrated to `docs/`. This file is retained
> for git history only. The source of truth is `docs/index.md`.
```

### 10.4 Other Files

| File | Action | Notes |
|------|--------|-------|
| `inconsistencies.md` | **Retain.** Update CRIT-1 "Done when" criteria per Section 12.5. | Heavily referenced as a data source. Keep until all items are resolved. |
| `README.md` | **Update.** Add link to `docs/index.md` as documentation entry point. | Currently has no doc links. Does not reference old doc structure, so no broken links to fix. |
| `docs_plan_expert_1.md` | **Delete** after documentation rewrite is complete. | Intermediate analysis file, not needed in repo. |
| `docs_plan_expert_2.md` | **Delete** after documentation rewrite is complete. | Intermediate analysis file, not needed in repo. |
| `documentation_update_plan.md` | **Delete** after documentation rewrite is complete. | This plan file itself. |

---

## 11. Writing Order and Dependencies

### 11.1 Dependency Graph

```
(no dependencies)
     |
     +-- operations.md          [parallel, no deps]
     +-- architecture.md        [parallel, no deps]
     +-- mode-a.md              [parallel, no deps]
     +-- mode-b.md              [parallel, no deps -- OD-1 is resolved, OD-4 is resolved (merge)]
     +-- threat-model.md        [parallel, no deps]
     +-- spec updates           [parallel, no deps]
     +-- CLAUDE.md updates      [parallel, no deps]
     |
     +-- integration-guide.md   [after mode-a.md and mode-b.md, to reference them]
     |                          (code-derived sections can be drafted in Round 1;
     |                           only cross-reference links need Round 2)
     |
     +-- index.md               [LAST -- after all other files exist, to link correctly]
     |
     +-- Deletion/archival      [LAST -- after all content is verified in new files]
```

### 11.2 Pre-Writing Audit Step

Before writing any documentation, perform a code verification pass:

1. **Verify all formulas against code** -- especially in `mode-b-architecture.md`:
   - Line 165: public state nullifier formula (KNOWN INCORRECT: shows 3-field `[old_app, storage_slot, field_index]`, should be 2-field `[old_app, base_storage_slot]`)
   - Line 168: verify any additional formula references for correctness
   - All nullifier formulas in `mode_a/ops.nr` and `mode_b/ops.nr`
2. **Verify all struct fields** -- compare every field listed in Section 4.5 against current code at HEAD
3. **Verify all function signatures** -- compare every API table entry in Section 5.3 against current code at HEAD
4. **Verify Solidity signatures** -- compare `Migrator.sol` function signatures and events against Section 5.5
5. **Check for new TODOs/FIXMEs** -- run `grep -rn "TODO\|FIXME"` across `noir/` and `ts/` directories to catch any items added since this plan was drafted

This audit should take 1-2 hours and prevents propagating errors into the new documentation.

### 11.3 Recommended Writing Order

**Round 1 -- All parallel (no inter-dependencies):**

| Priority | File | Rationale | Est. Effort |
|----------|------|-----------|-------------|
| 1a | `docs/operations.md` | High onboarding value, well-defined content (scripts, ports, troubleshooting) | 1-2 hours |
| 1b | `docs/architecture.md` | Foundational overview that other docs reference | 1-2 hours |
| 1c | `docs/mode-a.md` | 65% harvestable from TODO_MODE_A.md | 2-3 hours |
| 1d | `docs/mode-b.md` | 75% harvestable from mode-b-architecture.md + TODO_MODE_B.md | 2-3 hours |
| 1e | `docs/threat-model.md` | 50% from existing sources | 1-2 hours |
| 1f | Spec updates (Section 5) | 9+ discrete changes, all unblocked | 2-3 hours |
| 1g | CLAUDE.md updates (Section 9) | Small, well-defined | 15 minutes |

Note: Code-derived sections of `integration-guide.md` (proof types, wallet classes, import patterns) can also be drafted in Round 1 since they depend only on code, not on other docs. Only cross-reference links to mode docs need Round 2.

**Round 2 -- After mode docs exist:**

| Priority | File | Rationale | Est. Effort |
|----------|------|-----------|-------------|
| 2a | `docs/integration-guide.md` | Finalize with cross-references to mode-a.md and mode-b.md | 3-4 hours |

**Round 3 -- After all content files exist:**

| Priority | Task | Rationale | Est. Effort |
|----------|------|-----------|-------------|
| 3a | `docs/index.md` | Entry point must link to all files | 30 minutes |
| 3b | Delete old stubs + empty directories | Only after new files verified | 15 minutes |
| 3c | Archive TODO files | After content migration verified | 15 minutes |
| 3d | Cross-reference audit | Verify all links resolve | 30 minutes |
| 3e | Terminology sweep | Grep for deprecated terms | 30 minutes |
| 3f | CLAUDE.md path verification | All A2 paths resolve | 15 minutes |

**Total estimated effort: 3-4 days of focused writing.** (The lower bound of 3 days assumes no blockers and familiarity with the codebase. The upper bound of 4 days accounts for code verification passes and review cycles.)

### 11.4 Recommended PR Phasing

For reviewability, consider splitting the documentation rewrite into 4 PRs:

| Phase | PR Contents | Rationale |
|-------|-------------|-----------|
| Phase 1 | `operations.md`, `architecture.md`, CLAUDE.md updates, spec updates | Infrastructure and reference docs. Easiest to review independently. |
| Phase 2 | `mode-a.md`, `mode-b.md`, `threat-model.md` | Protocol docs. Reviewers can verify against code and spec. |
| Phase 3 | `integration-guide.md`, `index.md` | Developer-facing docs. Depend on Phase 2 for cross-references. |
| Phase 4 | Stub deletions, directory cleanup, TODO file archival | Cleanup. Mechanical changes, easy to verify. |

Each phase can be reviewed in isolation. Phase 1 and Phase 2 can proceed in parallel if different reviewers are available.

> **Note on `integration-guide.md` timing:** Although code-derived sections (proof types, wallet classes, import patterns) can be drafted during Round 1, the full file is held until Phase 3 PR because its cross-references to mode docs need to be finalized after Phase 2 mode docs are merged.

---

## 12. Quality Standards and Verification

### 12.1 Document Style Guide

Based on the quality of `mode-b-architecture.md` (the best-written existing document):

**Front matter:**
```yaml
---
layout: default
title: Document Title
---
```

**Section skeleton:**
1. Navigation link: `[<- Home](.)` or `[<- Home](..)`
2. Title (H1)
3. Overview (1-2 paragraphs)
4. Core content sections (H2, H3)
5. PoC Limitations section (if applicable)
6. Related Documents section (always)

**Code references:**
- Noir: `` `module/file.nr`, function `function_name` ``
- TS: `` `ts/migration-lib/path.ts`, export `functionName` ``
- Solidity: `` `solidity/contracts/File.sol`, function `functionName` ``

**ASCII diagrams:** Use the style from `mode-b-architecture.md`:
```
element_a --relation--> element_b
                            |
                        (annotation)
```

**Formulas:** Use fenced code blocks with no language tag:
```
nullifier = poseidon2_hash_with_separator([field1, field2], SEPARATOR)
```

**TODO callouts:** Use blockquote format:
```markdown
> **TODO:** Description of the issue. *(Source: `file:line`)*
```

**Cross-references:** Use relative markdown links:
- Same directory: `[Link text](filename.md)`
- Subdirectory: `[Link text](spec/migration-spec.md)`

### 12.2 Cross-Referencing Rules

1. **Bidirectional linking:** If document A links to B, B links back to A in "Related Documents".
2. **Every document ends with** a "Related Documents" section.
3. **`docs/index.md` links to every document** (directly or via section grouping).
4. **Link tier structure:**
   - **Tier 1 (entry):** `index.md` -- links to everything
   - **Tier 2 (mode docs + security):** `mode-a.md`, `mode-b.md`, `integration-guide.md`, `threat-model.md` -- link to spec, architecture, and each other. `threat-model.md` shares audience with mode docs (auditors, security engineers reviewing protocol details).
   - **Tier 3 (reference):** `spec/migration-spec.md`, `architecture.md`, `operations.md` -- link to parent tier
5. **Spec exemption for operations.md:** `operations.md` serves a different audience (developers running tests) and does not require bidirectional links to every Tier 2 doc. It should link to `index.md` and `architecture.md` for context, but mode-specific links are optional.

### 12.3 Per-Document Verification Checklist

Apply to every document before considering it complete:

| Category | Check |
|----------|-------|
| **Code Accuracy** | Every function signature, struct field, and constant name matches code at HEAD |
| **Spec Alignment** | Claims about protocol behavior match `migration-spec.md` |
| **Terminology** | Uses canonical terms from Section 8; no deprecated aliases without parenthetical |
| **Cross-References** | All internal links resolve; bidirectional linking satisfied |
| **TODO Callouts** | All mapped TODOs from Section 6 are present in the correct files |
| **Style** | Follows Section 12.1 conventions (front matter, skeleton, code refs, diagrams) |
| **PoC Limitations** | Any PoC-specific behavior called out with "PoC Limitation" or "NOT FOR PRODUCTION" |
| **Line Count** | Within 20% of estimated line count from Section 3.1 (advisory — completeness takes priority over line counts) |

### 12.4 Post-Rewrite Global Validation

After all documents are written, run these validation passes:

1. **Link integrity:** Verify every `[text](path.md)` resolves to an existing file with content.
2. **Terminology grep:** Search all docs for deprecated terms (`dest_rollup_id` outside spec narrative, `TokenV1_address` in API tables, `MIGRATION_NOTE_STORAGE_SLOT`, `L1Migrator` as contract name).
3. **CLAUDE.md path check:** Verify every file path in CLAUDE.md section A2 points to an existing file.
4. **TODO inventory check:** Verify all 12 items from Section 6.1 appear as `> **TODO:**` callouts in their target files. Note: some items map to multiple files (e.g., items 1-3 appear in both mode docs and `threat-model.md`), and some items are consolidated into single callouts covering related FIXMEs (e.g., items 5-6). The Section 4 drafts show ~12-13 distinct callout blocks across all files.
5. **Type mapping check:** Verify all entries in Section 7 type mapping table match current code.
6. **Spec-code parity:** For each API table entry in the spec, verify the function exists in code with matching parameters.
7. **Inconsistencies.md sweep:** Walk every item in `inconsistencies.md` and verify the "Done when" criteria is met. (The writer must read `inconsistencies.md` in full before beginning work. Key items referenced: CRIT-1 (nullifier formula), REF-2 (code comment), STUB-8 (integration guide outline).)
8. **NFT reference scrub:** Search all newly written docs for `NftMigrationApp` and NFT-related content. Ensure NFT mentions are limited to the brief notes in `index.md` and `spec/migration-spec.md` as specified in decision D-1.

### 12.5 Items NOT Resolved by This Doc-Only Plan

The following `inconsistencies.md` items **cannot** be resolved by documentation changes alone:

| Item | Why It Remains Open | Required Action |
|------|-------------------|-----------------|
| CRIT-1 | "Done when" criteria requires `field_index` to appear in code, but decision D-2 confirms the 2-field formula `[old_app, base_storage_slot]` is correct and `field_index` should NOT be added. | Update the "Done when" criteria in `inconsistencies.md` itself to reflect that the 2-field formula is the intended design. This is a fix to `inconsistencies.md`, not to code or docs. |
| REF-2 | Requires a code comment fix (not a documentation change). | Fix the code comment in a separate code PR. |

These items should be tracked separately and not conflated with the documentation rewrite scope.

### 12.6 Section 6.2 Verification

The non-TODO annotations from Section 6.2 must also be verified during the post-rewrite validation:

| Annotation | Verify In |
|------------|----------|
| Identical storage layout assumption (`nft_migration_app` NOTE comments) | `threat-model.md` (assumptions), `mode-a.md` + `mode-b.md` (prerequisites) |
| In-memory key storage (production security implication) | `threat-model.md` (PoC limitations) |
| Permissionless L1 Migrator (spam risk) | `threat-model.md` (threats) |

---

## 13. Improvements from Post-Review Analysis

> **Source:** 3 rounds of 7-agent post-review analysis (21 agents total), cross-checked against code at HEAD.
> **Scope:** Corrections, clarifications, and additions to this plan. No items here change the overall 8-file structure or writing order. Items are organized by topic.

### 13.1 Missing Struct Definitions in Proof Data Types (Sections 4.5 / 5.4)

Sections 4.5 and 5.4 enumerate proof data types but omit four structs that appear in the Noir codebase and are referenced by documented functions. Add the following to both Section 4.5 (`integration-guide.md` proof data types) and Section 5.4 (spec proof data types):

| Struct | File | Fields | Notes |
|--------|------|--------|-------|
| `MigrationNote` | `mode_a/migration_note.nr` | `note_creator: AztecAddress`, `mpk: Point`, `destination_rollup: Field`, `migration_data_hash: Field` | Created by `lock_migration_notes`. Consumed by `migrate_notes_mode_a`. |
| `MigrationKeyNote` | `migration_key_registry/migration_key_note.nr` | `mpk: Point` | Used by `MigrationKeyRegistry`. No direct TS counterpart struct -- TS code uses `KeyNote` (from `mode-b/types.ts`) which is a different representation. Document this asymmetry in the type mapping table (Section 7). |
| `MigrationDataEvent<T>` | `mode_a/migration_data_event.nr` | `migration_data: T` | Emitted by `lock_migration_notes`. No dedicated TS type -- events are decoded via the general event decoding mechanism. Note in `integration-guide.md` that integrators receive raw event data, not a typed `MigrationDataEvent<T>`. |
| `MigrationSignature` | `signature.nr` | `bytes: [u8; 64]` | Public-API-relevant: accepted by all `migrate_*` functions. TS counterpart is `MigrationSignature` interface in `ts/migration-lib/types.ts` (already in Section 7 type mapping table). Mark as NOT re-exported from top-level `index.ts` in Section 4.5 item 9. |

**Action:** Add these four structs to Section 4.5 between the existing `KeyNoteProofData` entry and the "Noir-to-TS type mapping table" reference. Add corresponding entries to Section 5.4. Update Section 7 type mapping table to include `MigrationNote`, `MigrationKeyNote`, and `MigrationDataEvent<T>` with their TS counterpart status.

### 13.2 Additional mode-b-architecture.md Correction (Line 168)

Section 4.4 item 10 identifies the formula error at `mode-b-architecture.md` line 165. However, line 168 also contains incorrect prose:

> "Since public state has no randomness, the nullifier is derived from the contract address, storage slot, **and field index** within the struct."

The phrase "and field index" is wrong -- the nullifier uses only `[old_app, base_storage_slot]` with no `field_index`. Both lines 165 and 168 must be corrected when absorbing into `mode-b.md`.

**Action:** Expand Section 4.4 item 10 correction to explicitly list both lines:
- Line 165: formula shows 3-field `[old_app, storage_slot, field_index]` -- correct to 2-field `[old_app, base_storage_slot]`
- Line 168: prose says "contract address, storage slot, and field index" -- correct to "old app contract address and base storage slot"

Also update Section 11.2 pre-writing audit step 1, which already flags line 168 for verification, to note it as **KNOWN INCORRECT** (matching the treatment of line 165).

### 13.3 TODO Inventory Items 11-12 Clarification

Section 6.1 items 11 (`getMask()` returns `Fq.ZERO`) and 12 (`getEnryptedNskApp()` typo) are listed in the TODO/FIXME inventory but do not have corresponding `TODO` or `FIXME` comments in the source code. Item 11 has an inline comment `// For now just return zero (no mask applied)` at `migration-account.ts:138-139`, and item 12 is simply a misspelled method name with no annotation.

These are **known issues to document**, not code TODOs to surface. The distinction matters for the Section 12.4 post-rewrite validation (step 4), which says "Verify all 12 items from Section 6.1 appear as `> **TODO:**` callouts."

**Action:** Add a clarifying note to Section 6.1:

> **Note on items 11-12:** These items do not have explicit `TODO` or `FIXME` comments in the source code. They are known behavioral issues identified during analysis that should be documented as `> **TODO:**` callouts in `integration-guide.md`. They are included in this inventory for completeness and to ensure they are surfaced in documentation. A code grep for `TODO`/`FIXME` will not find them.

### 13.4 Dependency Graph and Writing Order Revisions

The dependency graph in Section 11.1 and writing order in Section 11.3 have several refinements:

**a) CLAUDE.md updates depend on Round 1 file creation.** CLAUDE.md Section A2 path updates (Section 9.1) reference files that do not yet exist. Moving CLAUDE.md updates to Round 2 ensures the paths can be verified. Alternatively, keep in Round 1 but add a validation note: "CLAUDE.md paths will be verified in Round 3 (Section 11.3, step 3f)."

**Recommended action:** Keep CLAUDE.md in Round 1 (the updates are mechanical and well-defined), but add an explicit note to Section 11.3 Round 1 item 1g:

> Note: CLAUDE.md path references will point to files that do not yet exist at this stage. Path verification is deferred to Round 3 step 3f.

**b) `integration-guide.md` can be partially drafted in Round 1.** This is already noted in Section 11.3 ("code-derived sections can be drafted in Round 1"), but the dependency graph in Section 11.1 does not reflect this. Update the graph annotation:

```
+-- integration-guide.md   [draft code-derived sections in Round 1;
                            finalize cross-references in Round 2]
```

**c) Deletions should be gated on PR approval, not just content verification.** Section 10.1 says "Delete after new files are written and verified." In a multi-PR workflow (Section 11.4), deletions are in Phase 4. Add explicit gating:

> Delete old stubs and empty directories only after the PR containing their replacement content has been merged (not just written).

**d) Consider merging Rounds 2 and 3.** Round 2 has a single item (`integration-guide.md` finalization). Round 3 has `index.md` plus cleanup tasks. If a single reviewer handles both, these can be combined into one round to reduce coordination overhead. This is advisory, not prescriptive.

### 13.5 Integration Guide Restructure

Section 4.5 specifies 15 sections for `integration-guide.md` at ~320 lines. Post-review analysis suggests restructuring for a cleaner developer journey:

**a) Reduce to 11 sections** by combining related content:
- Merge current sections 10 (common note decoders), 11 (utility functions), 12 (on-curve assertion), and 13 (`MIGRATION_DATA_FIELD_INDEX`) into a single "Common Pitfalls and Utilities" section. These are all secondary-concern items that do not warrant their own H2 headings.

**b) Move field-level type definitions to the spec.** The full struct field listings in Section 4.5 item 2 (proof data types) duplicate content that also appears in Section 5.4 (spec proof data types). In `integration-guide.md`, use a summary table with links to the spec for field details, rather than reproducing every field. This reduces the integration guide by ~40 lines and establishes the spec as the single source of truth for type definitions.

**c) Structure as a developer journey.** Reorder sections to follow the integration workflow:
1. Overview (three-layer architecture)
2. Proof data types (summary table, link to spec for details)
3. TS client flow -- Mode A
4. TS client flow -- Mode B (private)
5. TS client flow -- Mode B (public)
6. Wallet and account classes
7. Key derivation
8. Import patterns
9. Common pitfalls and utilities (merged from sections 10-13)
10. Deployment checklist
11. Related Documents

**d) Target ~260 lines** (down from ~320) after the restructure, due to deduplication with the spec.

**Action:** This is advisory. The writer may adopt this restructure or keep the current 15-section layout. If adopted, update Section 4.5 section numbering and the line count estimate in Section 3.1.

### 13.6 Related Documents Concrete Link Matrix

Section 12.2 defines cross-referencing rules (bidirectional linking, tier structure) but does not provide a concrete link list per file. Writers must infer links from the tier rules, which risks inconsistent implementation.

**Action:** Add the following link matrix. Each row is a source file; columns indicate which files it must link to in its "Related Documents" section. "x" = required link, "o" = optional contextual link, "-" = not required.

| Source \ Target | index | spec | arch | mode-a | mode-b | integ | threat | ops |
|-----------------|-------|------|------|--------|--------|-------|--------|-----|
| **index.md** | -- | x | x | x | x | x | x | x |
| **spec** | x | -- | x | x | x | x | x | - |
| **architecture.md** | x | x | -- | x | x | x | o | o |
| **mode-a.md** | x | x | x | -- | o | x | x | - |
| **mode-b.md** | x | x | x | o | -- | x | x | - |
| **integration-guide.md** | x | x | x | x | x | -- | x | o |
| **threat-model.md** | x | x | o | x | x | x | -- | - |
| **operations.md** | x | - | x | - | - | o | - | -- |

This yields 44-48 directional links (depending on optional links). The matrix codifies the tier rules from Section 12.2:
- `index.md` links to everything (Tier 1).
- Mode docs + integration + threat model cross-link heavily (Tier 2).
- `operations.md` has minimal cross-links (different audience).
- `spec` links to all protocol-relevant docs but not `operations.md`.

**Additional clarifications:**
- Inline contextual links within document body text are always permitted and encouraged (e.g., "see [Mode B nullifiers](mode-b.md#migration-nullifier)" in a mode-a.md discussion of cross-mode differences). The matrix governs only the "Related Documents" footer section.
- `index.md`'s "Documentation map" section (Section 4.1 item 6) serves as its "Related Documents" equivalent. It does not need a separate footer.
- Add `spec <-> architecture.md` bidirectional links, which are implied by the tier rules but easy to overlook since both are Tier 3.

### 13.7 Missing package.json Scripts in Operations Documentation

Section 4.7 (`operations.md`) lists compilation, test, and cleanup commands but omits 9 formatting and build scripts that exist in `package.json`:

| Script | Command | Category |
|--------|---------|----------|
| `noir:fmt` | `cd noir && aztec fmt` | Formatting |
| `noir:fmt:check` | `cd noir && aztec fmt --check` | Formatting (CI) |
| `sol:fmt` | `cd solidity && forge fmt` | Formatting |
| `sol:fmt:check` | `cd solidity && forge fmt --check` | Formatting (CI) |
| `ts:build` | `tsc` | Build |
| `ts:fmt` | `prettier --write 'ts/**/*.ts' 'scripts/**/*.ts'` | Formatting |
| `ts:fmt:check` | `prettier --check 'ts/**/*.ts' 'scripts/**/*.ts'` | Formatting (CI) |
| `fmt` | `yarn sol:fmt && yarn noir:fmt && yarn ts:fmt` | Formatting (all) |
| `fmt:check` | `yarn sol:fmt:check && yarn noir:fmt:check && yarn ts:fmt:check` | Formatting (CI, all) |

**Action:** Add a "Formatting and build" subsection to Section 4.7 between "Compilation commands" (item 3) and "Unit tests" (item 4):

> **Formatting:**
> - `yarn fmt` -- Format all code (Noir, Solidity, TypeScript)
> - `yarn fmt:check` -- Check formatting without modifying files (CI use)
> - Individual: `yarn noir:fmt`, `yarn sol:fmt`, `yarn ts:fmt` (and corresponding `:check` variants)
>
> **TypeScript build:**
> - `yarn ts:build` -- Compile TypeScript (runs `tsc`)

### 13.8 dual-rollup-setup.sh Step Count Correction

Section 4.7 item 5 says `dual-rollup-setup.sh` is a "14-step governance flow." The script has 15 steps numbered 0 through 14 (inclusive). While minor, this should be accurate.

**Action:** Change "14-step" to "15-step (steps 0-14)" in Section 4.7 item 5.

### 13.9 Missing Public Methods on Proof Data Types

Section 4.5 documents proof data type **fields** but not their public **methods**. These methods are called by the library functions documented in Section 5.3 and are relevant to understanding the proof verification chain:

| Type | Method | Exact Signature | Purpose |
|------|--------|-----------------|---------|
| `NoteProofData<T>` | `verify_note_inclusion` | `(self, old_app: AztecAddress, note_hash: Field, note_hash_tree_root: Field) -> Field` | Verifies note is in the note hash tree via Merkle proof; returns the unique note hash |
| `NoteProofData<T>` | `note_hash` | `(self, note_owner: AztecAddress, expected_storage_slot: Field) -> Field` | Computes the note hash from data, owner, slot, and randomness |
| `KeyNoteProofData` | `verify_key_note_inclusion` | `(self, context: &mut PrivateContext, migration_archive_registry: AztecAddress, note_owner: AztecAddress, note_hash_tree_root: Field) -> Field` | Verifies key note inclusion in old rollup's key registry; internally reads `old_key_registry` from archive registry for address siloing |
| `PublicStateProofData<T, N>` | `public_state_hash` | `(self) -> Field` | Computes `poseidon2_hash(self.data.pack())` |
| `PublicStateProofData<T, N>` | `migrate_public_state` | `(self, context: &mut PrivateContext, base_storage_slot: Field, old_app: AztecAddress, public_state_tree_root: Field)` | Full public state migration: verify inclusion per slot, emit nullifier `[old_app, base_storage_slot]` |

These methods should be documented in the **mode docs** (`mode-a.md` and `mode-b.md`) as part of the proof verification chain descriptions, NOT in `integration-guide.md` (which focuses on TS-side API). The mode docs already describe the verification flow in prose; adding method names makes the prose traceable to code.

**Action:** When writing `mode-a.md` (Section 4.3) and `mode-b.md` (Section 4.4), include method names inline in the proof verification flow descriptions. For example, in `mode-b.md` Section 3 (proof chain -- private note migration), reference `note_proof_data.verify_note_inclusion()` and `note_proof_data.note_hash()` by name.

### 13.10 Structural Improvements

**a) Missing tone/voice guidance for writers.** Section 12.1 (Document Style Guide) defines formatting conventions but not prose tone. Add:

> **Tone:** Technical, concise, neutral. Write in present tense for system descriptions ("The library verifies...") and imperative for instructions ("Run `yarn test:setup`..."). Avoid marketing language. Use "PoC" not "prototype" or "demo." When documenting limitations, be direct ("This is not enforced" rather than "This could potentially be improved").

**b) Verbatim-vs-correction tension needs clearer rules.** Section 4.4 says content from `mode-b-architecture.md` must be preserved "verbatim" but also lists corrections (item 10, lines 165/168). The verbatim preservation rule (before Section 4.1) already addresses this, but writers may still be uncertain.

**Action:** Add to the verbatim preservation rule:

> When a correction is applied (as listed in Section 4.4 item 10 or Section 13.2), the corrected text replaces the original. All other content from `mode-b-architecture.md` remains verbatim. If in doubt, keep the original wording and add a correction note as a blockquote beneath it.

**c) CLAUDE.md Section 9 partially duplicates Section 3.4.** Section 9.1 (CLAUDE.md A2 file listing update) and Section 3.4 (migration from old to new structure) both describe the mapping from old files to new files. This is not a conflict -- Section 3.4 is for plan readers and Section 9.1 is the literal text to put in CLAUDE.md -- but writers should be aware they serve different purposes.

**Action:** Add a cross-reference note to Section 9.1:

> Note: The file paths listed here correspond to the new structure defined in Section 3.1. The old-to-new mapping is detailed in Section 3.4.

### 13.11 Mode-B Wallet Methods in Integration Guide

Section 4.5 item 7 documents the wallet class hierarchy but does not list the key proof-building methods on `BaseMigrationWallet` by name. These methods are the primary API surface for Mode B integrators.

**Action:** Add the following method list to Section 4.5 item 7, under `BaseMigrationWallet`:

> **Key methods on `BaseMigrationWallet`:**
> - `buildFullNoteProofs(notes, ...)` -- Build complete note proofs (inclusion + non-nullification) for Mode B private migration
> - `buildKeyNoteProofData()` -- Build proof data for the migration key note
> - `getMigrationDataEvents(contract, eventDecoder)` -- Retrieve encrypted migration data events from Mode A lock transactions
> - `buildMigrationNoteProofs(notes, ...)` -- Build note proofs for Mode A claim transactions
>
> These methods combine multiple lower-level proof-building functions into workflow-oriented APIs. Integrators should prefer these over calling `buildNoteProof`, `buildNullifierProof`, etc. directly.

### 13.12 NSK_MASK_DOMAIN Vestigial Status

Section 4.5 item 8 already notes that `NSK_MASK_DOMAIN = 1670` is "currently unused in active code (only in a commented-out line in `migration-account.ts:137`)." This is correct and sufficient. For additional clarity:

**Action:** Add a parenthetical to the `NSK_MASK_DOMAIN` mention in Section 4.5 item 8:

> `NSK_MASK_DOMAIN = 1670` (vestigial -- defined in `constants.ts` but only referenced in a commented-out line at `migration-account.ts:137`; related to the non-functional `getMask()` documented in TODO item 11)

This links the constant to its related TODO item, helping writers understand the full picture.

---

## Appendix A: Content Sourcing Maps

### A.1 Source Priority (per document)

| Target Document | Primary Source(s) | Secondary Source(s) | % Existing Content |
|----------------|-------------------|--------------------|--------------------|
| `index.md` | `migration-spec.md` overview | stub outlines | ~40% |
| `architecture.md` | `migration-spec.md` architecture, `mode-b-architecture.md` library section | TODO item 10 | ~55% |
| `mode-a.md` | `TODO_MODE_A.md` items 1-10 | `migration-spec.md` | ~65% |
| `mode-b.md` | `mode-b-architecture.md` (verbatim), `TODO_MODE_B.md` items 1-8 | `migration-spec.md` | ~75% |
| `integration-guide.md` | `inconsistencies.md` STUB-8 outline, TODO items 9-10 | test files, code | ~45% |
| `threat-model.md` | `TODO_MODE_A.md` items 4, 7, 8; `TODO_MODE_B.md` items 5, 6 | `migration-spec.md` key decisions | ~50% |
| `operations.md` | `package.json`, `inconsistencies.md` docs backlog, Solidity code | `dual-rollup-setup.sh` | ~60% |
| `spec/migration-spec.md` | Existing spec + code verification | `inconsistencies.md` | ~85% retained |

### A.2 Specific Harvest Map

| Source File | Item(s) | Destination | Section in Destination |
|-------------|---------|-------------|----------------------|
| `TODO_MODE_A.md` | 1 (Schnorr) | `mode-a.md` | Authentication |
| `TODO_MODE_A.md` | 2 (batching) | `mode-a.md` | Batching |
| `TODO_MODE_A.md` | 3 (events) | `mode-a.md` | Lock flow |
| `TODO_MODE_A.md` | 4 (supply cap) | `threat-model.md` | PoC limitations |
| `TODO_MODE_A.md` | 5 (public balance) | `mode-a.md` | Public balance migration |
| `TODO_MODE_A.md` | 7 (unchecked witness) | `mode-a.md`, `threat-model.md` | PoC limitations (both) |
| `TODO_MODE_A.md` | 8 (permissionless L1) | `mode-a.md`, `threat-model.md` | PoC limitations (mode-a), Threat scenarios (threat-model) |
| `TODO_MODE_A.md` | 9 (MSK) | `mode-a.md`, `integration-guide.md` | Authentication (mode-a), Key derivation (integration) |
| `TODO_MODE_A.md` | 10 (decompose) | `mode-a.md`, `architecture.md`, `integration-guide.md` | Batching (mode-a), Three-layer pattern (architecture, integration) |
| `TODO_MODE_B.md` | 1 (Schnorr) | `mode-b.md` | Authentication model |
| `TODO_MODE_B.md` | 2 (siloed nullifier) | `mode-b.md` | Address verification |
| `TODO_MODE_B.md` | 3 (batching) | `mode-b.md` | (brief note) |
| `TODO_MODE_B.md` | 4 (public state) | `mode-b.md` | Public state migration |
| `TODO_MODE_B.md` | 5 (snapshot governance) | `mode-b.md`, `threat-model.md` | Snapshot height, PoC limitations |
| `TODO_MODE_B.md` | 6 (supply cap) | `mode-b.md`, `threat-model.md` | PoC limitations (both) |
| `TODO_MODE_B.md` | 8 (decompose) | `mode-b.md`, `architecture.md`, `integration-guide.md` | (done note in mode-b), Three-layer pattern (architecture, integration) |
| `mode-b-architecture.md` | All sections | `mode-b.md` | Entire document (verbatim where possible) |
| Test files | Code patterns, failure cases | `integration-guide.md` | TS client flow, error handling |

---

## Appendix B: Open Decision Handling

### B.1 Resolved Decisions

| OD | Resolution | Impact |
|----|-----------|--------|
| OD-1 | **NON-ISSUE.** Code already implements 2-field `[old_app, base_storage_slot]` matching spec. `inconsistencies.md` references stale code state. | No placeholder needed. Document the formula as-is. Update `mode-b-architecture.md` line 165 (absorbed into `mode-b.md`) to remove `field_index`. |
| OD-2 | Demoted to ARCH-DYN. Spec text update only. | Handled in Section 5.1. |
| OD-4 | **Merge** into `mode-b.md`. | `mode-b-architecture.md` content absorbed verbatim. |
| OD-6 | **Token-first, NFT out of scope.** Brief note that code exists. | `NftMigrationApp` mentioned in `index.md` and spec, not covered in detail. |

### B.2 Remaining Decisions (with placeholder strategy)

| OD | Status | Placeholder Strategy |
|----|--------|---------------------|
| OD-3 (placeholder constants) | **Open** but does NOT block writing. | Document constants with their current placeholder values. Use `> **TODO:**` callouts noting they must be replaced. Do NOT use `[BLOCKED]` markers. |
| OD-5 (production warnings scope) | **Open** but does NOT block writing. | Write PoC limitations with "NOT FOR PRODUCTION" headers. If OD-5 decides to remove these, removal is mechanical. |

### B.3 Rework Risk Assessment

| OD | Rework Risk | Mitigation |
|----|-------------|-----------|
| OD-3 | **LOW** -- Only affects literal hex values in TODO callouts | Use symbolic names (`CLAIM_DOMAIN_B_PUBLIC`) not hex values in prose. Callouts already flag them as placeholders. |
| OD-5 | **LOW** -- If "wait for hardening" wins, warning sections are removed | Written warnings are easier to remove than to create from scratch. |

---

*End of documentation update plan.*
