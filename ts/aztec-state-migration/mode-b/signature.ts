import { Fr } from "@aztec/aztec.js/fields";
import { DOM_SEP__CLAIM_B } from "../constants.js";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { NoteDao } from "@aztec/stdlib/note";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { MigrationSignature } from "../types.js";
import {
  type AbiType,
  encodeArguments,
  type FunctionAbi,
} from "@aztec/stdlib/abi";

/**
 * Produce a Schnorr signature over a Mode B (emergency snapshot) claim message.
 *
 * Supports private notes, public state data, or both in a single signature --
 * matching the Noir builder which feeds packed public data fields and note hashes
 * into the same `Poseidon2Hasher`.
 *
 * Hash input order (matches the Noir builder): packed public data fields first, then note hashes.
 *
 * The signed payload is `poseidon2_hash([DOM_SEP__CLAIM_B, oldVersion, newVersion, finalHash, recipient, newApp])`.
 *
 * @param signer - Signing callback (typically {@link MigrationAccount.migrationKeySigner}).
 * @param oldRollupVersion - Version field from the old rollup's block header.
 * @param newRollupVersion - Target rollup version the tokens are migrating to.
 * @param recipient - Address that will call the migration tx on the new rollup (`msg_sender()`).
 * @param newAppAddress - Address of the app contract on the new rollup.
 * @param options - The data to sign: `notes` (private notes), `publicData` (public state entries), or both.
 * @returns The Schnorr signature as a {@link MigrationSignature}.
 */
export async function signMigrationModeB(
  signer: (msg: Buffer) => Promise<MigrationSignature>,
  oldRollupVersion: Fr,
  newRollupVersion: Fr,
  recipient: AztecAddress,
  newAppAddress: AztecAddress,
  options: {
    publicData?: { data: any; abiType: AbiType }[];
    notes?: NoteDao[];
  },
): Promise<MigrationSignature> {
  const hashInputs: Fr[] = [];

  // Public data fields first (matches Noir builder order)
  if (options.publicData) {
    for (const { data, abiType } of options.publicData) {
      hashInputs.push(...encodeValue(data, abiType));
    }
  }

  // Then note hashes
  if (options.notes) {
    for (const note of options.notes) {
      hashInputs.push(note.noteHash);
    }
  }

  const finalHash = await poseidon2Hash(hashInputs);
  const msg = await poseidon2Hash([
    DOM_SEP__CLAIM_B,
    oldRollupVersion,
    newRollupVersion,
    finalHash,
    recipient,
    newAppAddress,
  ]);
  return signer(msg.toBuffer());
}

/** Encode a value to Fr[] given its ABI type definition. */
function encodeValue(value: any, abiType: AbiType): Fr[] {
  const syntheticAbi = {
    name: "",
    isInitializer: false,
    isOnlySelf: false,
    isStatic: false,
    functionType: "utility",
    parameters: [{ name: "data", type: abiType, visibility: "private" }],
    returnTypes: [],
    errorTypes: {},
  } as unknown as FunctionAbi;
  return encodeArguments(syntheticAbi, [value]);
}
