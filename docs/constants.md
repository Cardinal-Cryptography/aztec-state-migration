---
layout: default
title: Constants Reference
---

[← Home](index.md)

# Constants Reference

All domain separators and security-sensitive constants used in the migration system, in one place. Constants are defined in Noir (`noir/aztec-state-migration/src/constants.nr`) and mirrored in TypeScript (`ts/aztec-state-migration/constants.ts`).

> **Sync requirement.** The TS constants are manually maintained copies. A TODO exists in `constants.ts` to generate them from the Noir source. Until that is implemented, changes to Noir constants must be manually propagated to the TS file.

## Domain Separators and Storage Slots

| Name (Noir) | Name (TS) | Value | Purpose | Placeholder? |
|---|---|---|---|---|
| `MIGRATION_MODE_A_STORAGE_SLOT` | `MIGRATION_NOTE_SLOT` | `0x28ca34...76eda` | Storage slot for Mode A migration notes. Poseidon2 hash of `"migration-mode-a"` as ASCII. | No |
| `CLAIM_DOMAIN_A` | `CLAIM_DOMAIN_A` | = `MIGRATION_MODE_A_STORAGE_SLOT` | Mode A claim signature domain separator | No, but should be distinct (see below) |
| `CLAIM_DOMAIN_B` | `CLAIM_DOMAIN_B` | `0x18ca70...0e40e` | Mode B private note claim signature domain separator. Poseidon2 hash of `"migration-mode-b"` as ASCII. | No |
| `CLAIM_DOMAIN_B_PUBLIC` | `CLAIM_DOMAIN_B_PUBLIC` | `0xdeafbeef` | Mode B public state claim signature domain separator | **YES** |
| `DOM_SEP__PUBLIC_MIGRATION_NULLIFIER` | *(none)* | `0x12345678` | Nullifier domain separator for public state migration | **YES** |

## TS-Only Constants

| Name | Value | Purpose |
|---|---|---|
| `MSK_M_GEN` | `2137` | Domain separator for deriving the master migration secret key via `sha512ToGrumpkinScalar` |
| `NHK_MASK_DOMAIN` | `1670` | Domain separator for masking the nullifier hiding key during cross-rollup migration |
| `MIGRATION_DATA_FIELD_INDEX` | `5` | Zero-based index of `migration_data_hash` in the serialized `MigrationNote` items array |

## Production Requirements

The following must be addressed before production deployment:

- **`CLAIM_DOMAIN_A`** currently reuses `MIGRATION_MODE_A_STORAGE_SLOT`. It should be assigned a distinct value to prevent any ambiguity between the storage slot and the signature domain. *(Source: `constants.nr:5` TODO)*
- **`CLAIM_DOMAIN_B_PUBLIC`** (`0xdeafbeef`) is a placeholder. Must be replaced with a properly derived value (e.g., a Poseidon2 hash of a descriptive ASCII string). *(Source: `constants.nr:12` TODO)*
- **`DOM_SEP__PUBLIC_MIGRATION_NULLIFIER`** (`0x12345678`) is a placeholder. Must be replaced with a properly derived value. *(Source: `constants.nr:15` TODO)*
- **TS-Noir sync.** `constants.ts` must be kept in sync with `constants.nr`. Either implement codegen from the Noir source or document a strict manual update procedure. *(Source: `constants.ts:1` TODO)*

## See Also

- [Migration Specification](spec/migration-spec.md) -- Nullifier formulas and domain separation
- [Threat Model](threat-model.md) -- Placeholder constants listed under PoC limitations
- [Architecture](architecture.md) -- Component catalog including the constants module
