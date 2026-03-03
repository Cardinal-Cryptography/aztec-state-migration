---
layout: default
title: Security
---

[← Home](index.md)

# Security

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

A front-runner cannot change the recipient without invalidating the signature. See `noir/aztec-state-migration/src/signature.nr`, function `verify_migration_signature`.

### Double-claim

**Threat:** A user migrates the same state twice to mint duplicate tokens on the new rollup.

**Mitigation:** Every successful migration emits a nullifier on the new rollup. Subsequent claims for the same state will fail because the nullifier already exists.

- **Private notes (Mode A):** Nullifier uses the MigrationNote's `randomness`, not user secret keys. Formula: `poseidon2_hash_with_separator([note_hash, randomness], DOM_SEP__NOTE_NULLIFIER)`.
- **Private notes (Mode B):** Nullifier uses the unique note hash and `randomness`. Formula: `poseidon2_hash_with_separator([unique_note_hash, randomness], DOM_SEP__NOTE_NULLIFIER)`.
- **Public state (Mode B):** Nullifier is deterministic from the old app address and storage slot. Formula: `poseidon2_hash_with_separator([old_app.to_field(), base_storage_slot], DOM_SEP__PUBLIC_MIGRATION_NULLIFIER)`. One nullifier is emitted per `PublicStateProofData` (per storage struct), covering all consecutive field slots.

### Replay across migration modes

**Threat:** A proof valid for Mode A is replayed against Mode B (or vice versa), or a private claim proof is replayed against the public state migration path.

**Mitigation:** It is expected that only one migration mode will be used per a particular rollup update, and thus it will not be possible to go through both paths. 

Note also that that each migration mode uses unique domain separators for signed messages, hence message replay cross modes is not possible anyway:

- `DOM_SEP__CLAIM_A` -- Mode A claims (private and public balance)
- `DOM_SEP__CLAIM_B` -- Mode B claims (private notes and owned public state)

Each domain produces a different message hash, so a signature valid under one domain is invalid under another.

### Cross-rollup identity linking

**Threat:** An observer correlates nullifiers emitted on the new rollup with note activity on the old rollup to link user identities across rollups.

**Mitigation:** Private migration nullifiers use the note's `randomness` rather than user secret keys (`nhk`). Since `randomness` is not derivable from any public user identifier, the nullifier reveals no link between old and new rollup identities.

### Migration key compromise

**Threat:** An attacker obtains a user's `msk` (migration secret key) and claims their tokens before the legitimate user does.

**Impact (differs by mode):**

- **Mode A:** Fund loss scoped to the migration. The attacker with `msk` (and knowledge of note preimages) can claim all tokens associated with that key. The `msk` alone is sufficient to sign Mode A claims because the `MigrationNote` is keyed solely by `mpk`. This does not compromise the user's account keys or any non-migration state.
- **Mode B (private notes):** Compromising `msk` alone is **not sufficient**. The Mode B circuit additionally requires the victim's `nhk` (nullifier hiding key) to prove address ownership and compute nullifiers for the non-nullification proof. An attacker who holds only `msk` cannot migrate Mode B private notes.
- **Mode B (public state):** For unowned public state, no signature is required. For owned public state (`migrate_public_map_owned_state_mode_b`), the attacker needs `msk` to sign, plus the `MigrationKeyNote` preimage for the inclusion proof, but does not need `nhk`.

**Mitigation:** The `msk` is derived deterministically from the account's secret key via `sha512ToGrumpkinScalar`. It is never transmitted on-chain -- only the public key `mpk` is stored. Key compromise requires access to the account secret key itself.

### Snapshot height manipulation (Mode B)

**Threat:** An attacker calls `set_snapshot_height` on `MigrationArchiveRegistry` to select an unfavorable block, either excluding valid key registrations or including attacker-favorable state.

**Mitigation:** `set_snapshot_height` uses `PublicImmutable` with `initialize()`, enforcing write-once semantics -- once set, it cannot be changed. The function also verifies the snapshot block header against a stored archive root via Merkle proof, so the caller cannot set an arbitrary height.

**Critical PoC gap:** There is no access control on who can call `set_snapshot_height` first. An attacker who calls it before governance can permanently brick Mode B for users whose key registrations haven't been committed yet. Production deployments must restrict this to governance or a trusted admin role.

## PoC Limitations (NOT FOR PRODUCTION)

The current implementation is a proof-of-concept. The following limitations must be addressed before production use:

- **No supply cap enforcement.** The PoC app contract mints freely on each successful migration. A compromised archive root or bug could allow unlimited minting. Production should enforce a `mintable_supply` cap matching the total locked/snapshot supply.

- **Snapshot height governance has no access control beyond write-once (critical).** The first caller to `set_snapshot_height` wins. The way this should be done in production is that there should be one (not necessarily trusted) party that deploys the contract with correctly set `snapshot_height` -- a value selected by social consensus. The the party posts the details: contract address in a public venue, and community members verify it. Once this is done, there is no trust required anymore because the contract is immutable.

- **In-memory key storage.** The TS client stores migration keys in memory. Production should use secure storage (hardware wallet, encrypted keystore).


## Audit Recommendations

Before production use, the provided library should go through a security audit by an independent team of zk security experts.

The highest-priority audit target is the **double-claim prevention** surface. Every path that computes or emits a nullifier must be verified to produce a unique, deterministic value that covers exactly the migrated state. Key functions:

- `MigrationNote::compute_nullifier` (`mode_a/migration_note.nr`) -- Mode A nullifier from `note_hash` and `randomness`.
- `migrate_note` in `mode_b/builder.nr` -- Mode B nullifier from `unique_note_hash` and `randomness`, plus the `push_nullifier` call.
- `PublicStateProofData::migrate_public_state` (`mode_b/public_state_proof_data.nr`) -- public state nullifier from `old_app` and `base_storage_slot`. Verify that one nullifier per struct covers all consecutive slots and that no subset can be migrated independently.

The second priority is **inclusion proof correctness** -- confirming that proofs cannot be forged or reused across contexts:

- `NoteProofData::verify_note_inclusion` (`note_proof_data.nr`) -- note siloing with `old_app` address, uniqueness with nonce, and Merkle path verification.
- `KeyNoteProofData::verify_key_note_inclusion` (`mode_b/key_note_proof_data.nr`) -- siloing with `old_key_registry` address (read from the archive registry, not supplied by the caller).
- `NonNullificationProofData` (`mode_b/non_nullification_proof_data.nr`) -- low-leaf bounds check and Merkle proof against the nullifier tree root.
- `PublicStateSlotProofData::verify_slot` (`mode_b/public_state_proof_data.nr`) -- public data tree leaf hash and Merkle path.

The third priority is **signature and authentication**:

- `verify_migration_signature` (`signature.nr`) -- domain separator binding, message construction, and Schnorr verification. Confirm that domain separators (`DOM_SEP__CLAIM_A`, `DOM_SEP__CLAIM_B`) produce non-overlapping message spaces.
- Mode B address verification (`mode_b/builder.nr`) -- the `nhk` to `npk_m` derivation and `AztecAddress::compute` check that links note ownership to key ownership.

Finally, **block hash verification** on the registry:

- `verify_migration_mode_a` and `verify_migration_mode_b` (`migration-archive-registry/src/main.nr`) -- confirm that block hashes are checked against stored values and that `set_snapshot_height` enforces write-once semantics.
- `register_block` and `set_snapshot_height` -- verify archive Merkle proof validation and that the stored roots originate from the L1 bridge (`consume_l1_to_l2_message`).

## See Also

- [General Specification](spec/migration-spec.md) -- Nullifier formulas and API tables
- [Mode A Specification](spec/mode-a-spec.md) -- Cooperative lock-and-claim migration flow
- [Mode B Specification](spec/mode-b-spec.md) -- Emergency snapshot migration flow
- [Architecture](architecture.md) -- System overview, component catalog, L1-L2 bridge flow
