# aztec-state-migration

## Test

1. 
```sh
# install dependencies
yarn install
yarn sol:deps
# compile contracts
yarn noir:compile
yarn sol:compile
# generate noir contract ts artifacts
yarn noir:codegen
```
2.
```sh
# start local aztec rollups (on anvil)
yarn test:setup
```

3.
```sh
# run Mode A migration test (requires dual-rollup setup)
yarn test:mode-a

# run Mode B emergency snapshot migration test (requires dual-rollup setup)
yarn test:mode-b

# run MigrationKeyRegistry test (single-node, only needs old rollup on :8080)
yarn test:registry
```

4.
```sh
# stop the rollups
yarn test:stop
```
