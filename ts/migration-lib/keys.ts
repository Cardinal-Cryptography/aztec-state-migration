import { Fr, GrumpkinScalar } from "@aztec/aztec.js/fields";
import { sha512ToGrumpkinScalar } from "@aztec/foundation/crypto/sha512";
import { CLAIM_DOMAIN_A, CLAIM_DOMAIN_B, MSK_M_GEN } from "./constants.js";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { NoteDao } from "@aztec/stdlib/note";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";

/**
 * Derive the master migration secret key from an account's secret key.
 * Uses `sha512ToGrumpkinScalar` with {@link MSK_M_GEN} as a domain separator.
 *
 * @param secretKey - The account's master secret key.
 * @returns A Grumpkin scalar used as the migration signing / encryption key.
 */
export function deriveMasterMigrationSecretKey(secretKey: Fr): GrumpkinScalar {
  return sha512ToGrumpkinScalar([secretKey, MSK_M_GEN]);
}

/**
 * Produce a Schnorr signature over a Mode A (cooperative lock-and-migrate) claim message.
 *
 * The signed payload is `poseidon2_hash([CLAIM_DOMAIN_A, oldVersion, newVersion, notesHash, recipient, newApp])`.
 *
 * @param signer - Signing callback (typically {@link BaseMigrationAccount.migrationKeySigner}).
 * @param oldRollupVersion - Version field from the old rollup's block header.
 * @param newRollupVersion - Target rollup version the tokens are migrating to.
 * @param migrationNotes - The locked migration notes being claimed.
 * @param recipient - Address on the new rollup that will receive the migrated balance.
 * @param newAppAddress - Address of the app contract on the new rollup.
 * @returns The raw Schnorr signature buffer.
 */
export async function signMigrationModeA(
  signer: (msg: Buffer<ArrayBufferLike>) => Promise<Buffer<ArrayBufferLike>>,
  oldRollupVersion: Fr,
  newRollupVersion: Fr,
  migrationNotes: NoteDao[],
  recipient: AztecAddress,
  newAppAddress: AztecAddress,
): Promise<Buffer<ArrayBufferLike>> {
  const notesHash = await poseidon2Hash(migrationNotes.map((n) => n.noteHash));
  const msg = await poseidon2Hash([
    CLAIM_DOMAIN_A,
    oldRollupVersion,
    newRollupVersion,
    notesHash,
    recipient,
    newAppAddress,
  ]);
  return signer(msg.toBuffer());
}

/**
 * Produce a Schnorr signature over a Mode B (emergency snapshot) claim message.
 *
 * The signed payload is `poseidon2_hash([CLAIM_DOMAIN_B, oldVersion, newVersion, notesHash, recipient, newApp])`.
 *
 * @param signer - Signing callback (typically {@link BaseMigrationAccount.migrationKeySigner}).
 * @param oldRollupVersion - Version field from the old rollup's block header.
 * @param newRollupVersion - Target rollup version the tokens are migrating to.
 * @param notes - The balance notes on the old rollup whose values are being claimed.
 * @param recipient - Address on the new rollup that will receive the migrated balance.
 * @param newAppAddress - Address of the app contract on the new rollup.
 * @returns The raw Schnorr signature buffer.
 */
export async function signMigrationModeB(
  signer: (msg: Buffer<ArrayBufferLike>) => Promise<Buffer<ArrayBufferLike>>,
  oldRollupVersion: Fr,
  newRollupVersion: Fr,
  notes: NoteDao[],
  recipient: AztecAddress,
  newAppAddress: AztecAddress,
): Promise<Buffer<ArrayBufferLike>> {
  const notesHash = await poseidon2Hash(notes.map((n) => n.noteHash));
  const msg = await poseidon2Hash([
    CLAIM_DOMAIN_B,
    oldRollupVersion,
    newRollupVersion,
    notesHash,
    recipient,
    newAppAddress,
  ]);
  return signer(msg.toBuffer());
}
