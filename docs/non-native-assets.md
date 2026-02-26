---
layout: default
title: Non-Native Assets
---

[← Home](index.md)

# Considerations for Non-Native (Bridged) Assets

The core migration [specification](spec/migration-spec.md) and reference implementations focus on **Aztec-native assets** -- state that exists entirely within the Aztec L2. This page discusses the additional challenges of migrating **non-native assets** (e.g., USDC, WETH bridged from Ethereum).

For non-native assets, L2 balances are accounting entries representing claims on actual collateral locked in an L1 portal contract. Migrating the L2 state alone is insufficient -- the L1 collateral must also be securely reassigned to prevent undercollateralization and double-spending. This coupling between L1 custody and L2 accounting is the fundamental reason non-native assets are harder to migrate.

**Portal prerequisite.** All approaches below require the L1 portal contract (the contract that locks tokens on L1, for them to be minted on the L2) to be designed with migration in mind (e.g., through upgradeability, pause mechanisms, or pre-programmed migration hooks). If a portal is entirely immutable and unaware of version upgrades, automated L2 migration is impossible -- users must manually withdraw to L1 and re-deposit to the new rollup. 

**Security Tradeoff.** We would like to emphasize the above tradeoff very explicitly: migrating Non-native (bridged) assets is only possible in the presence of an Owner/Admin role of the token Portal on the L1. This uncovers a security tradeoff:
- If the Portal contract is immutable, and has no role with admin rights, then rescuing funds on L2 in case of vulnerabilities or liveness issues might become unsafe or even impossible. The only option is to let the user bridge back to L1.
- If the Portal contract has a role with admin rights, then rescuing funds is possible, but at the same time users must trust the entity behind the admin role.

**Recommendation.** Given the above tradeoff, and the technical high complexity of safely moving Non-native assets via a dedicated migration, we recommend handling Non-native asset migration by letting the users bridge the funds back to L1. Even in the presence of a Portal Ownership role, we believe this is still the best default migration mode that avoids several different possible pitfalls. Other migration modes should be best left for extreme emergencies.

## The Core Challenges

1. **Double spending via L1 exit.** A user who migrates their L2 balance to the new rollup now holds a valid token there. If the old L1 portal is not synchronized, the user could also withdraw to L1 from the old rollup -- the same backing supports two claims.

2. **Liquidity management and solvency.** If the new rollup mints tokens via a migration proof, the new rollup's L1 portal must acquire the corresponding L1 collateral from the old portal. This is not only a liquidity problem (tokens must be available in the right contract) but also a solvency problem (total withdrawals honored across old + new must never exceed the tokens held in L1 custody).

## Mode A: Cooperative Migration

In Mode A, the user explicitly locks (burns) their notes on the old rollup to generate a `MigrationNote`. Because the note is destroyed, the user can no longer initiate an L2-to-L1 withdrawal for those tokens on the old rollup. Double-spending of individual tokens is therefore manageable, provided the following requirement holds:

> **Requirement.** The lock step must genuinely remove the user's ability to produce a valid L2-to-L1 withdrawal message for the locked balance. If the L2 lock does not prevent old-rollup exits, double-spending remains possible.

The remaining challenge is **liquidity**: the L1 collateral still resides in the old portal, and the new portal starts with zero backing. Several architectural patterns can address this.

### Pattern 1: Shared Portal Contract

A single L1 portal contract serves both the old and new rollups. The collateral is pooled.

```
Old Rollup L2            L1 Portal (shared)           New Rollup L2
+---------------+     +-----------------------+     +------------------+
| burn/lock     |     |  ERC20 pool: T total  |     | mint on claim    |
| tokens on L2  |     |                       |     |                  |
+-------+-------+     |  old_allowance = T    |     +--------+---------+
        |              |  new_allowance = 0    |              |
        |              +-----------+-----------+              |
        |                          |                          |
        |     counter update (L2-to-L1 Outbox message)       |
        |              +-----------+-----------+              |
        |              |  old_allowance = T-M  |<-----counter: M migrated
        |              |  new_allowance = M    |              |
        |              +-----------------------+              |
```

- **Turnstile accounting.** The portal must track how much of the pool is logically assigned to each rollup to enforce its turnstile (the mechanism ensuring L2 token supply never exceeds L1 collateral held by the portal). As tokens are migrated, the portal increases the new rollup's withdrawal allowance and decreases the old rollup's.
- **Counter update.** The new rollup periodically sends an L2-to-L1 message containing the cumulative "total amount migrated so far." When consumed on L1, the portal adjusts its internal accounting.
- **Tradeoff.** Simple liquidity management (one pool), but the portal must safely verify withdrawals for two rollup versions and enforce correct crediting for each.

### Pattern 2: Dual Portal Contracts

Two distinct L1 portals exist -- one for the old rollup, one for the new.

- **Liquidity transfer.** When the new rollup's "migrated so far" counter is consumed on L1, the old portal physically transfers the corresponding ERC20 tokens to the new portal.
- **Tradeoff.** Cleaner separation of concerns and the old portal can eventually be deprecated. But two contracts must trust each other (or a mediator must coordinate), and the old portal must reserve enough tokens to honor any in-flight old-rollup withdrawals that have not yet been finalized on L1.

### Counter Security Requirements

Both patterns rely on a "migrated so far" counter. For any counter-based approach, it seems following tradeoffs are unavoidable:

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

```
Old Rollup blocks:  ... | H-2 | H-1 |  H  | H+1 | H+2 | ...
                                       ^
                               snapshot height
                     <-- honor withdrawals --><-- reject -->
                     (tokens burned before H)  (tokens exist at H,
                                                claimable via Mode B)
```

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
- [Mode A Specification](spec/mode-a-spec.md) -- Cooperative lock-and-claim flow
- [Mode B Specification](spec/mode-b-spec.md) -- Emergency snapshot migration flow
- [Security](security.md) -- Trust assumptions and PoC limitations
