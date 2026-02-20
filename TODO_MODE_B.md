# Mode B PoC - Known Limitations & Future Work

## ~~1. Schnorr Signature Authentication~~ (Done)

`mode_b/ops.nr` uses `schnorr::verify_signature(mpk, signature, msg)` with a domain-separated message:
```
msg = poseidon2(CLAIM_DOMAIN_B, old_rollup, current_rollup, notes_hash, recipient, new_app)
sig = schnorr_sign(msk, msg)   // off-chain
schnorr_verify(sig, mpk, msg)  // in-circuit
```
The message binds the claim to a specific recipient and app contract, preventing front-running. `msk` stays entirely off-chain.

## ~~2. Unchecked Siloed Nullifier Witness~~ (Done)

`migrate_note()` in `mode_b/ops.nr` now computes both `inner_nullifier` and `siloed_nullifier` in-circuit from `nsk_app` (derived from the user's master nullifier secret key `nsk`). Address verification also proves `nsk` matches the note owner by deriving `npk_m` via EC scalar mul and recomputing the owner address.

## ~~3. Single Note Migration~~ (Done)

`migrate_notes_mode_b` now accepts `[FullNoteProofData<Note>; N]` and loops over all N notes in a single proof. The ExampleApp contract still hardcodes `N = 1`, but the library circuit supports arbitrary batch sizes.

## ~~4. Public State Migration~~ (Done)

Public state migration is fully implemented for Mode B with four composable functions in `mode_b/ops.nr`:

- **`migrate_public_state_mode_b`** — Migrate a standalone public storage value (e.g. `PublicImmutable`, `PublicMutable`). Verifies data existed in the public data tree at snapshot height H via `PublicStateProofData`.
- **`migrate_public_map_state_mode_b`** — Migrate a value from a `Map<K, PublicMutable<T>>`. Derives the storage slot from `base_storage_slot` and `map_keys` via `poseidon2_hash`, then delegates to `migrate_public_state_mode_b`.
- **`migrate_public_map_owned_state_mode_b`** — Migrate an owned map entry. Adds Schnorr signature verification (domain `CLAIM_DOMAIN_B_PUBLIC`) and `MigrationKeyNote` inclusion proof to authenticate the old owner.
- **`derive_map_storage_slot`** — Shared helper that derives nested map slots by iterating `poseidon2_hash([slot, key])` for each key.

## 5. Snapshot Height Governance (MigrationArchiveRegistry)

**Current:** `set_snapshot_height` uses `initialize()` (write-once — can only be called once, subsequent calls revert). However, there is no access control on who can call it. The function does verify the snapshot block header against a stored archive root via Merkle proof, so the caller cannot set an arbitrary height — it must correspond to a real block within a bridged archive.

**Production:** Should be restricted to governance or a trusted admin role. The snapshot height is a critical security parameter — setting it too early could exclude valid key registrations, and it should only be set in response to an actual emergency.

## 6. Supply Cap

**Current:** No supply cap enforced. The new rollup's ExampleMigrationApp mints freely.

**Production:** Should enforce `mintable_supply` cap set at activation, ideally matching the total supply of the old rollup's token at snapshot height H.

## 7. Make registered_keys Immutable in MigrationKeyRegistry

**Current:** `registered_keys` storage can be updated. A user who re-registers with different keys after snapshot height H could invalidate their own migration or cause inconsistencies.

**Production:** Make `registered_keys` entries immutable once set — a key registration should be a one-time operation that cannot be overwritten. No need for keynote nullifier non-inclusion proof.

## ~~8. Decompose migration_lib into Separate Validation Functions~~ (Done)

The Mode B library is now well-decomposed:

- **Private note migration** (`migrate_notes_mode_b`) delegates per-note work to `migrate_note()` which handles inclusion proof, non-nullification proof, and nullifier emission independently.
- **Public state migration** is composed from `migrate_public_state_mode_b` → `migrate_public_map_state_mode_b` → `migrate_public_map_owned_state_mode_b`, each adding one concern (slot derivation, ownership authentication).
- **Proof data types** are separate modules: `KeyNoteProofData`, `NonNullificationProofData`, `PublicStateProofData`, `NoteProofData`.
