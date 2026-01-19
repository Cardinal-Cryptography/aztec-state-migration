# aztec-state-migration

## Test

Note: It test migration from and to the same aztec network. TODO: configure setup with 2 aztec networks deployed on the same L1.

1. 
```sh
# install dependencies
yarn install
yarn sol:deps
# compile contracts
yarn compile-noir-contracts
yarn compile-solidity-contracts
# generate noir contract ts artifacts
yarn codegen-noir-contracts
```
2.
```sh
# start local aztec network
aztec start --local-network
```

3.
```sh
# run the test
yarn test:migration
```
