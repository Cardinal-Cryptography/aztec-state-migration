# TODO / Improvements

## Features

- **Mask NHK**: Currently the TS SDK passes `Fq.ZERO` as the NHK mask (`migration-base-wallet.ts:getMaskedNhk`). The plan is to compute the mask from the new account's app-siloed nullifier hiding key (`newAccount.getNhkApp(newAppAddress)`) so it can be unmasked in the circuit.

- **Constants codegen**: Noir constants (`constants.nr`) are manually mirrored in `ts/aztec-state-migration/constants.ts`. Add a build step to auto-generate the TS constants from the Noir source.

## Testing

- **More coverage**: Test more scenarios and edge cases — multi-note migrations, duplicate migrations, cross-contract migrations, error paths.

## PoC limitations (documented in `docs/security.md`)

- No supply cap enforcement on mint
- No access control on `set_snapshot_height()` (first caller wins)
- In-memory key storage (unencrypted)
