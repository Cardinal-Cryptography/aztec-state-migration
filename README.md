# Aztec State Migration

A dual-rollup migration framework for Aztec Network upgrades, using cryptographic proofs anchored by L1. Implements cooperative (Mode A) and emergency snapshot (Mode B) migration paths for private and public state.

## Documentation

The full project documentation is the main entrypoint for understanding the system:

- **[Project Documentation](docs/index.md)** -- Overview, architecture, protocol specification, and glossary
- **[Integration Guide](docs/integration-guide.md)** -- TypeScript SDK, wallet classes, proof data types, and developer workflows
- **[Operations](docs/operations.md)** -- Detailed compilation commands, test architecture, environment variables, and troubleshooting

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
```

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

**3. Stop the environment:**

```sh
yarn test:stop
```

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
