---
layout: default
title: Threat Model
---

[← Home](index.md)

# Threat Model

Trust assumptions, threat scenarios, mitigations, and known PoC limitations for the dual-rollup migration system.

## Trust Assumptions

1. **L1 is the trust anchor.** Archive roots are relayed from the old rollup's L1 contracts via `Migrator.sol`. The system inherits L1's finality and availability guarantees. If L1 is compromised, all migration proofs become untrustworthy.

2. **Old rollup's proven archive roots are assumed valid.** The `Migrator.sol` contract reads the old rollup's `getArchiveInfo()` or `archiveAt()` return values directly. The migration system does not re-verify the old rollup's proof system -- it trusts that the L1 rollup contracts have already validated the state roots.

3. **Migration keys are the sole authorization mechanism.** Migration uses a dedicated keypair (`msk`/`mpk`) separate from account signing keys. Possession of `msk` is sufficient to authorize a claim. There is no fallback authentication (no social recovery, no multisig override). In Mode A, the `mpk` is embedded in the `MigrationNote` created during lock. In Mode B, it is registered in the `MigrationKeyRegistry` on the old rollup before snapshot height H.

## Threat Scenarios and Mitigations

### Front-running

**Threat:** An observer sees a pending migration transaction and submits their own claim first, redirecting funds to themselves.

**Mitigation:** The Schnorr signature binds the claim to a specific `recipient` address and `new_app_address`. The signed message is:

```
msg = poseidon2_hash([CLAIM_DOMAIN, old_rollup, current_rollup, notes_hash, recipient, new_app_address])
```

A front-runner cannot change the recipient without invalidating the signature. See `migration_lib/src/signature.nr`, function `verify_migration_signature`.

### Double-claim

**Threat:** A user migrates the same state twice to mint duplicate tokens on the new rollup.

**Mitigation:** Every successful migration emits a nullifier on the new rollup. Subsequent claims for the same state will fail because the nullifier already exists.

- **Private notes (Mode A):** Nullifier uses the MigrationNote's `randomness`, not user secret keys. Formula: `poseidon2_hash_with_separator([note_hash, randomness], GENERATOR_INDEX__NOTE_NULLIFIER)`.
- **Private notes (Mode B):** Nullifier uses the unique note hash and `randomness`. Formula: `poseidon2_hash_with_separator([unique_note_hash, randomness], GENERATOR_INDEX__NOTE_NULLIFIER)`.
- **Public state (Mode B):** Nullifier is deterministic from the old app address and storage slot. Formula: `poseidon2_hash_with_separator([old_app.to_field(), base_storage_slot], GENERATOR_INDEX__PUBLIC_MIGRATION_NULLIFIER)`. One nullifier is emitted per `PublicStateProofData` (per storage struct), covering all consecutive field slots.

### Replay across migration modes

**Threat:** A proof valid for Mode A is replayed against Mode B (or vice versa), or a private claim proof is replayed against the public state migration path.

**Mitigation:** Domain separation constants are included in every signed message:

- `CLAIM_DOMAIN_A` -- Mode A claims (private and public balance)
- `CLAIM_DOMAIN_B` -- Mode B private note claims
- `CLAIM_DOMAIN_B_PUBLIC` -- Mode B public state owned-entry claims

Each domain produces a different message hash, so a signature valid under one domain is invalid under another.

### Cross-rollup identity linking

**Threat:** An observer correlates nullifiers emitted on the new rollup with note activity on the old rollup to link user identities across rollups.

**Mitigation:** Private migration nullifiers use the note's `randomness` rather than user secret keys (`nsk`). Since `randomness` is not derivable from any public user identifier, the nullifier reveals no link between old and new rollup identities.

### Migration key compromise

**Threat:** An attacker obtains a user's `msk` (migration secret key) and claims their tokens before the legitimate user does.

**Impact:** Fund loss scoped to the migration. The attacker can claim all tokens associated with that `msk`. However, this does not compromise the user's account keys or any non-migration state.

**Mitigation:** The `msk` is derived deterministically from the account's secret key via `sha512ToGrumpkinScalar`. It is never transmitted on-chain -- only the public key `mpk` is stored. Key compromise requires access to the account secret key itself.

### Snapshot height manipulation (Mode B)

**Threat:** An attacker calls `set_snapshot_height` on `MigrationArchiveRegistry` to select an unfavorable block, either excluding valid key registrations or including attacker-favorable state.

**Mitigation:** `set_snapshot_height` uses `PublicImmutable` with `initialize()`, enforcing write-once semantics -- once set, it cannot be changed. The function also verifies the snapshot block header against a stored archive root via Merkle proof, so the caller cannot set an arbitrary height.

**Critical PoC gap:** There is no access control on who can call `set_snapshot_height` first. An attacker who calls it before governance can permanently brick Mode B for users whose key registrations haven't been committed yet. Production deployments must restrict this to governance or a trusted admin role.

## PoC Limitations (NOT FOR PRODUCTION)

The current implementation is a proof-of-concept. The following limitations must be addressed before production use:

- **No supply cap enforcement.** The reference app contract mints freely on each successful migration. A compromised archive root or bug could allow unlimited minting. Production should enforce a `mintable_supply` cap matching the total locked/snapshot supply.

- **`old_rollup_app_address` is a deployment-time configuration.** The migration circuit reads `old_rollup_app_address` from the new app's immutable public storage. This is not an unchecked witness -- it is constrained by the rollup's public state tree. However, if configured incorrectly at deployment, migrations will silently fail (archive root mismatch). Production should verify this address via an on-chain registry.

- **L1 `migrateArchiveRoot` is permissionless.** Anyone can call `Migrator.sol` to bridge archive roots, consuming L1-to-L2 message slots. An attacker could spam calls to fill message trees or increase costs. Consider rate limiting or requiring a bond.

- **Snapshot height governance has no access control beyond write-once (critical).** The first caller to `set_snapshot_height` wins. An incorrect snapshot height permanently bricks Mode B for affected users. Production must restrict this to governance.

- **The reference app contract has no access control on `mint()`/`burn()`.** There is no `#[only_self]` on public struct initialization functions. Production apps must restrict minting to verified migration proofs only.

- **In-memory key storage.** The TS client stores migration keys in memory. Production should use secure storage (hardware wallet, encrypted keystore).

- **Identical storage layout assumed.** Migration proofs assume the old and new rollup contracts use identical storage layouts for the migrated state. If layouts diverge, proofs will fail silently. See `NOTE` comments in the NFT example contract for details.

- **On-curve assertion.** `register()` and `lock_migration_notes()` include an on-curve assertion (`y^2 = x^3 - 17`) for Grumpkin points. Invalid points cause a revert with the error message `"mpk not on Grumpkin curve"` (see `migration_lib/src/mode_a/ops.nr`, line 52).

> **Production requirement:** Placeholder domain separators (`CLAIM_DOMAIN_A = MIGRATION_MODE_A_STORAGE_SLOT`, `CLAIM_DOMAIN_B_PUBLIC = 0xdeafbeef`, `GENERATOR_INDEX__PUBLIC_MIGRATION_NULLIFIER = 0x12345678`) must be replaced with properly derived values before production. *(Source: `constants.nr:6,13,16`)*

## Spec Open Items

> **Future work:** Evaluate salt-based commitment for new accounts. *(Source: `migration-spec.md:307`)*

> **Future work:** Supply cap per-user batching. *(Source: `migration-spec.md:309`)*

## See Also

- [Migration Specification](spec/migration-spec.md) -- Nullifier formulas and API tables
- [Mode A](mode-a.md) -- Cooperative lock-and-claim migration flow
- [Mode B](mode-b.md) -- Emergency snapshot migration flow
- [Architecture](architecture.md) -- System overview, component catalog, L1-L2 bridge flow
