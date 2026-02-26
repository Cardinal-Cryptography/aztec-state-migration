---
layout: default
title: Constants Reference
---

[← Home](index.md)

# Constants Reference

All domain separators and security-sensitive constants used in the migration system, in one place. Constants are defined in Noir (`noir/aztec-state-migration/src/constants.nr`) and mirrored in TypeScript (`ts/aztec-state-migration/constants.ts`).

> **Sync requirement.** The TS constants are manually maintained copies. A TODO exists in `constants.ts` to generate them from the Noir source. Until that is implemented, changes to Noir constants must be manually propagated to the TS file.

## Domain Separators and Storage Slots

| Name (Noir) | Name (TS) | Value | Purpose |
|---|---|---|---|
| `MIGRATION_NOTE_STORAGE_SLOT` | `MIGRATION_NOTE_STORAGE_SLOT` | `0x0294c1...23d0a0` | Storage slot for Mode A migration notes. Poseidon2 hash of `"migration-note-storage-slot"`. |
| `DOM_SEP__CLAIM_A` | `DOM_SEP__CLAIM_A` | `0x1c1a03...bbcc97` | Mode A claim signature domain separator. Poseidon2 hash of `"claim-a"`. |
| `DOM_SEP__CLAIM_B` | `DOM_SEP__CLAIM_B` | `0x03f16d...6ef1b9` | Mode B private note claim signature domain separator. Poseidon2 hash of `"claim-b"`. |
| `DOM_SEP__CLAIM_B_PUBLIC` | `DOM_SEP__CLAIM_B_PUBLIC` | `0x0ebf03...673e8f` | Mode B public state claim signature domain separator. Poseidon2 hash of `"claim-b-public"`. |
| `DOM_SEP__PUBLIC_MIGRATION_NULLIFIER` | `DOM_SEP__PUBLIC_MIGRATION_NULLIFIER` | `0x2c8f77...fdfb40` | Nullifier domain separator for public state migration. Poseidon2 hash of `"public-migration-nullifier"`. |

## TS-Only Constants

| Name | Value | Purpose |
|---|---|---|
| `DOM_SEP__MSK_M_GEN` | `0x2f92f9...25f962` | Domain separator for deriving the master migration secret key via `sha512ToGrumpkinScalar`. Poseidon2 hash of `"migration-secret-key"`. |

## Maintenance Notes

- **TS-Noir sync.** `constants.ts` must be kept in sync with `constants.nr`. Either implement codegen from the Noir source or document a strict manual update procedure. *(Source: `constants.ts:1` TODO)*

## See Also

- [Migration Specification](spec/migration-spec.md) -- Nullifier formulas and domain separation
- [Security](security.md) -- Trust assumptions and PoC limitations
- [Architecture](architecture.md) -- Component catalog including the constants module
