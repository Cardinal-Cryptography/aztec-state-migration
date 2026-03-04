---
layout: default
title: Integration Guide
---

[← Home](index.md)

# Integration Guide

## Overview

The migration system has three tiers:

1. **Noir library (`aztec_state_migration`)** -- Core verification: proof verification, nullifier emission, signature checking. This is a library, not a contract.
2. **App contracts (V1 + V2)** -- V1 (old rollup) calls library lock functions; V2 (new rollup) calls library claim functions and handles app-specific state (minting, balance updates).
3. **TS SDK (`aztec-state-migration`)** -- Client-side proof building, key derivation, transaction construction.

Integrators work at the App and Client SDK tiers.

### Migration Key

Migration uses a dedicated keypair (`msk`/`mpk`) rather than the account's existing signing keys:

1. **Account contract independence.** Claims must not depend on the old rollup's account contract executing correctly.
2. **Cross-rollup proof compatibility.** Standard Aztec keys are not committed in a form that is easily provable across rollups.
3. **Scoped risk.** If the migration key is compromised, only migration claims are at risk.

The `msk` is derived deterministically from the account's secret key:

```typescript
msk = sha512ToGrumpkinScalar([secretKey, DOM_SEP__MSK_M_GEN])
mpk = msk * G   (Grumpkin generator)
```

No additional key management is needed. See [security](security.md#migration-key-compromise) for the full analysis.

## Prerequisites

This guide assumes that the L1 `Migrator` contract and the `MigrationArchiveRegistry` on the new rollup are already deployed. The V2 app contract must be configured with:

- **`old_rollup_app_address`** -- The V1 contract address on the old rollup (set in the V2 constructor).
- **`archive_registry_address`** -- The `MigrationArchiveRegistry` address on the new rollup (set in the V2 constructor).

---

## Mode A -- Cooperative Lock-and-Claim

Mode A requires the old rollup to be live. Users pre-lock their state on the old rollup, then claim it on the new rollup with a proof.

### Contract Integration (Noir)

#### Lock Side (V1 contract on old rollup)

Import `MigrationLock` and `Point` from the library:

```rust
use aztec_state_migration::{mode_a::MigrationLock, Point};
```

Use the `MigrationLock` builder to lock state:

```rust
#[external("private")]
fn lock_for_migration_mode_a(private_amount: u128, public_amount: u128, destination_rollup: Field, mpk: Point) {
    let note_owner = self.msg_sender();

    // 1. Create migration note + emit encrypted event
    MigrationLock::new(self.context, mpk, note_owner, destination_rollup)
        .lock_state(private_amount + public_amount)
        .finish();

    // 2. Subtract from user's private balance
    self.storage.private_balances.at(note_owner).sub(private_amount)
        .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

    // 3. Enqueue public balance decrement (executes after private phase)
    //    If this fails (insufficient balance), the entire tx reverts including the MigrationNote
    AppV1::at(self.context.this_address())
        ._decrement_public_balance(note_owner, public_amount)
        .enqueue(self.context);
}
```

Each `.lock_state(data)` call creates a `MigrationNote` and emits a `MigrationDataEvent` with an auto-incrementing `data_id` (starting at 0). The `data` can be any type implementing `Packable + Serialize`.

**Multiple entrypoints:** If a contract has separate lock functions (e.g. one for private, one for public state), use `new_with_offset` to avoid `data_id` collisions:

```rust
// In lock_private(): data_id starts at 0
MigrationLock::new(self.context, mpk, owner, dest)
    .lock_state(private_balance)
    .finish();

// In lock_public(): data_id starts at 1
MigrationLock::new_with_offset(self.context, mpk, owner, dest, 1)
    .lock_state(public_balance)
    .finish();
```

**Batching:** It is recommended to batch multiple pieces of state into one `.lock_state()` call via a custom struct:

```rust
#[derive(Packable, Serialize)]
struct MigrationData { balance: u128, extra: Field }

MigrationLock::new(self.context, mpk, owner, dest)
    .lock_state(MigrationData { balance, extra })
    .finish();
```

#### Claim Side (V2 contract on new rollup)

Import the Mode A builder and types:

```rust
use aztec_state_migration::{
    MigrationSignature,
    mode_a::{MigrationModeA, MigrationNoteProofData},
    Point,
};
```

Verify the lock proof and mint on the new rollup:

```rust
#[external("private")]
fn migrate_mode_a(
    mpk: Point,
    signature: MigrationSignature,
    note_proof_data: MigrationNoteProofData<u128>,
    block_header: BlockHeader,
) {
    let recipient = self.msg_sender();
    let old_app = self.storage.old_rollup_app_address.read();
    let amount = note_proof_data.data;

    MigrationModeA::new(
        self.context,
        old_app,
        self.storage.archive_registry_address.read(),
        block_header,
        mpk,
    )
        .with_note(note_proof_data)
        .finish(recipient, signature);

    // App-specific: mint tokens to the recipient
    self.storage.private_balances.at(recipient).add(amount)
        .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
}
```

Multiple notes can be chained: `.with_note(proof1).with_note(proof2).finish(recipient, sig)`.

### Client Side (TypeScript SDK)

The full Mode A client flow:

#### 1. Derive migration key

```typescript
import { deriveMasterMigrationSecretKey } from "aztec-state-migration";

const msk = deriveMasterMigrationSecretKey(secretKey);
const mpk = msk.toPublicKey(); // Grumpkin point
```

#### 2. Lock state on old rollup

```typescript
await oldContract.methods
  .lock_for_migration_mode_a(privateAmount, publicAmount, newRollupVersion, mpk)
  .send()
  .wait();
```

#### 3. Bridge archive root

After locking, a proven archive root that covers the lock transaction must be bridged to the new rollup via L1. This makes the old rollup's state provable on the new rollup and is required before any claim can succeed.

#### 4. Retrieve migration notes and data

```typescript
// Single data type per contract
const notesAndData = await wallet.getMigrationNotesAndData<bigint>(
  contractAddress,
  owner,
  abiType,    // AbiType for the locked data (e.g. AbiType for u128)
);

// Multiple data types (when contract uses data_id offsets)
const mixed = await wallet.getMixedMigrationNotesAndData(
  contractAddress,
  owner,
  { 0: privateBalanceAbiType, 1: publicBalanceAbiType },  // Record<dataId, AbiType>
);
```

#### 5. Filter already-migrated notes (optional)

```typescript
const pending = await newWallet.filterOutMigratedNotes(newContractAddress, notesAndData);
```

#### 6. Build proofs

```typescript
import { buildArchiveProof } from "aztec-state-migration";

const noteProof = await wallet.buildMigrationNoteProof(blockNumber, notesAndData[0]);
const archiveProof = await buildArchiveProof(oldNode, blockHash);
```

#### 7. Sign

```typescript
const signer = await wallet.getMigrationSignerFromAddress(owner);
const signature = await wallet.signMigrationModeA(
  signer, recipient, oldRollupVersion, newRollupVersion, newAppAddress, [noteProof],
);
```

#### 8. Submit claim

```typescript
await newContract.methods.migrate_mode_a(
  mpk, signature, noteProof, archiveProof.archive_block_header,
).send().wait();
```

---

## Mode B -- Emergency Snapshot Migration

Mode B does not require the old rollup to be live. It uses a fixed snapshot height and Merkle proofs against the old rollup's state trees.

### Contract Integration (Noir)

Import the Mode B builder and types:

```rust
use aztec_state_migration::{
    MigrationSignature, Scalar,
    mode_b::{FullNoteProofData, KeyNoteProofData, MigrationModeB, PublicStateProofData},
};
```

#### Private Notes

```rust
#[external("private")]
fn migrate_mode_b(
    signature: MigrationSignature,
    full_proof_data: FullNoteProofData<UintNote>,
    block_header: BlockHeader,
    notes_owner: AztecAddress,
    public_keys: PublicKeys,
    partial_address: Field,
    key_note: KeyNoteProofData,
    nhk: Scalar,
) {
    let recipient = self.msg_sender();
    let old_app = self.storage.old_rollup_app_address.read();
    let balances_slot = STORAGE_LAYOUT_V1.fields.private_balances.slot;
    let amount = full_proof_data.note_proof_data.data.value;

    MigrationModeB::new(
        self.context, old_app,
        self.storage.archive_registry_address.read(),
        block_header,
    )
        .with_notes_owner(notes_owner, key_note, public_keys, partial_address, nhk)
        .with_note(full_proof_data, balances_slot)
        .finish(recipient, signature);

    // App-specific: mint tokens
    self.storage.private_balances.at(recipient).add(amount)
        .deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
}
```

**Custom notes** must use the canonical nullifier formula. Use `assert_note_has_canonical_nullifier` in tests to verify:

```rust
use aztec_state_migration::mode_b::assert_note_has_canonical_nullifier;

#[test]
unconstrained fn assert_canonical_nullifier() {
    let note = NFTNote { token_id: 0x12345 };
    assert_note_has_canonical_nullifier(note);
}
```

#### Owned Public State

```rust
#[external("private")]
fn migrate_public_balance_mode_b(
    proof_data: PublicStateProofData<u128, 1>,
    block_header: BlockHeader,
    old_owner: AztecAddress,
    signature: MigrationSignature,
    key_note: KeyNoteProofData,
) {
    let amount = proof_data.data;
    let recipient = self.msg_sender();
    let old_app = self.storage.old_rollup_app_address.read();
    let base_slot = STORAGE_LAYOUT_V1.fields.public_balances.slot;

    MigrationModeB::new(
        self.context, old_app,
        self.storage.archive_registry_address.read(),
        block_header,
    )
        .with_owner(old_owner, key_note)
        .with_public_map_state(proof_data, base_slot, [old_owner])
        .finish(recipient, signature);

    // App-specific: mint to public balance
    Self::at(self.context.this_address())
        ._mint_to_public_external(recipient, amount)
        .enqueue(self.context);
}
```

Use `.with_public_state(proof, slot)` for standalone `PublicMutable<T>`, and `.with_public_map_state(proof, slot, [key1, key2])` for nested `Map` entries.

#### Unowned Public State

For global state with no ownership (e.g. total supply):

```rust
MigrationModeB::new(context, old_app, archive_registry, block_header)
    .without_owner()
    .with_public_state(proof, slot)
    .finish();  // no signature needed
```

#### Mixed (Public + Private)

The builder supports chaining owned public state with private notes:

```rust
MigrationModeB::new(context, old_app, archive_registry, block_header)
    .with_owner(owner, key_note)
    .with_public_state(public_proof, public_slot)
    .with_notes_owner(public_keys, partial_address, nhk)
    .with_note(note_proof, note_slot)
    .finish(recipient, signature);
```

### Client Side (TypeScript SDK)

#### 0. Register migration key (before snapshot, on old rollup)

```typescript
await keyRegistry.methods.register(mpk).send().wait();
```

#### 1. Build proofs

```typescript
import { buildArchiveProof } from "aztec-state-migration";
import { buildPublicDataProof, buildPublicMapDataProof } from "aztec-state-migration/mode-b";

// Private notes: inclusion + non-nullification
const fullProof = await wallet.buildFullNoteProof(blockNumber, noteDao, UintNote.fromNote);

// Key note proof
const keyProof = await wallet.buildKeyNoteProofData(keyRegistryAddress, owner, blockNumber);

// Public state (standalone PublicMutable<T>)
const publicProof = await buildPublicDataProof(node, blockNumber, data, contract, baseSlot, abiType);

// Public state (Map entry)
const mapProof = await buildPublicMapDataProof(node, blockNumber, data, contract, baseSlot, [mapKey], abiType);

// Archive proof
const archiveProof = await buildArchiveProof(node, blockHash);
```

#### 2. Sign

```typescript
// Private notes
const sig = await wallet.signMigrationModeB(
  signer, recipient, oldVersion, newVersion, newApp, [fullProof],
);

// Public state (owned)
const sig = await wallet.signPublicStateMigrationModeB(
  signer, recipient, oldVersion, newVersion, newApp, data, abiType,
);
```

#### 3. Submit claim

```typescript
// Private note claim
await newContract.methods.migrate_mode_b(
  sig, fullProof, archiveProof.archive_block_header,
  owner, publicKeys, partialAddress, keyProof, nhk,
).send().wait();

// Public balance claim
await newContract.methods.migrate_public_balance_mode_b(
  publicProof, archiveProof.archive_block_header,
  owner, sig, keyProof,
).send().wait();
```

---

## See Also

- [General Specification](spec/migration-spec.md) -- Proof data type field details, API tables
- [Mode A Specification](spec/mode-a-spec.md) -- Cooperative lock-and-claim migration flow
- [Mode B Specification](spec/mode-b-spec.md) -- Emergency snapshot migration flow
- [Architecture](architecture.md) -- Deployment topology, component catalog
- [Security](security.md) -- Trust assumptions, threat model
- [README](../README.md) -- Setup, testing, troubleshooting
