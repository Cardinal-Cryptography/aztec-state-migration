---
layout: default
title: Non-Native Assets
---

[← Home](index.md)

# Considerations for Non-Native (Bridged) Assets

The core migration [specification](spec/migration-spec.md) and reference implementations focus on **Aztec-native assets** -- state that exists entirely within the Aztec L2. This page discusses the additional challenges of migrating **non-native assets** (e.g., USDC, WETH bridged from Ethereum).

For non-native assets, L2 balances are accounting entries representing claims on actual collateral locked in an L1 portal contract. Migrating the L2 state alone is insufficient -- the L1 collateral must also be securely reassigned to prevent undercollateralization and double-spending. This coupling between L1 custody and L2 accounting is the fundamental reason non-native assets are harder to migrate.

**Portal prerequisite.** All approaches below require the L1 portal contract to be designed with migration in mind (e.g., through upgradeability, pause mechanisms, or pre-programmed migration hooks). If a portal is entirely immutable and unaware of version upgrades, automated L2 migration is impossible -- users must manually withdraw to L1 and re-deposit to the new rollup.

## The Core Challenges

1. **Double spending via L1 exit.** A user who migrates their L2 balance to the new rollup now holds a valid token there. If the old L1 portal is not synchronized, the user could also withdraw to L1 from the old rollup -- the same backing supports two claims.

2. **Liquidity management and solvency.** If the new rollup mints tokens via a migration proof, the new rollup's L1 portal must acquire the corresponding L1 collateral from the old portal. This is not only a liquidity problem (tokens must be available in the right contract) but also a solvency problem (total withdrawals honored across old + new must never exceed the tokens held in L1 custody).

## Mode A: Cooperative Migration

In Mode A, the user explicitly locks (burns) their notes on the old rollup to generate a `MigrationNote`. Because the note is destroyed, the user can no longer initiate an L2-to-L1 withdrawal for those tokens on the old rollup. Double-spending of individual tokens is therefore manageable, provided the following requirement holds:

> **Requirement.** The lock step must genuinely remove the user's ability to produce a valid L2-to-L1 withdrawal message for the locked balance. If the L2 lock does not prevent old-rollup exits, double-spending remains possible.

The remaining challenge is **liquidity**: the L1 collateral still resides in the old portal, and the new portal starts with zero backing. Several architectural patterns can address this.

### Pattern 1: Shared Portal Contract

A single L1 portal contract serves both the old and new rollups. The collateral is pooled.

- **Turnstile accounting.** The portal must track how much of the pool is logically assigned to each rollup to enforce its turnstile (the mechanism ensuring L2 token supply never exceeds L1 collateral held by the portal). As tokens are migrated, the portal increases the new rollup's withdrawal allowance and decreases the old rollup's.
- **Counter update.** The new rollup periodically sends an L2-to-L1 message containing the cumulative "total amount migrated so far." When consumed on L1, the portal adjusts its internal accounting.
- **Tradeoff.** Simple liquidity management (one pool), but the portal must safely verify withdrawals for two rollup versions and enforce correct crediting for each.

### Pattern 2: Dual Portal Contracts

Two distinct L1 portals exist -- one for the old rollup, one for the new.

- **Liquidity transfer.** When the new rollup's "migrated so far" counter is consumed on L1, the old portal physically transfers the corresponding ERC20 tokens to the new portal.
- **Tradeoff.** Cleaner separation of concerns and the old portal can eventually be deprecated. But two contracts must trust each other (or a mediator must coordinate), and the old portal must reserve enough tokens to honor any in-flight old-rollup withdrawals that have not yet been finalized on L1.

### Pattern 3: Old-Side Lock Counter

Instead of tracking "how much has been claimed on the new rollup," base the L1 reassignment on "how much has been locked/burned on the old rollup."

- **Advantage.** This ties the backing transfer to the exact moment the old-side exit capability is destroyed, avoiding a window where the new L2 has issued balances but L1 has not yet reassigned backing.
- **Tradeoff.** Requires the old rollup's portal to observe lock events (via L2-to-L1 messages from the old rollup), which may be infeasible if the old rollup's contracts cannot be modified.

### Pattern 4: L1-Mediated Migration

Treat migration as a routed flow: old L2 &rarr; L1 portal &rarr; new L2. The user initiates a special withdrawal on the old rollup that, instead of paying the user on L1, immediately credits the new rollup via an L1-to-L2 deposit.

- **Advantage.** L1 sees every unit of migrated backing flow through. No counter is needed and no trust in a reported number -- solvency is enforced atomically per migration.
- **Tradeoff.** Adds L1 execution cost (two cross-chain messages per migration). May also leak more information (amounts, timing) depending on how deposits and claims are represented.

### Counter Security Requirements

Patterns 1-3 all rely on a "migrated so far" counter (whether tracked on the new or old side). For any counter-based approach:

- **Monotonic.** The counter must only increase. A decrease would allow the old portal to over-release.
- **Unforgeable.** The counter must only be incrementable as a consequence of a valid migration that corresponds to a real reduction of withdrawable supply on the old rollup.
- **Authenticated.** The L1 portal must only accept counter updates from a specific trusted contract (e.g., verified via L2-to-L1 message proofs). If an arbitrary caller can advance the counter, this becomes a direct bridge-drain vector.

**Counter latency.** Because L2-to-L1 messages require epoch proving before they reach L1, the counter on L1 always lags behind reality on L2. This is a **liveness** concern (new-rollup users may temporarily be unable to withdraw to L1 until the counter catches up) but not a **safety** concern (the L1 counter underestimates migration, so the old portal over-reserves rather than under-reserves).

**Privacy.** Counter updates should be batched rather than emitted per individual migration. Per-migration L1 messages would leak individual migration amounts and timing, undermining the privacy guarantees of the system.

## Mode B: Emergency Snapshot Migration

Mode B is significantly harder for non-native assets. Because Mode B relies on a historical snapshot at height H, the user's notes on the old rollup are *not burned* -- they are merely proven to have existed. If the old L1 portal remains active after the snapshot, a direct double-spend attack is possible.

### The Double-Spend Vector

1. A user holds bridged tokens on old L2 at snapshot height H.
2. After H, the user initiates a standard L2-to-L1 withdrawal on the old rollup (burning L2 tokens and creating a withdrawal message).
3. The old rollup proves the epoch containing this withdrawal, and the message appears in the L1 Outbox.
4. The user claims the withdrawal on L1 (portal releases ERC20 tokens).
5. Separately, the user uses a Mode B snapshot proof to claim the same tokens on the new rollup (they existed at H).
6. The user withdraws from the new rollup to L1.
7. **Result:** the user extracts double the collateral.

### Portal Freeze with Block-Height Cutoff

To prevent this, the old L1 portal must stop honoring withdrawal messages after the snapshot height. However, a blanket freeze would strand users who legitimately burned their tokens for L1 withdrawal before H (those tokens no longer exist at H and cannot be claimed via Mode B).

The correct approach is a **block-height cutoff**:

- **Honor** withdrawal messages originating from old-rollup blocks at or before H. These represent tokens that were already burned on L2 before the snapshot -- they are not in the note hash tree at H and cannot be double-claimed via Mode B.
- **Reject** withdrawal messages originating from old-rollup blocks after H. These tokens existed at H and are eligible for Mode B migration -- honoring both the L1 withdrawal and the Mode B claim would be a double-spend.

After the cutoff is enforced, the remaining L1 liquidity (total portal balance minus tokens reserved for pre-H pending withdrawals) is reassigned to the new rollup's portal -- either by transferring ERC20 tokens to a new portal contract or by updating internal accounting in a shared portal.

### Governance Requirements

The portal freeze and liquidity reassignment are high-stakes governance actions that change who can withdraw real L1 tokens. They must be:

- **Governance-controlled.** Only an authorized role (multisig, governance contract, or DAO vote) should be able to trigger the freeze and reassignment.
- **Coordinated with snapshot height H.** The portal cutoff block must match the snapshot height set on the `MigrationArchiveRegistry`. A mismatch creates either a double-spend window (cutoff > H) or stranded funds (cutoff < H).
- **Atomic or tightly sequenced.** The snapshot height declaration and portal freeze should happen as close together as possible to minimize the window for post-H withdrawals to be processed.

## See Also

- [Migration Specification](spec/migration-spec.md) -- Core protocol design (native assets)
- [Mode A](mode-a.md) -- Cooperative lock-and-claim flow
- [Mode B](mode-b.md) -- Emergency snapshot migration flow
- [Threat Model](threat-model.md) -- Trust assumptions and PoC limitations
