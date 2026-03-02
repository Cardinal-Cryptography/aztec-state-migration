#!/usr/bin/env bash
set -euo pipefail

yarn test:setup
trap "yarn test:stop || true" EXIT

# ExampleApp tests (existing)
yarn test:mode-a
yarn test:mode-b
yarn test:mode-b:public

# Token migration tests
yarn test:token:mode-a
yarn test:token:mode-b
yarn test:token:mode-b:public

# NFT migration tests
yarn test:nft:mode-a
yarn test:nft:mode-b
yarn test:nft:mode-b:public
