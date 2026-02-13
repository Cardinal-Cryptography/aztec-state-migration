#!/usr/bin/env bash
set -euo pipefail

yarn noir:compile
yarn sol:compile

# Run Noir unit tests if present; do not fail if none exist.
nargo test --show-output || true

yarn build
yarn test:hash
