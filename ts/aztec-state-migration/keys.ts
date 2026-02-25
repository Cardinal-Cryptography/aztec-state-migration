import { Fr, GrumpkinScalar } from "@aztec/aztec.js/fields";
import { sha512ToGrumpkinScalar } from "@aztec/foundation/crypto/sha512";
import {
  DOM_SEP__CLAIM_A,
  DOM_SEP__CLAIM_B,
  DOM_SEP__MSK_M_GEN,
} from "./constants.js";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { NoteDao } from "@aztec/stdlib/note";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { MigrationSignature } from "./types.js";
import {
  type AbiType,
  encodeArguments,
  type FunctionAbi,
} from "@aztec/stdlib/abi";

/**
 * Derive the master migration secret key from an account's secret key.
 * Uses `sha512ToGrumpkinScalar` with {@link DOM_SEP__MSK_M_GEN} as a domain separator.
 *
 * @param secretKey - The account's master secret key.
 * @returns A Grumpkin scalar used as the migration signing / encryption key.
 */
export function deriveMasterMigrationSecretKey(secretKey: Fr): GrumpkinScalar {
  return sha512ToGrumpkinScalar([secretKey, DOM_SEP__MSK_M_GEN]);
}

/**
 * Produce a Schnorr signature over a Mode A (cooperative lock-and-migrate) claim message.
 *
 * The signed payload is `poseidon2_hash([DOM_SEP__CLAIM_A, oldVersion, newVersion, notesHash, recipient, newApp])`.
 *
 * @param signer - Signing callback (typically {@link BaseMigrationAccount.migrationKeySigner}).
 * @param oldRollupVersion - Version field from the old rollup's block header.
 * @param newRollupVersion - Target rollup version the tokens are migrating to.
 * @param migrationNotes - The locked migration notes being claimed.
 * @param recipient - Address that will call the migration tx on the new rollup (`msg_sender()`).
 * @param newAppAddress - Address of the app contract on the new rollup.
 * @returns The Schnorr signature as a {@link MigrationSignature}.
 */
export async function signMigrationModeA(
  signer: (msg: Buffer) => Promise<MigrationSignature>,
  oldRollupVersion: Fr,
  newRollupVersion: Fr,
  migrationNotes: NoteDao[],
  recipient: AztecAddress,
  newAppAddress: AztecAddress,
): Promise<MigrationSignature> {
  const notesHash = await poseidon2Hash(migrationNotes.map((n) => n.noteHash));
  const msg = await poseidon2Hash([
    DOM_SEP__CLAIM_A,
    oldRollupVersion,
    newRollupVersion,
    notesHash,
    recipient,
    newAppAddress,
  ]);
  return signer(msg.toBuffer());
}

/**
 * Produce a Schnorr signature over a Mode B (emergency snapshot) private note claim message.
 *
 * The signed payload is `poseidon2_hash([DOM_SEP__CLAIM_B, oldVersion, newVersion, notesHash, recipient, newApp])`.
 *
 * @param signer - Signing callback (typically {@link BaseMigrationAccount.migrationKeySigner}).
 * @param oldRollupVersion - Version field from the old rollup's block header.
 * @param newRollupVersion - Target rollup version the tokens are migrating to.
 * @param notes - The private notes on the old rollup whose existence is being proven.
 * @param recipient - Address that will call the migration tx on the new rollup (`msg_sender()`).
 * @param newAppAddress - Address of the app contract on the new rollup.
 * @returns The Schnorr signature as a {@link MigrationSignature}.
 */
export async function signMigrationModeB(
  signer: (msg: Buffer) => Promise<MigrationSignature>,
  oldRollupVersion: Fr,
  newRollupVersion: Fr,
  notes: NoteDao[],
  recipient: AztecAddress,
  newAppAddress: AztecAddress,
): Promise<MigrationSignature> {
  const notesHash = await poseidon2Hash(notes.map((n) => n.noteHash));
  const msg = await poseidon2Hash([
    DOM_SEP__CLAIM_B,
    oldRollupVersion,
    newRollupVersion,
    notesHash,
    recipient,
    newAppAddress,
  ]);
  return signer(msg.toBuffer());
}

/**
 * Produce a Schnorr signature over a Mode B (public state) claim message.
 *
 * The data is packed to `Fr[]` via {@link encodeValue} (matching Noir's `Packable::pack()` field ordering),
 * then hashed with `poseidon2_hash` to produce `dataHash`.
 *
 * The signed payload is `poseidon2_hash([DOM_SEP__CLAIM_B, oldVersion, newVersion, dataHash, recipient, newApp])`.
 *
 * @param signer - Signing callback (typically {@link BaseMigrationAccount.migrationKeySigner}).
 * @param oldRollupVersion - Version field from the old rollup's block header.
 * @param newRollupVersion - Target rollup version the tokens are migrating to.
 * @param data - The public state data to sign. Must match the struct shape defined by `abiType`.
 * @param abiType - ABI type describing `data`'s structure, extracted from the contract artifact.
 * @param recipient - Address that will call the migration tx on the new rollup (`msg_sender()`).
 * @param newAppAddress - Address of the app contract on the new rollup.
 * @returns The Schnorr signature as a {@link MigrationSignature}.
 */
export async function signPublicStateMigrationModeB(
  signer: (msg: Buffer) => Promise<MigrationSignature>,
  oldRollupVersion: Fr,
  newRollupVersion: Fr,
  data: any,
  abiType: AbiType,
  recipient: AztecAddress,
  newAppAddress: AztecAddress,
): Promise<MigrationSignature> {
  const packedData = encodeValue(data, abiType);
  const dataHash = await poseidon2Hash([await poseidon2Hash(packedData)]);
  const msg = await poseidon2Hash([
    DOM_SEP__CLAIM_B,
    oldRollupVersion,
    newRollupVersion,
    dataHash,
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
