---
layout: default
title: Operations
---

[← Home](index.md)

# Operations

This document covers compilation, testing, formatting, and troubleshooting for the dual-rollup migration project.

## Prerequisites

- **Node.js** >= 22.0.0
- **Yarn** 1.22.22 (classic)
- **Docker** (for Aztec sandbox nodes)
- **Foundry** (`forge`, `cast`, `anvil`) for Solidity compilation and L1 interaction
- **Aztec CLI** (`aztec`) matching the project version (installed via `aztec-up`)

## Version Information

| Component | Version | Source |
|-----------|---------|--------|
| Noir / Aztec.nr | `v3.0.0-devnet.6-patch.1` | `noir/migration_lib/Nargo.toml` |
| Aztec JS packages | `v3.0.0-devnet.6-patch.1` | `package.json` dependencies |
| Solidity / Aztec L1 contracts | `v3.0.2` | `solidity/foundry.toml` |
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
| `yarn noir:fmt` | Format Noir code (`aztec fmt`) |
| `yarn noir:fmt:check` | Check Noir formatting |
| `yarn sol:fmt` | Format Solidity code (`forge fmt`) |
| `yarn sol:fmt:check` | Check Solidity formatting |
| `yarn ts:fmt` | Format TypeScript code (`prettier --write`) |
| `yarn ts:fmt:check` | Check TypeScript formatting |
| `yarn ts:build` | Compile TypeScript (`tsc`) |

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

This script (`scripts/hash_compatibility.sh`) compiles and runs both the Solidity and Noir hash tests, then compares the outputs to verify Poseidon2 hash compatibility across environments.

## E2E Test Environment

### Dual-Rollup Setup

Start the dual-rollup environment with:

```bash
yarn test:setup
```

This runs `scripts/utils/dual-rollup-setup.sh`, a 15-step (steps 0-14) governance flow that:

| Step | Action |
|------|--------|
| 0 | Clean up old state and Docker containers |
| 1 | Start local network (Anvil + L1 contracts + Node 1) |
| 2 | Extract L1 contract addresses from Node 1 |
| 3 | Deploy Rollup 2 via `forge script` |
| 4 | Deploy governance payload (`RegisterNewRollupVersionPayload`) |
| 5 | Deposit governance tokens |
| 6 | Advance Anvil time for token checkpoint |
| 7 | Create governance proposal |
| 8 | Advance time past voting delay |
| 9 | Vote on proposal |
| 10 | Advance time past voting + execution delay |
| 11 | Execute governance proposal |
| 12 | Verify registration in the registry |
| 13 | Save deployment info to `dual-rollups-deployment.json` |
| 14 | Start Node 2 (Rollup 2) |

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
| `AZTEC_OLD_URL` | `http://localhost:8080` | `scripts/deploy.ts` |
| `AZTEC_NEW_URL` | `http://localhost:8081` | `scripts/deploy.ts` |
| `ETHEREUM_RPC_URL` | `http://localhost:8545` | `scripts/deploy.ts` |
| `AZTEC_NODE_URL` | `http://localhost:8080` | `scripts/migration_key_registry.test.ts` |

## E2E Test Scripts

| Command | Description |
|---------|-------------|
| `yarn test:mode-a` | Mode A (cooperative) migration test |
| `yarn test:mode-b` | Mode B (emergency) private note migration test |
| `yarn test:mode-b:public` | Mode B public state migration test |
| `yarn test:registry` | MigrationArchiveRegistry tests |
| `yarn test:hash` | Poseidon2 hash compatibility between Noir and Solidity |
| `yarn check:full` | Run setup, then mode-a + mode-b + mode-b:public, then stop |
| `yarn test:stop` | Stop sandbox containers and clean up |

`check:full` (`scripts/check-full.sh`) runs `test:setup`, then executes `test:mode-a`, `test:mode-b`, and `test:mode-b:public` sequentially, and stops the environment on exit via a trap. It does **not** include `test:registry` or `test:hash`.

## Solidity Contracts Summary

| Contract | Purpose |
|----------|---------|
| `Migrator.sol` | Permissionless L1 archive root bridge (3 external functions) |
| `Poseidon2Deploy.sol` | Compilation helper for deploying the `Poseidon2Yul_BN254` precompile |
| `RegisterNewRollupVersionPayload.sol` | Re-export of Aztec governance payload for registering new rollup versions |

### `Migrator.sol` Functions

| Function | Params | Returns |
|----------|--------|---------|
| `migrateArchiveRoot` | `uint256 oldVersion, DataStructures.L2Actor calldata l2Migrator` | `bytes32 leaf, uint256 leafIndex` |
| `migrateArchiveRootAtBlock` | `uint256 oldVersion, uint256 blockNumber, DataStructures.L2Actor calldata l2Migrator` | `bytes32 leaf, uint256 leafIndex` |
| `getArchiveInfo` | `uint256 version` | `bytes32 archiveRoot, uint256 provenCheckpointNumber` |

Note: The TS library (`bridge.ts`) only wraps `migrateArchiveRoot`. Integrators needing `migrateArchiveRootAtBlock` must call the Solidity contract directly.

`Migration.t.sol` (`solidity/tests/Migration.t.sol`) tests Poseidon2 hashing only (`test_hash_2`, `test_hash_3`). It does **not** test `Migrator` contract logic -- this is a known test gap.

## Troubleshooting

**Ports already in use.** Kill existing processes on ports 8080, 8081, or 8545 before running `yarn test:setup`. Use `yarn test:stop` to clean up Docker containers from a previous run.

**Sandbox startup timeout.** The setup script waits up to 300 seconds per node. If running on slower hardware, increase the loop limit in `dual-rollup-setup.sh`.

**Anvil time-warp issues.** Node 2 uses a custom `start-node-with-time-sync.mjs` script that synchronizes its date provider with Anvil's warped timestamps. If Node 2 falls behind or fails to produce blocks, check `node2.log` for time synchronization errors.

**Genesis archive root mismatch.** The genesis root depends on which accounts are pre-funded. Both nodes must use `TEST_ACCOUNTS=true` and `SPONSORED_FPC=true`. The setup script computes the correct genesis root by running the Aztec Docker image's world state tool.

**L1-L2 message consumption failures.** Verify that the secret hash matches (`SECRET_HASH_FOR_ZERO`), the leaf index is correct, and the message has been included in an L2 block on the new rollup.

**Docker cleanup.** Run `yarn test:stop` or manually kill containers with `docker ps -q --filter "ancestor=aztecprotocol/aztec" | xargs -r docker kill`.

**Nargo compilation errors.** Noir is version-sensitive. Ensure the Aztec CLI version matches `v3.0.0-devnet.6-patch.1`. Run `aztec --version` to verify.

## Related Documents

- [Index](index.md) -- Project entry point and documentation map
- [Architecture](architecture.md) -- System overview and component relationships
- [Migration Specification](spec/migration-spec.md) -- Protocol specification
- [Mode A](mode-a.md) -- Cooperative lock-and-claim migration flow
- [Mode B](mode-b.md) -- Emergency snapshot migration flow
- [Integration Guide](integration-guide.md) -- TS SDK, proof types, developer workflow
- [Threat Model](threat-model.md) -- Trust assumptions and PoC limitations
