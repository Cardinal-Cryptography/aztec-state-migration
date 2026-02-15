# Mode B PoC - Known Limitations & Future Work

## ~~1. Schnorr Signature Authentication~~ (Done)

`mode_b/mod.nr` now uses `schnorr::verify_signature(mpk, signature, msg)` with a domain-separated message:
```
msg = poseidon2(CLAIM_DOMAIN_B, old_rollup, current_rollup, notes_hash, recipient, new_app)
sig = schnorr_sign(msk, msg)   // off-chain
schnorr_verify(sig, mpk, msg)  // in-circuit
```
The message binds the claim to a specific recipient and app contract, preventing front-running. `msk` stays entirely off-chain.

## ~~2. Unchecked Siloed Nullifier Witness~~ (Done)

`migrate_note()` in `mode_b/mod.nr` now computes both `inner_nullifier` and `siloed_nullifier` in-circuit from `nsk_app` (derived from the user's master nullifier secret key `nsk`). Address verification also proves `nsk` matches the note owner by deriving `npk_m` via EC scalar mul and recomputing the owner address.

## ~~3. Single Note Migration~~ (Done)

`migrate_notes_mode_b` now accepts `[FullProofData<Note>; N]` and loops over all N notes in a single proof. The ExampleApp contract still hardcodes `N = 1`, but the library circuit supports arbitrary batch sizes.

## 4. Snapshot Height Governance

**Current:** `set_snapshot_height` can be called by anyone (once). No access control.

**Production:** Should be restricted to governance or a trusted admin role. The snapshot height is a critical security parameter - setting it too early could exclude valid key registrations, and it should only be set in response to an actual emergency.

## 5. Supply Cap

**Current:** No supply cap enforced. The new rollup's ExampleMigrationApp mints freely.

**Production:** Should enforce `mintable_supply` cap set at activation, ideally matching the total supply of the old rollup's token at snapshot height H.
