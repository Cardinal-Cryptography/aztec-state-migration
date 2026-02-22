#!/usr/bin/env bash
set -euo pipefail

yarn test:setup
trap "yarn test:stop || true" EXIT

yarn test:mode-a
yarn test:mode-b
yarn test:mode-b:public
