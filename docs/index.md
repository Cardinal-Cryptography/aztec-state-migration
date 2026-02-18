---
layout: default
title: Home
---

# Aztec Contract Migration

Dual-rollup migration protocol for Aztec token contracts, using cryptographic proofs anchored by L1.

Users lock or burn balances on the old rollup and claim equivalent tokens on the new rollup, verified via archive roots relayed through L1.

## Documentation

- [Problem Definition and Proposed Solution](problem-and-solution.md)
- [Details of Mode A](mode-a-details.md)
- [Details of Mode B](mode-b-details.md)
- [Integration Guide for App Developers](integration-guide.md)
- [Discussion on Non-native Assets](non-native-assets.md)

## Reference

- [Migration Specification](spec/migration-spec.md) — Full design covering Mode A (lock-and-claim) and Mode B (emergency snapshot)
- [Mode B Architecture](mode-b-architecture.md) — Architectural details for the emergency snapshot migration path
