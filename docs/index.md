---
layout: default
title: Aztec State Migration
---

# Aztec State Migration

> **Proof-of-concept.** This implementation demonstrates the migration design but is not production-ready. See the [threat model](threat-model.md#poc-limitations-not-for-production) for placeholder constants, missing access controls, and other limitations that must be addressed before deployment.

## Problem

Aztec Network version upgrades deploy entirely new rollup instances rather than upgrading contracts in place. This means user state -- private balances, public storage, and application data -- is stranded on the old rollup with no built-in path to the new one. Privacy constraints compound the problem: unlike transparent chains, Aztec cannot simply export account balances because note ownership and nullifier secrets are private. A migration mechanism must prove state validity without revealing user secrets.

This project was developed in response to the Aztec Foundation's [Request for Grant Proposals: Application State Migration](https://forum.aztec.network/t/request-for-grant-proposals-application-state-migration/8298).

## Solution

This project implements two migration modes, both anchored by L1 archive roots that the old rollup's proven state makes available on Ethereum. **Mode A** (cooperative, lock-and-claim) is the routine path: users lock balances on the old rollup and claim equivalents on the new rollup by proving lock-note inclusion against a bridged archive root.

**Mode B** (emergency snapshot) is the fallback: if the old rollup becomes unavailable, users prove their state existed at a specific snapshot height H without requiring any old-rollup transactions. Both modes use a dedicated migration keypair and Schnorr signatures to authorize claims. This prevents front-running and ensures only the rightful owner can migrate.

## Scope

This migration covers **native application state only** -- token balances and contract storage that live entirely on the Aztec L2. L1-bridged assets (tokens held in Ethereum bridge contracts) require coordination with the bridge protocol's L1 portal contracts and are not covered by this migration mechanism. See [Non-Native Assets](non-native-assets.md) for an analysis of constraints, approaches, and open design questions.

> **Note on NFTs:** An NFT migration contract exists in the codebase and implements both Mode A and Mode B for NFTs. However, this documentation focuses on the fungible token migration pattern. The same migration library functions generalize to NFTs.

## Glossary

- **Rollup** -- An L2 chain that settles to L1.
- **Archive root** -- Merkle root of the rollup's block archive tree; the trust anchor bridged to L1.
- **Note hash tree** -- Merkle tree storing commitments to private notes.
- **Nullifier tree** -- Merkle tree tracking spent notes (or claimed migrations); prevents double-claims.
- **Public data tree** -- Merkle tree storing public contract state.
- **MigrationNote** -- A note created during Mode A lock to commit migration data.
- **`mpk` / `msk`** -- Migration public key / migration secret key. A dedicated keypair for authorizing claims.
- **Snapshot height H** -- The block number at which Mode B proofs are anchored.
- **Siloing** -- Hashing a note hash with its contract address to prevent cross-contract collisions.

## Documentation Map

| Document | Description |
|----------|-------------|
| [Migration Specification](spec/migration-spec.md) | Formal protocol design covering Mode A, Mode B, proof requirements, and API definitions |
| [Architecture](architecture.md) | System overview, deployment topology, component catalog, and three-tier composition |
| [Mode A](mode-a.md) | Cooperative lock-and-claim flow, authentication, nullifier derivation, and limitations |
| [Mode B](mode-b.md) | Emergency snapshot migration, proof chains, public state migration, and key registry |
| [Integration Guide](integration-guide.md) | TypeScript SDK, wallet classes, proof data types, and developer workflows |
| [Non-Native Assets](non-native-assets.md) | Constraints and approaches for migrating L1-bridged tokens (not implemented) |
| [Threat Model](threat-model.md) | Trust assumptions, threat scenarios, mitigations, and PoC limitations |
| [Operations](operations.md) | Testing setup, dual-rollup environment, compilation, troubleshooting, and version info |

## Where to Start

- **App developer integrating the TS library?** Start with the [Integration Guide](integration-guide.md), then [Operations](operations.md) for local setup.
- **Protocol reviewer or auditor?** Start with the [Migration Specification](spec/migration-spec.md) and the [Threat Model](threat-model.md).
- **Understanding the system?** See the [Architecture](architecture.md) for the deployment topology and component catalog.
