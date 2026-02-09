# aztec-state-migration

## Test

Note: It test migration from and to the same aztec network. TODO: configure setup with 2 aztec networks deployed on the same L1.

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
# run the test
yarn test:migration
```

4.
```sh
# stop the rollups
yarn test:stop
```
