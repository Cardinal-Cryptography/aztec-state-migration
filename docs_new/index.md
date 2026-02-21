---
layout: default
title: Aztec Dual-Rollup Migration
---

[← Home](index.md)

# Aztec Dual-Rollup Migration

## Problem

Aztec Network version upgrades deploy entirely new rollup instances rather than upgrading contracts in place. This means user state -- private balances, public storage, and application data -- is stranded on the old rollup with no built-in path to the new one. Privacy constraints compound the problem: unlike transparent chains, Aztec cannot simply export account balances because note ownership and nullifier secrets are private. A migration mechanism must prove state validity without revealing user secrets.

## Solution

This project implements two migration modes, both anchored by L1 archive roots that the old rollup's proven state makes available on Ethereum. **Mode A** (cooperative, lock-and-claim) is the routine path: users lock balances on the old rollup and claim equivalents on the new rollup by proving lock-note inclusion against a bridged archive root. **Mode B** (emergency snapshot) is the fallback: if the old rollup becomes uncooperative, users prove their state existed at a specific snapshot height H without requiring any old-rollup transactions. Both modes use a dedicated migration keypair and Schnorr signatures to authorize claims, preventing front-running and ensuring only the rightful owner can migrate.

## Scope

This migration covers **native application state only** -- token balances and contract storage that live entirely on the Aztec L2. L1-bridged assets (tokens held in Ethereum bridge contracts) are out of scope because the bridge custody model requires coordination with the bridge protocol itself, which is independent of the rollup upgrade.

> **Note on NFTs:** An `NftMigrationApp` contract exists in the codebase and implements both Mode A and Mode B for NFTs. However, this documentation focuses on the fungible token `ExampleMigrationApp` pattern. The same migration library functions generalize to NFTs.

## Documentation Map

| Document | Description |
|----------|-------------|
| [Migration Specification](spec/migration-spec.md) | Formal protocol design covering Mode A, Mode B, proof requirements, and API definitions |
| [Architecture](architecture.md) | System overview, deployment topology, component catalog, and three-layer composition |
| [Mode A](mode-a.md) | Cooperative lock-and-claim flow, authentication, nullifier derivation, and limitations |
| [Mode B](mode-b.md) | Emergency snapshot migration, proof chains, public state migration, and key registry |
| [Integration Guide](integration-guide.md) | TypeScript SDK, wallet classes, proof data types, and developer workflows |
| [Threat Model](threat-model.md) | Trust assumptions, threat scenarios, mitigations, and PoC limitations |
| [Operations](operations.md) | Testing setup, dual-rollup environment, compilation, troubleshooting, and version info |

## Quick Links

- [Migration Specification](spec/migration-spec.md) -- full protocol design
- [Architecture](architecture.md) -- system diagram and component overview
- [Operations](operations.md) -- getting started with the development environment
