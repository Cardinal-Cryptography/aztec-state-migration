# Mode B PoC - Known Limitations & Future Work

## 1. Schnorr Signature Authentication

**Current:** Uses simplified `poseidon2(msk) == mpk_hash` check. Anyone who knows `msk` can claim.

**Production:** Should use Schnorr signature over a domain-separated message binding the claim to a specific recipient, token contract, and rollup:

```
msg = poseidon2(CLAIM_DOMAIN, "B", old_rollup_id, dest_rollup_id, leaf_hash, recipient, TokenV2_address)
sig = schnorr_sign(msk, msg)
```

The circuit would verify `sig` under `mpk` (the full Grumpkin point, not just its hash).

## 2. Unchecked Siloed Nullifier Witness

**Current:** The `siloed_nullifier` for both the balance note and the key registration note is accepted as an unchecked witness from PXE (`NoteDao.siloedNullifier`). The circuit does NOT verify that this nullifier was correctly derived from the note's `nsk_app`.

**Attack vector:** An attacker who knows `msk` but NOT the nullifier secret key (`nsk`) could provide a fake nullifier value. Since the fake nullifier truly is not in the nullifier tree, the non-inclusion proof would pass, allowing claims on already-spent notes.

**Production fix options:**
- Require the user to provide `nsk_app` as witness; verify `inner_nullifier = poseidon2([note_hash, nsk_app], GEN_NULLIFIER)` and `siloed_nullifier = poseidon2([contract_address, inner_nullifier], GEN_OUTER_NULLIFIER)` in-circuit
- This requires proving that `nsk_app` corresponds to the note owner's nullifier public key, which may need protocol-level key registry support

## 3. Single Note Migration

**Current:** Migrates one balance note per transaction. Users with multiple notes must call `migrate_mode_b` once per note.

**Production:** Should support batching multiple notes in a single proof to reduce gas costs and user friction.

## 4. Snapshot Height Governance

**Current:** `set_snapshot_height` can be called by anyone (once). No access control.

**Production:** Should be restricted to governance or a trusted admin role. The snapshot height is a critical security parameter - setting it too early could exclude valid key registrations, and it should only be set in response to an actual emergency.

## 5. Supply Cap

**Current:** No supply cap enforced. The new rollup's ExampleMigrationApp mints freely.

**Production:** Should enforce `mintable_supply` cap set at activation, ideally matching the total supply of the old rollup's token at snapshot height H.
