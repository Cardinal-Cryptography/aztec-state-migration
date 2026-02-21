# Docs vs Code Inconsistencies

> **Purpose:** Track gaps between documentation and code to plan doc changes.
> Each item has an ID, severity, target doc, required change, and done-when criteria.
>
> **Scope:** This file covers documentation accuracy only. Test gaps, code cleanup,
> and package script documentation are tracked separately (see bottom).
>
> **Workflow:** Fix P0 items first, then P1, then P2. Open decisions block their
> dependent items and need engineering sign-off before writing.
>
> **Last verified:** commit `b3d948a` on branch `jk-handle-maps-better`

---

**Fix priority:** Resolve Open Decisions first (they block doc accuracy). Then P0 security issues, then P1 missing docs, then P2 terminology.

> **ID scheme:** Prefixed IDs (`OD-`, `CRIT-`, `REF-`, `STUB-`, `ARCH-`, `T-`) are canonical. Plain numeric IDs (10-22, 32-35) are legacy from the initial audit; new items use prefixed IDs.

---

## Open Decisions

These items need engineering agreement before documentation can be written.

### OD-1. Nullifier formula for Mode B public state migration

- **Context:** Spec says `poseidon2_with_sep([old_app, storage_slot, field_index], GEN)` (3-field). Code does `poseidon2_hash_with_separator([base_storage_slot], GEN)` (1-field) in `public_state_proof_data.nr`, method `migrate_public_state`. The code nullifier is siloed by `push_nullifier` under the NEW app address, not the old app. The current single-old-app-per-contract architecture makes a collision unlikely in practice, but the spec's 3-field formula provides defense-in-depth: including `old_app` and `field_index` explicitly would prevent collisions if the architecture ever generalizes (e.g., multiple old app sources). This is a real code-spec mismatch that should be resolved.
- **Decision needed:** Update the code to match the spec formula. This is a security fix, not a design question.
- **Doc impact:** Blocks writing the "Migration Nullifiers" section of any doc (spec, mode-b-details, mode-b-architecture).

### OD-3. Placeholder / TODO constants in domain separators and generator indices

- **Context:** Three constants in `noir/migration_lib/src/constants.nr` have placeholder values with TODO comments:
  1. `CLAIM_DOMAIN_B_PUBLIC = 0xdeafbeef` — placeholder domain separator for Mode B public state claims. Mirrored in `ts/migration-lib/constants.ts`.
  2. `GENERATOR_INDEX__PUBLIC_MIGRATION_NULLIFIER = 0x12345678` — placeholder generator index used as the Poseidon2 separator in `migrate_public_state` (`mode_b/public_state_proof_data.nr`). This is arguably the most security-critical placeholder because it directly affects nullifier uniqueness.
  3. `CLAIM_DOMAIN_A` is aliased to `MIGRATION_MODE_A_STORAGE_SLOT` with a `TODO: use a different domain separator` comment. Reusing a storage slot as a domain separator is not a collision risk in practice, but violates domain separation hygiene.
- **Decision needed:** Assign real Poseidon2-derived values for all three constants before production.
- **Doc impact:** Blocks documenting the domain separation constants and nullifier derivation accurately.

### OD-4. Mode B docs structure

- **Context:** `docs/mode-b-architecture.md` exists with substantive content. `docs/mode-b-details.md` is a TODO stub. Both are referenced from `docs/index.md`.
- **Decision needed:** Merge into one file or keep separate (architecture overview vs implementation details)?
- **Doc impact:** Blocks STUB-7 writing and all Mode B cross-linking.

### OD-5. Production security warnings scope

- **Context:** `TODO_MODE_A.md` #7 notes `old_app_address` is an unchecked witness. Both TODOs note the new app mints freely without supply cap. Additional PoC simplifications specific to `ExampleMigrationApp`: `mint()` and `burn()` have no access control (anyone can call them); `init_struct_single`, `init_struct_map`, `init_owned_struct_map`, and `init_owned_struct_nested_map` lack `#[only_self]` (anyone can overwrite public struct state). These are intentional PoC simplifications, not intended production behavior. Note: `NftMigrationApp` does NOT share these issues — it has `minter` checks and `nft_exists` protection.
- **Decision needed:** Should docs document current PoC behavior with explicit security warnings ("do not use in production without X"), or wait for production hardening before writing?
- **Doc impact:** Blocks threat model sections and the integration guide deployment checklist.

### OD-6. NFT migration doc scope

- **Context:** `NftMigrationApp` is a complete contract implementing Mode A + Mode B for NFTs (private + public), but no doc mentions it.
- **Decision needed:** Should docs cover it as a full second example, or stay token-first with a note that "the pattern generalizes to NFTs"?
- **Doc impact:** Blocks item 10 and determines whether the integration guide covers NFT-specific patterns.

### Decision Log

*(Record resolved decisions here with date and commit hash)*

---

## Critical Mismatches (P0)

### 1. Public state migration nullifier formula

| Field | Value |
|---|---|
| **ID** | CRIT-1 |
| **Status** | BLOCKED on OD-1 (needs engineering decision first) |
| **Severity** | P0 (security) |
| **Doc files** | `docs/spec/migration-spec.md`, section "Migration Nullifiers"; `docs/mode-b-architecture.md`, section "Public state migration" |
| **Code file** | `noir/migration_lib/src/mode_b/public_state_proof_data.nr`, method `migrate_public_state` |
| **Detail** | See OD-1 for full security reasoning. Spec uses 3-field hash; code uses 1-field hash. |
| **Required change** | Update code to match spec (see OD-1). After code change, verify doc text is consistent. |
| **Done when** | Code includes `old_app`, `storage_slot`, `field_index` in nullifier hash, and spec text matches. |

---

## Broken References (P1)

### 2. Storage slot constant name in code comment

| Field | Value |
|---|---|
| **ID** | REF-2 |
| **Severity** | P1 |
| **Comment says** | `MIGRATION_NOTE_STORAGE_SLOT` |
| **Actual constant** | `MIGRATION_MODE_A_STORAGE_SLOT` |
| **Code file** | `noir/migration_lib/src/mode_a/ops.nr:31` |
| **Required change** | Fix the comment to say `MIGRATION_MODE_A_STORAGE_SLOT`. |
| **Done when** | Comment matches constant name. |

### 3. CLAUDE.md references 6 nonexistent doc files

| Field | Value |
|---|---|
| **ID** | REF-3 |
| **Severity** | P1 |
| **Referenced files** | `docs/arch/overview.md`, `docs/arch/flows.md`, `docs/arch/threat-model.md`, `docs/ops/testing.md`, `docs/ops/deploy.md`, `docs/ops/troubleshooting.md` |
| **Actual state** | Directories `docs/arch/` and `docs/ops/` do not exist. |
| **Location** | `CLAUDE.md:40-47` |
| **Required change** | Either create the docs (preferred, using content from stub outlines below) or remove the references from CLAUDE.md. |
| **Done when** | Every file path in CLAUDE.md section A2 points to a file that exists and has content. |

**Content outlines for referenced files:**
- `docs/arch/overview.md`: Architecture overview — components (Noir migration_lib, app contracts, MigrationArchiveRegistry, MigrationKeyRegistry, L1 Migrator), their relationships, and deployment topology (old rollup, new rollup, L1).
- `docs/arch/flows.md`: Step-by-step Mode A and Mode B flows with sequence diagrams. Can be derived from STUB-6 and STUB-7 outlines.
- `docs/arch/threat-model.md`: Trust assumptions (L1 anchor, permissionless bridging), threat scenarios (front-running, double-claim, replay), and mitigations (Schnorr signatures, nullifiers, domain separation).
- `docs/ops/testing.md`: How to run tests (`yarn test:setup`, `yarn test:mode-a`, `yarn test:mode-b`, `yarn check:full`), dual-rollup sandbox setup (`dual-rollup-setup.sh`, `start-node-with-time-sync.mjs`), required ports (8080, 8081), environment variables.
- `docs/ops/deploy.md`: Deployment steps if applicable, or mark as N/A for PoC.
- `docs/ops/troubleshooting.md`: Common local failures (ports in use, sandbox not running, Anvil time-warp issues).

### 4. CLAUDE.md references `docs/solidity/overview.md`

| Field | Value |
|---|---|
| **ID** | REF-4 |
| **Severity** | P1 |
| **Referenced file** | `docs/solidity/overview.md` |
| **Actual state** | `docs/solidity/` directory does not exist. |
| **Location** | `CLAUDE.md:~165` (B6, Solidity guidelines) |
| **Required change** | Create the file with Solidity interface documentation, or remove the reference. Should cover `Migrator.sol`, `Poseidon2Deploy.sol`, and `RegisterNewRollupVersionPayload.sol`. |
| **Done when** | Reference resolves to a real file or is removed. |

---

## Stub Documentation (P1)

These files exist but contain only `TODO` placeholders. Each subsection below includes a condensed outline based on what the code actually implements. Use these outlines as starting points when writing the real content.

### 5. `docs/problem-and-solution.md`

| Field | Value |
|---|---|
| **ID** | STUB-5 |
| **Target file** | `docs/problem-and-solution.md` |
| **Referenced from** | `docs/index.md:12` |
| **Done when** | File contains substantive content covering at least the sections below. |

**Outline:**
- **Problem:** Aztec version upgrades create new rollup instances. User state (private notes, public balances, NFTs) is stranded on the old rollup. Privacy constraints prevent simple state export.
- **Solution overview:** Two migration modes anchored by L1 archive roots.
  - Mode A (cooperative): Old rollup is live. Users lock assets on old rollup, claim on new rollup using inclusion proofs.
  - Mode B (emergency): Old rollup is halted. Users prove state at a snapshot height using non-nullification proofs.
- **Trust assumptions:** L1 is trusted as anchor. Archive root bridging is permissionless. Schnorr signatures prevent front-running.
- **Scope:** Native application state only. Bridged/non-native assets are out of scope (see `non-native-assets.md`).

### 6. `docs/mode-a-details.md`

| Field | Value |
|---|---|
| **ID** | STUB-6 |
| **Target file** | `docs/mode-a-details.md` |
| **Referenced from** | `docs/index.md:13` |
| **Done when** | File documents the lock/claim flow, authentication, nullifier derivation, and public balance migration. |

**Outline:**
- **Lock flow (library):** `lock_migration_notes` creates MigrationNote and emits encrypted `MigrationDataEvent`. Balance changes (decrement) are handled at the app level.
- **Claim flow (library):** `migrate_notes_mode_a` verifies MigrationNote inclusion proof and emits nullifier (per note in the loop), then checks Schnorr signature (after loop), and enqueues a two-step archive verification: (1) `register_block` (called separately) verifies a block header against a consumed L1-bridged archive root via Merkle proof and stores the block hash; (2) `verify_migration_mode_a(block_number, block_hash)` (enqueued by the library) checks the block hash against the pre-registered value. The app contract mints after the library call succeeds.
- **Public balance migration (app-level wrappers):** `lock_public_for_migration` + `migrate_to_public_mode_a` are app-level wrappers, not library functions. Same inclusion proof, different mint target.
- **Authentication:** Schnorr signature over `poseidon2(CLAIM_DOMAIN_A, old_rollup, new_rollup, notes_hash, recipient, new_app)`. MSK derived deterministically via `sha512ToGrumpkinScalar`.
- **Nullifier derivation:** Uses MigrationNote randomness (not user secret key) to prevent cross-rollup identity linking.
- **Batching:** Library circuit accepts `[MigrationNoteProofData; N]`. ExampleApp hardcodes N=1 (sufficient for fungible tokens).
- **Archive relay:** L1 `migrateArchiveRoot()` bridges root; `register_block` verifies block header via Merkle proof.
- **Known limitations:** No supply cap enforcement, `old_app_address` is unchecked witness, L1 relay is permissionless (spam risk).
- **Wallet integration:** Wallet classes (`BaseMigrationWallet`, `MigrationTestWallet`) and key derivation.

### 7. `docs/mode-b-details.md`

| Field | Value |
|---|---|
| **ID** | STUB-7 |
| **Status** | BLOCKED on OD-4 (merge-vs-separate decision for Mode B docs) |
| **Target file** | `docs/mode-b-details.md` |
| **Referenced from** | `docs/index.md:14` |
| **Done when** | File documents all three migration paths, key registry, and snapshot governance. |

**Outline:**
- **Snapshot mechanism:** `set_snapshot_height` (write-once via `initialize()`) sets the reference block. Before storing, it verifies the snapshot block header against a consumed archive root via Merkle proof (`root_from_sibling_path`), ensuring the snapshot references a real block in the old rollup's archive tree.
- **Private note migration:** `migrate_notes_mode_b` proves note inclusion, nullifier non-inclusion (note was not spent), and owner identity via `nsk` derivation. Schnorr signature with `CLAIM_DOMAIN_B`. Requires `expected_storage_slot` parameter -- the app must pass the storage slot matching the old rollup's layout (e.g., `STORAGE_LAYOUT.fields.balances.slot`).
- **Public standalone state migration:** `migrate_public_state_mode_b` proves value in public data tree at snapshot height. Deterministic nullifier prevents double-claim.
- **Public map state migration:** `migrate_public_map_state_mode_b` derives storage slot from `base_storage_slot` + `map_keys` via iterated `poseidon2_hash`. `migrate_public_map_owned_state_mode_b` adds Schnorr auth + `MigrationKeyNote` proof for owned entries. The `MigrationKeyNote` inclusion proof is siloed by the **old rollup's** key registry address (obtained via `get_old_key_registry()` on `MigrationArchiveRegistry`), which is a cross-rollup detail important for correct verification.
- **Key registry:** `MigrationKeyRegistry` uses `PrivateImmutable` with `initialize()` (already immutable). Users register migration public key before snapshot.
- **Address verification:** `nsk` proves ownership by deriving `npk_m` and recomputing the owner address in-circuit.
- **Governance:** Snapshot height has no access control beyond write-once. Production should restrict to governance.

> **Note:** `docs/mode-b-architecture.md` already exists with substantive content. See OD-4 for the merge-vs-separate decision that must be made before writing this doc.

### 8. `docs/integration-guide.md`

| Field | Value |
|---|---|
| **ID** | STUB-8 |
| **Target file** | `docs/integration-guide.md` |
| **Referenced from** | `docs/index.md:15` |
| **Done when** | File provides step-by-step integration instructions for app developers. |

**Outline:**
- **Library pattern:** `migration_lib` provides composable functions. App contracts import and call them. No inheritance.
- **Minimal contract structure:** Import `lock_migration_notes` / `migrate_notes_mode_a` (Mode A) or `migrate_notes_mode_b` / `migrate_public_state_mode_b` (Mode B). Wire up storage and call patterns.
- **TS client data flow:**
  - Mode A: `deriveMasterMigrationSecretKey` -> `signMigrationModeA` -> `buildMigrationNoteProof` (from `mode-a/proofs.ts`, combines note proof with `MigrationDataEvent` data) + `buildArchiveProof` (or `buildBlockHeader` as an alternative) -> submit transaction. `getMigrationDataEvents()` retrieves encrypted event data (this is a method on `BaseMigrationWallet`, not a standalone export).
  - Mode B (private): `deriveMasterMigrationSecretKey` -> `signMigrationModeB` -> `buildNoteProof` + `buildArchiveProof` -> submit transaction.
  - Mode B (public): `buildPublicDataProof` (standalone struct), `buildPublicMapDataProof` (map-derived slot), or `buildPublicDataSlotProof` (low-level single-slot) from `mode-b/proofs.ts`. `signPublicStateMigrationModeB` for owned entries.
- **Proof data types:** Noir types: `NoteProofData`, `MigrationNoteProofData`, `FullNoteProofData`, `PublicStateProofData`, `KeyNoteProofData`. TS equivalents: `NoteProofData` (top-level `types.ts`, not mode sub-modules), `FullProofData`, `NonNullificationProofData`, `PublicDataProof`, `PublicDataSlotProof`, `KeyNote`. Note: Noir `PublicStateProofData` maps to TS `PublicDataProof` (naming difference). Noir `KeyNoteProofData` maps to TS `NoteProofData<KeyNote>` (where `KeyNote` is the inner note type).
- **Deployment checklist:** Set `old_app_address`, configure `MigrationArchiveRegistry`, bridge first archive root.
- **Error handling:** Common failure modes (archive root not bridged, wrong old_app_address, signature mismatch).

### 9. `docs/non-native-assets.md`

| Field | Value |
|---|---|
| **ID** | STUB-9 |
| **Target file** | `docs/non-native-assets.md` |
| **Referenced from** | `docs/index.md:16` |
| **Done when** | File explains scope exclusion and potential strategies. |

**Outline:**
- **Scope:** This migration system covers native application state only (notes and public storage belonging to the app contract).
- **Why excluded:** Bridged assets (tokens from L1 or other L2s) have custody on external contracts. Migration requires coordination with the bridge protocol, not just state proofs.
- **Potential strategies:** L1 bridge migration (re-bridge to new rollup address), wrapped asset approach, governance-coordinated migration.

---

## Undocumented Features (P1)

Fully implemented features with no documentation. Grouped by target doc file.

> **Doc target note:** A doc writer should collect the "TS migration-lib API" items below into the integration guide's API reference section (STUB-8). Items 10-14, 22, 22a belong in the spec's API tables.

### Target: `docs/integration-guide.md` — TS migration-lib API

These items structure the API reference section of the integration guide. Grouped by domain:

**Identity & Wallets:**
- `MigrationAccount` interface — core interface defining migration-specific account capabilities (key derivation, signing, masked NSK). Re-exported from top-level `index.ts`. (`ts/migration-lib/wallet/migration-account.ts`)
- `BaseMigrationWallet`, `MigrationTestWallet`, `BaseMigrationAccount`, `SignerlessMigrationAccount` (`ts/migration-lib/wallet/*.ts`)
- `deriveMasterMigrationSecretKey` (`ts/migration-lib/keys.ts`)

**Signing:**
- `signMigrationModeA`, `signMigrationModeB`, `signPublicStateMigrationModeB` (`ts/migration-lib/keys.ts`)
- `MigrationSignature` type and `fromBuffer`/`fromSchnorrSignature` factory (`ts/migration-lib/types.ts`) — **not** re-exported from top-level `index.ts`; used internally by wallet and key modules

**Proof Generation:**
- `buildNoteProof`, `buildArchiveProof`, `buildBlockHeader` (`ts/migration-lib/proofs.ts`)
- `ArchiveProofData` type (`ts/migration-lib/types.ts`)
- `blockHeaderToNoir()` (`ts/migration-lib/noir-helpers/block-header.ts`)

**L1 Bridging & Polling:**
- `migrateArchiveRootOnL1`, `waitForL1ToL2Message`, `waitForBlockProof`, `poll` (`ts/migration-lib/bridge.ts`, `polling.ts`)
- `PollOptions<T>` interface — configuration for the `poll()` utility (check callback, `intervalMs`, maxAttempts). Re-exported from top-level `index.ts`. (`ts/migration-lib/polling.ts`)
- `L1MigrationResult` type (`ts/migration-lib/types.ts`)

**Constants:**
- `MSK_M_GEN`, `NSK_MASK_DOMAIN`, `MIGRATION_NOTE_SLOT`, `CLAIM_DOMAIN_A/B/B_PUBLIC`, `MIGRATION_DATA_FIELD_INDEX` (`ts/migration-lib/constants.ts`)

**Mode sub-module exports (not re-exported from top-level `index.ts`):**
- `mode-a/` (`ts/migration-lib/mode-a/index.ts`): `MigrationNote`, `MigrationNoteProofData<T>`, `buildMigrationNoteProof`
- `mode-b/` (`ts/migration-lib/mode-b/index.ts`): `FullProofData`, `NonNullificationProofData`, `PublicDataSlotProof`, `PublicDataProof`, `KeyNote`, `buildPublicDataSlotProof`, `buildPublicDataProof`, `buildPublicMapDataProof`

**Done when:** Each function/type has at least a usage description in `docs/integration-guide.md`.

### Target: `docs/spec/migration-spec.md` (API table updates)

| ID | Feature | Code location |
|----|---------|---------------|
| 10 | NftMigrationApp — implements Mode A + Mode B for NFTs (private + public) | `noir/contracts/nft_migration_app/src/main.nr` |
| 11 | `migrateArchiveRoot()` — primary L1 function to bridge the latest proven archive root to a new rollup | `solidity/contracts/Migrator.sol`, function `migrateArchiveRoot` |
| 11a | `migrateArchiveRootAtBlock()` — L1 function to register historical blocks at a specific height | `solidity/contracts/Migrator.sol`, function `migrateArchiveRootAtBlock` |
| 12 | `getArchiveInfo()` — L1 view function for off-chain clients | `solidity/contracts/Migrator.sol`, function `getArchiveInfo` |
| 13 | `ArchiveRootMigrated` event on L1 | `solidity/contracts/Migrator.sol`, event `ArchiveRootMigrated` |
| 14 | Four public state migration variants: `migrate_to_public_struct_mode_b`, `migrate_to_public_struct_map_mode_b`, `migrate_to_public_owned_struct_map_mode_b`, `migrate_to_public_owned_struct_nested_map_mode_b` | `noir/contracts/example_app/src/main.nr`, functions `migrate_to_public_struct_mode_b` through `migrate_to_public_owned_struct_nested_map_mode_b` |
| 22 | MigrationArchiveRegistry view functions: `get_block_hash`, `get_snapshot_height`, `get_snapshot_block_hash`, `get_latest_proven_block` (unconstrained), `get_old_key_registry` (`#[external("private")]` -- not unconstrained, callable from private context for cross-rollup siloing). **Note:** Constructor params (`l1_migrator`, `old_rollup_version`, `old_key_registry`) are missing from the spec API table. | `noir/contracts/migration_archive_registry/src/main.nr` |
| 22a | `consume_l1_to_l2_message_and_register_block` — convenience function combining L1 message consumption and block registration | `noir/contracts/migration_archive_registry/src/main.nr`, function `consume_l1_to_l2_message_and_register_block` |

**Done when:** Each feature has an entry in the spec's API table or a dedicated subsection.

---

## Terminology Map (P2)

Canonical terms for cross-language consistency. When writing docs, use the Noir name as the primary term and note the TS alias.

| ID | Noir name | TS name | Same value? | Doc change needed | Done when |
|----|-----------|---------|-------------|-------------------|-----------|
| 32 | `destination_rollup` (struct field, including `MigrationNote.destination_rollup`) | `dest_rollup_id` (spec text) / `destination_rollup` (spec API table) | N/A (naming only) | Pick one name in docs. The spec itself is internally inconsistent — body text uses `dest_rollup_id` while the API table uses `destination_rollup`. Code uses `destination_rollup`. Reconcile to a single name across spec and code. | Docs and spec use one consistent name for the rollup field |
| 35 | `CLAIM_DOMAIN_B_PUBLIC` | `CLAIM_DOMAIN_B_PUBLIC` | Yes (`0xdeafbeef`) | Document that this is a placeholder. See OD-3. | Docs note the placeholder status and link to OD-3 for the code change decision |
| T-1 | `MIGRATION_MODE_A_STORAGE_SLOT` | `MIGRATION_NOTE_SLOT` | Yes (same hex value) | Docs should note both names refer to the same constant. | Both names noted in docs where the constant is referenced |
| T-2 | `old_rollup_app_address` (code, storage field) | `TokenV1_address` (spec text) | N/A (naming only) | Spec uses abstract `TokenV1_address`; code uses `old_rollup_app_address`. Docs should pick one canonical name (recommend `old_rollup_app_address` as it generalizes beyond tokens) and note the spec alias. | Docs use one consistent name for the old app address config |
| T-3 | N/A (Noir does not call L1 directly) | `getProvenCheckpointNumber` (Solidity, `Migrator.sol`) vs `proven_block_number` (spec text) | N/A (naming only) | Solidity uses `getProvenCheckpointNumber`; spec uses `proven_block_number`. Docs should reconcile or note both names. | Docs use one consistent name and note the Solidity alias |

---

## Spec Gaps (P1)

These block writing the spec and integration guide. Promoted from P2 because they are prerequisites for stub doc content.

### 47. Foundry/Solidity Aztec version differs from Noir Aztec version

| Field | Value |
|---|---|
| **ID** | ARCH-47 |
| **Severity** | **P1** (promoted from P2 -- blocks integration guide) |
| **Detail** | `solidity/foundry.toml` references Aztec `v3.0.2`. `noir/*/Nargo.toml` uses `v3.0.0-devnet.6-patch.1`. This version split is not documented anywhere. |
| **Required change** | Document the version split in the integration guide or a setup doc, explaining why two versions coexist (if intentional) or align them. |
| **Done when** | Version info is documented or versions are aligned. |

### ARCH-DYN. Spec claims immutable rollup ID config; code uses dynamic reads

| Field | Value |
|---|---|
| **ID** | ARCH-DYN |
| **Severity** | **P1** |
| **Detail** | Spec explicitly states `old_rollup_id` and `dest_rollup_id` are immutable configuration values. Code reads them dynamically: `old_rollup` from `block_header.global_variables.version` and `current_rollup` from `context.version()`. The dynamic approach is intentional and superior (avoids wasted storage). |
| **Code locations** | `mode_a/ops.nr`, function `migrate_notes_mode_a`; `mode_b/ops.nr`, function `migrate_notes_mode_b` |
| **Required change** | Update spec to describe the dynamic read pattern instead of "immutable config." |
| **Done when** | Spec text matches code's dynamic approach. |

### 49. Library vs app-level function distinction not explained

| Field | Value |
|---|---|
| **ID** | ARCH-49 |
| **Severity** | **P1** (promoted from P2 -- blocks spec and integration guide) |
| **Detail** | `docs/spec/migration-spec.md` documents app-level function signatures (e.g. `migrate_mode_a`). `noir/migration_lib/src/mode_a/ops.nr`, function `migrate_notes_mode_a` has a different (library-level) signature. The distinction between library functions and app-level wrappers is not explained. |
| **Required change** | Split the spec API table into two sections: (1) App-Level Interfaces (what developers expose in their contracts) and (2) Library Interfaces (what `migration_lib` provides). Add an explanation of the composition pattern to the integration guide. |
| **Done when** | Both signature levels are documented with their relationship explained. |

### 50. Proof data type structs not defined in spec

| Field | Value |
|---|---|
| **ID** | ARCH-50 |
| **Severity** | **P1** (promoted from P2 -- blocks spec data types section) |
| **Detail** | All proof data types (`NoteProofData`, `MigrationNoteProofData`, `FullNoteProofData`, `PublicStateProofData`, `KeyNoteProofData`, `NonNullificationProofData`) are essential API types used by migration functions but none are defined in the spec. `NoteProofData` is defined in `noir/migration_lib/src/note_proof_data.nr`; `NonNullificationProofData` in `noir/migration_lib/src/mode_b/non_nullification_proof_data.nr`; others in their respective mode files. |
| **Required change** | Add struct definitions for all proof data types to the spec's data types section. |
| **Done when** | Spec includes all proof data types with field descriptions. |

---

## Architectural Context Gaps (P1/P2)

These are not errors in existing docs but missing context that affects documentation accuracy.

### NEW-1. `MigrationDataEvent` pipeline underspecified

| Field | Value |
|---|---|
| **ID** | ARCH-NEW-1 |
| **Severity** | **P1** (promoted from P2 -- integration guide (STUB-8) depends on understanding this pipeline) |
| **Detail** | Spec line 188 mentions `MigrationDataEvent` and `txHash` matching but does not explain the encryption/decryption pipeline or the manual `EventInterface` implementation (needed because `#[event]` macro does not support generics). |
| **Required change** | Add a subsection to Mode A details or integration guide covering the event pipeline: encryption/decryption, the manual `EventInterface` implementation, retrieval via `getMigrationDataEvents()`, and `txHash` matching (which the spec mentions but doesn't detail). |
| **Done when** | Event pipeline is documented end-to-end. |

### NEW-2. `TODO_MODE_B.md` item 7 is outdated

| Field | Value |
|---|---|
| **ID** | ARCH-NEW-2 |
| **Severity** | P2 |
| **Detail** | `TODO_MODE_B.md` item 7 says "Make registered_keys Immutable in MigrationKeyRegistry" and discusses preventing updates. The code already uses `PrivateImmutable` with `initialize()` in `noir/contracts/migration_key_registry/src/main.nr` (storage declaration and `register` function), making this TODO incorrect. |
| **Required change** | Mark item 7 in `TODO_MODE_B.md` as done (with strikethrough, matching the convention used for other done items). |
| **Done when** | Item 7 is marked `~~done~~` with a brief note that `PrivateImmutable` + `initialize()` already enforces immutability. |

---

## Harvestable TODO Items (already done in code)

These items in `TODO_MODE_A.md` and `TODO_MODE_B.md` are marked done. Content from their descriptions can be harvested into the stub docs above.

> **Harvest value:** These items contain detailed pseudocode and explanations, not just one-liners. Estimated 60-70% of the technical doc content (`mode-a-details.md`, `mode-b-details.md`, `integration-guide.md`) can be populated from TODO item descriptions. `problem-and-solution.md` and `non-native-assets.md` will need to be written from scratch.

| Source | Item | Content to harvest into | Related STUB |
|--------|------|------------------------|--------------|
| `TODO_MODE_A.md` | 1 (Schnorr auth) | `mode-a-details.md` authentication section | STUB-6 |
| `TODO_MODE_A.md` | 3 (migration_data_hash) | `mode-a-details.md` data event section | STUB-6 |
| `TODO_MODE_A.md` | 5 (public balance) | `mode-a-details.md` public balance section | STUB-6 |
| `TODO_MODE_A.md` | 9 (MSK persistence) | `integration-guide.md` key derivation section | STUB-8 |
| `TODO_MODE_A.md` | 10 (decompose lib) | `integration-guide.md` library architecture section | STUB-8 |
| `TODO_MODE_B.md` | 1 (Schnorr) | `mode-b-details.md` authentication section | STUB-7 |
| `TODO_MODE_B.md` | 2 (siloed nullifier) | `mode-b-details.md` nullifier section | STUB-7 |
| `TODO_MODE_B.md` | 3 (single note) | `mode-b-details.md` batching section | STUB-7 |
| `TODO_MODE_B.md` | 4 (public state) | `mode-b-details.md` public state section | STUB-7 |
| `TODO_MODE_B.md` | 8 (decompose) | `integration-guide.md` library architecture section | STUB-8 |

> **Retire plan:** Once content from done items is migrated into real docs, either delete `TODO_MODE_A.md` / `TODO_MODE_B.md` or clearly mark them as archived (read-only, not source of truth). This prevents stale TODO items from contradicting verified code (see ARCH-NEW-2).

---

## Tracked Elsewhere

### Engineering/QA Backlog

| Category | Summary |
|----------|---------|
| Test coverage gaps | 7 spec requirements without test coverage (double-claim, supply cap, batching, access control, etc.) |
| Code cleanup | Typo in `getEnryptedNskApp`, unexported `buildNullifierProof`, stale FIXMEs, `getMigrationNotes` returning migrated notes |

### Docs Backlog (ops/dev)

| Category | Summary | Target doc |
|----------|---------|------------|
| Package scripts | 9 undocumented `yarn` scripts (fmt, build, clean, etc.) | `docs/ops/testing.md` |
| Environment variables | `AZTEC_NODE_URL`, `AZTEC_OLD_URL`, `AZTEC_NEW_URL`, `ETHEREUM_RPC_URL` undocumented | `docs/ops/testing.md` |
| Dual-rollup testing infra | `dual-rollup-setup.sh`, `start-node-with-time-sync.mjs`, Anvil time-warp workarounds | `docs/ops/testing.md` |
| Test script coverage | `check:full` omits `test:registry` and `test:hash` — these tests are not exercised in the full verification flow | `docs/ops/testing.md` |

---

## Removed Items

| Old ID | Reason |
|--------|--------|
| OD-2 | Demoted to Spec Gaps section as ARCH-DYN (spec claims immutable rollup ID config; code uses dynamic reads). Not an open decision — the code approach is correct; only the spec text needs updating. |
| 33 | Merged into item 32 (duplicate — both covered `destination_rollup` vs `dest_rollup_id` naming). |
| 34 | False positive. Spec uses abstract names (`TokenV1`/`TokenV2`) as is standard practice for specifications. Code using `ExampleMigrationApp` for both roles is expected. No doc change needed. |
