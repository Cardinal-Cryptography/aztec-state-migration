import { AztecNode } from "@aztec/aztec.js/node";
import { BlockNumber } from "@aztec/foundation/branded-types";
import { Fr } from "@aztec/foundation/curves/bn254";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { computePublicDataTreeLeafSlot } from "@aztec/stdlib/hash";
import {
  NonNullificationProofData,
  PublicDataProof,
  PublicDataSlotProof,
} from "./types.js";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import type { NoteDao } from "@aztec/stdlib/note";
import type { AbiType } from "@aztec/stdlib/abi";

/**
 * Build a {@link NonNullificationProofData} proving that a note has **not** been nullified.
 * Queries the low-nullifier membership witness from the nullifier tree.
 *
 * @param node - Aztec node client to query the nullifier tree.
 * @param blockNumber - Block number at which to prove non-inclusion.
 * @param noteDao - The note DAO whose siloed nullifier is checked.
 * @returns Low-nullifier witness data for the Noir non-inclusion check.
 */
export async function buildNullifierProof(
  node: AztecNode,
  blockNumber: BlockNumber,
  noteDao: NoteDao,
): Promise<NonNullificationProofData> {
  const lowNullifierWitness = await node.getLowNullifierMembershipWitness(
    blockNumber,
    noteDao.siloedNullifier,
  );
  if (!lowNullifierWitness) {
    throw new Error("Could not get low nullifier witness for note");
  }
  return {
    low_nullifier_value: new Fr(lowNullifierWitness.leafPreimage.getKey()),
    low_nullifier_next_value: new Fr(
      lowNullifierWitness.leafPreimage.getNextKey(),
    ),
    low_nullifier_next_index: new Fr(
      lowNullifierWitness.leafPreimage.getNextIndex(),
    ),
    low_nullifier_leaf_index: new Fr(lowNullifierWitness.index),
    low_nullifier_sibling_path: lowNullifierWitness.siblingPath.toFields(),
  };
}

// ============================================================
// Public data proofs
// ============================================================

/**
 * Build a {@link PublicDataSlotProof} for a single storage slot.
 *
 * Computes the siloed slot via `computePublicDataTreeLeafSlot(contract, slot)`,
 * then queries the public data tree witness from the Aztec node.
 *
 * @param aztecNode - Aztec node client to query the public data tree.
 * @param blockNumber - Block number at which to prove inclusion.
 * @param contractAddress - Address of the contract whose storage is being proven.
 * @param storageSlot - The un-siloed storage slot to prove.
 */
export async function buildPublicDataSlotProof(
  aztecNode: AztecNode,
  blockNumber: BlockNumber,
  contractAddress: AztecAddress,
  storageSlot: Fr,
): Promise<PublicDataSlotProof> {
  // Compute the siloed slot (public data tree index)
  const siloedSlot = await computePublicDataTreeLeafSlot(
    contractAddress,
    storageSlot,
  );

  const witness = await aztecNode.getPublicDataWitness(blockNumber, siloedSlot);
  if (!witness) {
    throw new Error(
      `No public data witness for slot ${storageSlot} (siloed: ${siloedSlot})`,
    );
  }

  return {
    next_slot: witness.leafPreimage.nextKey,
    next_index: new Fr(witness.leafPreimage.nextIndex),
    leaf_index: new Fr(witness.index),
    sibling_path: witness.siblingPath.toFields(),
  };
}

/**
 * Build a {@link PublicDataProof} for a standalone public storage variable (e.g. `PublicMutable<T>`).
 *
 * Determines how many consecutive slots the data occupies from `dataAbiType`
 * (via {@link countPackedSlots}, mirroring Noir's `<T as Packable>::N`),
 * then builds a slot proof for each.
 *
 * @param aztecNode - Aztec node client to query the public data tree.
 * @param blockNumber - Block number at which to prove inclusion.
 * @param data - The data value (passed through to the returned proof, not encoded here).
 * @param contractAddress - Address of the contract whose storage is being proven.
 * @param baseSlot - The storage slot of the variable (from the contract's `storageLayout`).
 * @param dataAbiType - ABI type describing the data's structure, extracted from the contract artifact.
 */
export async function buildPublicDataProof<T>(
  aztecNode: AztecNode,
  blockNumber: BlockNumber,
  data: T,
  contractAddress: AztecAddress,
  baseSlot: Fr,
  dataAbiType: AbiType,
): Promise<PublicDataProof<T>> {
  const slotCount = countPackedSlots(dataAbiType);
  const slot_proof_data = [];
  for (let i = 0; i < slotCount; i++) {
    const slot = baseSlot.add(new Fr(i));
    const proof = await buildPublicDataSlotProof(
      aztecNode,
      blockNumber,
      contractAddress,
      slot,
    );
    slot_proof_data.push(proof);
  }
  return {
    data,
    slot_proof_data,
  };
}

/**
 * Build a {@link PublicDataProof} for a value inside a (possibly nested) `Map`.
 *
 * Derives the actual storage slot from `baseSlot` and `mapKeys` using
 * `poseidon2_hash([slot, key])` for each nesting level, then builds
 * a slot proof for each of the data's packed fields.
 *
 * @param aztecNode - Aztec node client to query the public data tree.
 * @param blockNumber - Block number at which to prove inclusion.
 * @param data - The data value (passed through to the returned proof, not encoded here).
 * @param contractAddress - Address of the contract whose storage is being proven.
 * @param baseSlot - The base storage slot of the map (from the contract's `storageLayout`).
 * @param mapKeys - Map key(s) to derive the storage slot. For nested maps, provide keys outermost-first.
 * @param dataAbiType - ABI type describing the data's structure, extracted from the contract artifact.
 */
export async function buildPublicMapDataProof<T>(
  aztecNode: AztecNode,
  blockNumber: BlockNumber,
  data: T,
  contractAddress: AztecAddress,
  baseSlot: Fr,
  mapKeys: {
    toField: () => Fr;
  }[],
  dataAbiType: AbiType,
): Promise<PublicDataProof<T>> {
  const slotCount = countPackedSlots(dataAbiType);
  const slot_in_map = await deriveStorageSlotInMap(baseSlot, mapKeys);
  const slot_proof_data = [];
  for (let i = 0; i < slotCount; i++) {
    const slot = slot_in_map.add(new Fr(i));
    const proof = await buildPublicDataSlotProof(
      aztecNode,
      blockNumber,
      contractAddress,
      slot,
    );
    slot_proof_data.push(proof);
  }
  return {
    data,
    slot_proof_data,
  };
}

/**
 * Count the number of storage slots (packed fields) an ABI type occupies.
 * Mirrors Noir's `<T as Packable>::N`.
 */
function countPackedSlots(abiType: AbiType): number {
  switch (abiType.kind) {
    case "struct":
      return abiType.fields.reduce(
        (acc, f) => acc + countPackedSlots(f.type),
        0,
      );
    case "array":
      return abiType.length * countPackedSlots(abiType.type);
    case "tuple":
      return abiType.fields.reduce((acc, f) => acc + countPackedSlots(f), 0);
    default:
      // field, integer, boolean → 1 slot each
      return 1;
  }
}

async function deriveStorageSlotInMap(
  baseSlot: Fr,
  mapKeys: {
    toField: () => Fr;
  }[],
): Promise<Fr> {
  let derived_slot = await poseidon2Hash([baseSlot, mapKeys[0].toField()]);
  for (let i = 1; i < mapKeys.length; i++) {
    derived_slot = await poseidon2Hash([derived_slot, mapKeys[i].toField()]);
  }
  return derived_slot;
}
