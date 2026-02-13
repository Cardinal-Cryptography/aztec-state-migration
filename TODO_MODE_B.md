# Mode B PoC - Known Limitations & Future Work

## 1. Schnorr Signature Authentication

**Current:** Uses simplified `poseidon2(msk) == mpk_hash` check. Anyone who knows `msk` can claim.

**Production:** Should use Schnorr signature over a domain-separated message binding the claim to a specific recipient, token contract, and rollup:

```
msg = poseidon2(CLAIM_DOMAIN, "B", old_rollup_id, dest_rollup_id, leaf_hash, recipient, TokenV2_address)
sig = schnorr_sign(msk, msg)
```

The circuit would verify `sig` under `mpk` (the full Grumpkin point, not just its hash).

## 2. Single Note Migration

**Current:** Migrates one balance note per transaction. Users with multiple notes must call `migrate_mode_b` once per note.

**Production:** Should support batching multiple notes in a single proof to reduce gas costs and user friction.

## 3. Snapshot Height Governance

**Current:** `set_snapshot_height` can be called by anyone (once). No access control.

**Production:** Should be restricted to governance or a trusted admin role. The snapshot height is a critical security parameter - setting it too early could exclude valid key registrations, and it should only be set in response to an actual emergency.

## 4. Supply Cap

**Current:** No supply cap enforced. The new rollup's ExampleMigrationApp mints freely.

**Production:** Should enforce `mintable_supply` cap set at activation, ideally matching the total supply of the old rollup's token at snapshot height H.
