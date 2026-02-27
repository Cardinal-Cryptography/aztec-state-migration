# Aztec State Migration

A dual-rollup migration framework for Aztec Network upgrades, using cryptographic proofs anchored by L1. Implements cooperative (Mode A) and emergency snapshot (Mode B) migration paths for private and public state.

## Documentation

The full project documentation is the main entrypoint for understanding the system:

- **[Project Documentation](docs/index.md)** -- Overview, architecture, protocol specification, and glossary
- **[Integration Guide](docs/integration-guide.md)** -- TypeScript SDK, wallet classes, proof data types, and developer workflows

## Version Information

| Component | Version | Source |
|-----------|---------|--------|
| Noir / Aztec.nr | `v4.0.0-devnet.2-patch.0` | `noir/aztec-state-migration/Nargo.toml` |
| Aztec JS packages | `v4.0.0-devnet.2-patch.0` | `package.json` dependencies |
| Solidity / Aztec L1 contracts | `v4.0.0-devnet.2-patch.0` | `solidity/foundry.toml` |
| Poseidon2 EVM | `a3b4205` (git rev) | `solidity/foundry.toml` |
| OpenZeppelin | `5.6.0-rc.1` | `solidity/foundry.toml` |

The Solidity and Noir components follow separate Aztec release tracks. This version split is intentional.

## Dev Containers (Recommended)

The easiest way to get a working development environment is to use the provided dev containers. They come with all dependencies pre-installed (Node.js, Yarn, Foundry, Aztec CLI, Nargo).

Three configurations are available in `.devcontainer/`:

| Container | Use case |
|-----------|----------|
| `development` | Full development environment with VS Code extensions (Noir, Solidity, Claude Code) |
| `testing` | Lightweight environment for running tests |
| `mac-arm` | Development container adapted for Mac ARM / Rosetta |

To use: open the repo in VS Code, then **Dev Containers: Reopen in Container** and select the appropriate configuration.

## Manual Setup

If not using dev containers, install the following:

- **Node.js** >= 24.12.0
- **Yarn** 1.22.22 (classic)
- **Foundry** (`forge`, `cast`, `anvil`)
- **Aztec CLI** v4.0.0-devnet.2-patch.0 -- install via `curl -sL https://install.aztec.network/v4.0.0-devnet.2-patch.0/ | bash`

Then install project dependencies:

```sh
yarn install
yarn sol:deps
```

## Compilation

```sh
yarn noir:compile     # Compile Noir contracts
yarn noir:codegen     # Generate TypeScript bindings
yarn sol:compile      # Compile Solidity contracts
yarn clean            # Remove all compiled artifacts
```

## Formatting

```sh
yarn fmt              # Format all code (Noir, Solidity, TypeScript)
yarn fmt:check        # Check formatting without modifying files (CI use)
yarn ts:build         # Compile TypeScript
```

Per-language formatting commands: `yarn noir:fmt`, `yarn sol:fmt`, `yarn ts:fmt` (and their `:check` variants).

## Running Tests

### Unit tests

```sh
# Noir unit tests
nargo test --show-output

# Solidity tests (Poseidon2 hash compatibility)
yarn sol:compile && cd solidity && forge test

# Cross-environment hash compatibility
yarn test:hash
```

### E2E tests (dual-rollup)

The E2E tests run against two Aztec sandbox instances representing old and new rollups.

**1. Start the dual-rollup environment:**

```sh
yarn test:setup
```

This starts Anvil (L1 on port 8545) and two Aztec nodes (old rollup on port 8080, new rollup on port 8081).

**2. Run tests:**

```sh
yarn test:mode-a          # Mode A cooperative migration
yarn test:mode-b          # Mode B emergency snapshot (private notes)
yarn test:mode-b:public   # Mode B public state migration
yarn test:registry        # MigrationKeyRegistry (single-node, only needs port 8080)
```

Or run the full suite (setup, all migration tests, teardown):

```sh
yarn check:full
```

`check:full` runs `test:setup`, then executes `test:mode-a`, `test:mode-b`, and `test:mode-b:public` sequentially, and stops the environment on exit via a trap. It does **not** include `test:registry` or `test:hash`.

**3. Stop the environment:**

```sh
yarn test:stop
```

### Environment variables

The test scripts read connection URLs from environment variables with defaults:

| Variable | Default | Used by |
|----------|---------|---------|
| `AZTEC_OLD_URL` | `http://localhost:8080` | `e2e-tests/deploy.ts` |
| `AZTEC_NEW_URL` | `http://localhost:8081` | `e2e-tests/deploy.ts` |
| `ETHEREUM_RPC_URL` | `http://localhost:8545` | `e2e-tests/deploy.ts` |
| `AZTEC_NODE_URL` | `http://localhost:8080` | `e2e-tests/migration-key-registry.test.ts` |

### E2E test architecture

The dual-rollup setup (`yarn test:setup` / `e2e-tests/utils/dual-rollup-setup.sh`) orchestrates:

| Step | Action |
|------|--------|
| 0 | Clean up old state and processes |
| 1 | Start Anvil (local L1) |
| 2 | Deploy L1 contracts for both rollups via `e2e-tests/utils/deploy-rollups.ts` |
| 3 | Start both Aztec nodes via `e2e-tests/utils/start-nodes.ts` |

The deployment file is written to `e2e-tests/utils/dual-rollups-deployment.json`.

User accounts are created via `deployAndFundAccount`, which deploys a Schnorr account contract on-chain with fee juice claimed from L1. The `NodeMigrationEmbeddedWallet` wraps account management and provides migration-specific helpers (key derivation, note retrieval, proof building, signature generation).

## Solidity Contracts

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

## Documentation Preview

The docs use Jekyll with the Cayman theme, served via GitHub Pages. To preview locally:

```sh
cd docs
bundle install
bundle exec jekyll serve
```

Open `http://localhost:4000` in your browser. Changes to `.md` files are live-reloaded. Requires Ruby and Bundler.

## Troubleshooting

**Ports already in use.** Kill existing processes on ports 8080, 8081, or 8545 before running `yarn test:setup`. Use `yarn test:stop` to clean up processes from a previous run.

**Node startup timeout.** The setup script waits for nodes to become ready. If running on slower hardware, increase the wait limit in `e2e-tests/utils/dual-rollup-setup.sh`.

**Anvil time-warp issues.** Both nodes use a shared `TestDateProvider` synchronized with Anvil's warped timestamps via a `RunningPromise(syncDateProviderToL1)` loop in `e2e-tests/utils/start-nodes.ts`. If a node falls behind or fails to produce blocks, check `e2e-tests/utils/nodes.log` for time synchronization errors.

**Genesis archive root mismatch.** The genesis root depends on which accounts are pre-funded. The setup computes the correct genesis values via `getGenesisValues` from `@aztec/world-state/testing`, using initial test accounts and sponsored FPC.

**L1-L2 message consumption failures.** Verify that the secret hash matches (`SECRET_HASH_FOR_ZERO`), the leaf index is correct, and the message has been included in an L2 block on the new rollup.

**Process cleanup.** Run `yarn test:stop` (which runs `e2e-tests/utils/dual-rollup-stop.sh`) to kill Anvil and node processes.

**Nargo compilation errors.** Noir is version-sensitive. Ensure the Aztec CLI version matches `v4.0.0-devnet.2-patch.0`. Run `aztec --version` to verify.

## Project Structure

```
noir/                          Noir contracts and migration library
  aztec-state-migration/         Core verification library (proof, signature, nullifier logic)
  contracts/                     MigrationArchiveRegistry, MigrationKeyRegistry
  test-contracts/                Example app contract for E2E tests
solidity/                      Solidity L1 contracts (Migrator.sol)
ts/aztec-state-migration/      TypeScript client SDK (proof building, key derivation, wallet)
e2e-tests/                     End-to-end migration tests
docs/                          Project documentation (Jekyll / GitHub Pages)
```
