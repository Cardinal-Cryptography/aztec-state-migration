---
layout: default
title: Aztec State Migration
---

# Aztec State Migration

> **Important Note.** This implementation demonstrates the migration design in the form of a Proof of Concept implementation, but is not production-ready. See the [security](security.md#poc-limitations-not-for-production) for a discussion of trust assumptions, audit recommendations and other matters to keep in mind before deploying apps to production based on this PoC.

## Problem

Aztec Network version upgrades may deploy entirely new rollup instances, stranding user state on the old rollup with no built-in migration path. Privacy constraints mean state cannot simply be exported — a migration mechanism must prove state validity without revealing user secrets. See the [General Specification](spec/migration-spec.md#problem-statement) for a full problem statement.

This project was developed in response to the Aztec Foundation's [Request for Grant Proposals: Application State Migration](https://forum.aztec.network/t/request-for-grant-proposals-application-state-migration/8298).

## Solution

This project implements two migration modes, both anchored by L1 archive roots that the old rollup's proven state makes available on Ethereum. **Mode A** (cooperative, lock-and-claim) is the routine path: users lock balances on the old rollup and claim equivalents on the new rollup by proving lock-note inclusion against a bridged archive root.

**Mode B** (emergency snapshot) is the fallback: if the old rollup becomes unavailable, users prove their state existed at a specific snapshot height H without requiring any old-rollup transactions. Both modes use a dedicated migration keypair and Schnorr signatures to authorize claims. This prevents front-running and ensures only the rightful owner can migrate.

## Scope

This migration covers **native application state only** -- token balances and contract storage that live entirely on the Aztec L2. L1-bridged assets (tokens held in Ethereum bridge contracts) require coordination with the bridge protocol's L1 portal contracts and are not covered by this migration mechanism. See [Non-Native Assets](non-native-assets.md) for an analysis of constraints, approaches, and open design questions.

## Documentation Map

| Document | Description |
|----------|-------------|
| [General Specification](spec/migration-spec.md) | Formal protocol design covering shared concepts, Mode A, Mode B, proof requirements, and API definitions |
| [Mode A Specification](spec/mode-a-spec.md) | Cooperative lock-and-claim flow, authentication, nullifier derivation, and limitations |
| [Mode B Specification](spec/mode-b-spec.md) | Emergency snapshot migration, proof chains, public state migration, and key registry |
| [Architecture](architecture.md) | System overview, deployment topology, component catalog, and three-tier composition |
| [Integration Guide](integration-guide.md) | TypeScript SDK, wallet classes, proof data types, and developer workflows |
| [Non-Native Assets](non-native-assets.md) | Constraints and approaches for migrating L1-bridged tokens (not implemented) |
| [Security](security.md) | Trust assumptions, threat scenarios, mitigations, and PoC limitations |
| [Operations](operations.md) | Testing setup, dual-rollup environment, compilation, troubleshooting, and version info |

## Where to Start

- **App developer integrating the TS library?** Start with the [Integration Guide](integration-guide.md), then [Operations](operations.md) for local setup.
- **Protocol reviewer or auditor?** Start with the [General Specification](spec/migration-spec.md) and the [Security](security.md).
- **Understanding the system?** See the [Architecture](architecture.md) for the deployment topology and component catalog.
