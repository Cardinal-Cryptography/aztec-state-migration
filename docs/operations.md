---
layout: default
title: Operations
---

[← Home](index.md)

# Operations

## Prerequisites

- **Node.js** >= 24.12.0
- **Yarn** 1.22.22 (classic)
- **Foundry** (`forge`, `cast`, `anvil`) for Solidity compilation and L1 interaction
- **Aztec CLI** (`aztec`) matching the project version (installed via `install.aztec.network/${AZTEC_VERSION}/` with `AZTEC_VERSION=v4.0.0-devnet.2-patch.0`)

## Version Information

| Component | Version | Source |
|-----------|---------|--------|
| Noir / Aztec.nr | `v4.0.0-devnet.2-patch.0` | `noir/aztec-state-migration/Nargo.toml` |
| Aztec JS packages | `v4.0.0-devnet.2-patch.0` | `package.json` dependencies |
| Solidity / Aztec L1 contracts | `v4.0.0-devnet.2-patch.0` | `solidity/foundry.toml` |
| Poseidon2 EVM | `a3b4205` (git rev) | `solidity/foundry.toml` |
| OpenZeppelin | `5.6.0-rc.1` | `solidity/foundry.toml` |

The Solidity and Noir components follow separate Aztec release tracks. This version split is intentional.

## Compilation Commands

| Command | Description |
|---------|-------------|
| `yarn noir:compile` | Compile Noir contracts (`aztec compile`) |
| `yarn noir:codegen` | Generate TypeScript bindings from compiled artifacts |
| `yarn sol:deps` | Install Solidity dependencies via soldeer (run before `sol:compile`) |
| `yarn sol:compile` | Compile Solidity contracts (`forge build`) |
| `yarn clean` | Remove all compiled artifacts (`noir/target`, `solidity/target`, `solidity/cache`) |

## Formatting and Build

| Command | Description |
|---------|-------------|
| `yarn fmt` | Format all code (Noir, Solidity, TypeScript) |
| `yarn fmt:check` | Check formatting without modifying files (CI use) |
| `yarn ts:build` | Compile TypeScript (`tsc`) |

Per-language formatting commands are available for debugging: `yarn noir:fmt`, `yarn sol:fmt`, `yarn ts:fmt` (and their `:check` variants).

## Documentation Preview

The docs use Jekyll with the Cayman theme, served via GitHub Pages. To preview locally:

```bash
cd docs
bundle install
bundle exec jekyll serve
```

Open `http://localhost:4000` in your browser. Changes to `.md` files are live-reloaded.

Requires Ruby and Bundler. If not installed, see [Jekyll installation](https://jekyllrb.com/docs/installation/).

## Unit Tests

Run Noir unit tests with:

```bash
nargo test --show-output
```

Run Solidity tests (Poseidon2 hash compatibility) with:

```bash
yarn sol:compile && cd solidity && forge test
```

Run cross-environment hash compatibility checks with:

```bash
yarn test:hash
```

This script (`e2e-tests/hash-compatibility.sh`) compiles and runs both the Solidity and Noir hash tests, then compares the outputs to verify Poseidon2 hash compatibility across environments.

## E2E Test Environment

### Dual-Rollup Setup

Start the dual-rollup environment with:

```bash
yarn test:setup
```

This runs `e2e-tests/utils/dual-rollup-setup.sh`, which orchestrates the following:

| Step | Action |
|------|--------|
| 0 | Clean up old state and processes |
| 1 | Start Anvil (local L1) |
| 2 | Deploy L1 contracts for both rollups via `e2e-tests/utils/deploy-rollups.ts` (uses `deployAztecL1Contracts` + `deployRollupForUpgrade` with Anvil impersonation via `anvil_impersonateAccount` to register Rollup 2) |
| 3 | Start both Aztec nodes via `e2e-tests/utils/start-nodes.ts` (uses shared `TestDateProvider` for time-sync with Anvil, computes genesis values via `getGenesisValues` from `@aztec/world-state/testing`) |

The deployment file is written to `e2e-tests/utils/dual-rollups-deployment.json`.

### Ports

| Service | Port |
|---------|------|
| Anvil (L1) | `8545` |
| Node 1 (old rollup sandbox) | `8080` |
| Node 2 (new rollup sandbox) | `8081` |

### Environment Variables

The test scripts read connection URLs from environment variables with defaults:

| Variable | Default | Used by |
|----------|---------|---------|
| `AZTEC_OLD_URL` | `http://localhost:8080` | `e2e-tests/deploy.ts` |
| `AZTEC_NEW_URL` | `http://localhost:8081` | `e2e-tests/deploy.ts` |
| `ETHEREUM_RPC_URL` | `http://localhost:8545` | `e2e-tests/deploy.ts` |
| `AZTEC_NODE_URL` | `http://localhost:8080` | `e2e-tests/migration-key-registry.test.ts` |

## E2E Test Scripts

| Command | Description |
|---------|-------------|
| `yarn test:mode-a` | Mode A (cooperative) migration test |
| `yarn test:mode-b` | Mode B (emergency) private note migration test |
| `yarn test:mode-b:public` | Mode B public state migration test |
| `yarn test:registry` | MigrationKeyRegistry tests |
| `yarn test:hash` | Poseidon2 hash compatibility between Noir and Solidity |
| `yarn check:full` | Run setup, then mode-a + mode-b + mode-b:public, then stop |
| `yarn test:stop` | Stop node processes and clean up |

`check:full` (`e2e-tests/check-full.sh`) runs `test:setup`, then executes `test:mode-a`, `test:mode-b`, and `test:mode-b:public` sequentially, and stops the environment on exit via a trap. It does **not** include `test:registry` or `test:hash`.

## E2E Test Architecture

The E2E tests run against two Aztec sandbox instances (ports 8080 and 8081) representing old and new rollups.

### Private note migration test (`e2e-tests/migration-mode-b.test.ts`):

1. Deploys contracts on both rollups and mints tokens on the old rollup
2. Registers a migration key on the old rollup (`MigrationKeyRegistry`)
3. Bridges the archive root via L1 (`bridgeBlock` -- consume L1->L2 message + register block) and sets snapshot height
4. Gathers Merkle proofs: note inclusion, nullifier non-inclusion, key note inclusion
5. Signs the migration via Schnorr signature
6. Calls `migrate_mode_b` on the new rollup
7. Verifies the balance on the new rollup
8. Tests that migrating a nullified note fails (expected failure case)

### Public state migration test (`e2e-tests/migration-public-mode-b.test.ts`):

1. Deploys contracts and sets public storage values (standalone struct, map struct, owned map struct, nested owned map struct)
2. Bridges the archive root and sets snapshot height
3. Builds `PublicStateProofData` from the Aztec node's public data tree witnesses
4. Calls the corresponding `migrate_to_public_*_mode_b` functions on the new rollup
5. Verifies each migrated value on the new rollup

### Account management

User accounts are created via `deployAndFundAccount`, which deploys a Schnorr account contract on-chain with fee juice claimed from L1. The `NodeMigrationEmbeddedWallet` wraps account management and provides migration-specific helpers (key derivation, note retrieval, proof building, signature generation).

## Solidity Contracts Summary

| Contract | Purpose |
|----------|---------|
| `Migrator.sol` | Permissionless L1 archive root bridge (3 external functions) |
| `Poseidon2Deploy.sol` | Compilation helper for deploying the `Poseidon2Yul_BN254` precompile |
| `RegisterNewRollupVersionPayload.sol` | Re-export of Aztec governance payload for registering new rollup versions (used in governance flows; the E2E tests use Anvil impersonation instead) |

### `Migrator.sol` Functions

| Function | Params | Returns |
|----------|--------|---------|
| `migrateArchiveRoot` | `uint256 oldVersion, DataStructures.L2Actor calldata l2Migrator` | `bytes32 leaf, uint256 leafIndex` |
| `migrateArchiveRootAtBlock` | `uint256 oldVersion, uint256 blockNumber, DataStructures.L2Actor calldata l2Migrator` | `bytes32 leaf, uint256 leafIndex` |
| `getArchiveInfo` | `uint256 version` | `bytes32 archiveRoot, uint256 provenCheckpointNumber` |

Note: The TS library (`bridge.ts`) only wraps `migrateArchiveRoot`. Integrators needing `migrateArchiveRootAtBlock` must call the Solidity contract directly.

`Migration.t.sol` (`solidity/tests/Migration.t.sol`) tests Poseidon2 hashing only (`test_hash_2`, `test_hash_3`). It does **not** test `Migrator` contract logic -- this is a known test gap.

## Troubleshooting

**Ports already in use.** Kill existing processes on ports 8080, 8081, or 8545 before running `yarn test:setup`. Use `yarn test:stop` to clean up processes from a previous run.

**Node startup timeout.** The setup script waits for nodes to become ready. If running on slower hardware, increase the wait limit in `e2e-tests/utils/dual-rollup-setup.sh`.

**Anvil time-warp issues.** Both nodes use a shared `TestDateProvider` (from `@aztec/foundation/timer`) synchronized with Anvil's warped timestamps via a `RunningPromise(syncDateProviderToL1)` loop in `e2e-tests/utils/start-nodes.ts`. If a node falls behind or fails to produce blocks, check `e2e-tests/utils/nodes.log` for time synchronization errors.

**Genesis archive root mismatch.** The genesis root depends on which accounts are pre-funded. The setup computes the correct genesis values via `getGenesisValues` from `@aztec/world-state/testing`, using initial test accounts and sponsored FPC.

**L1-L2 message consumption failures.** Verify that the secret hash matches (`SECRET_HASH_FOR_ZERO`), the leaf index is correct, and the message has been included in an L2 block on the new rollup.

**Process cleanup.** Run `yarn test:stop` (which runs `e2e-tests/utils/dual-rollup-stop.sh`) to kill Anvil and node processes.

**Nargo compilation errors.** Noir is version-sensitive. Ensure the Aztec CLI version matches `v4.0.0-devnet.2-patch.0`. Run `aztec --version` to verify.

## See Also

- [Architecture](architecture.md) -- System overview and component relationships
- [Migration Specification](spec/migration-spec.md) -- Protocol specification
- [Integration Guide](integration-guide.md) -- TS SDK, proof types, developer workflow
