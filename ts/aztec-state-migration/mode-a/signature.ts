import { Fr } from "@aztec/aztec.js/fields";
import { DOM_SEP__CLAIM_A } from "../constants.js";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { NoteDao } from "@aztec/stdlib/note";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { MigrationSignature } from "../types.js";

/**
 * Produce a Schnorr signature over a Mode A (cooperative lock-and-migrate) claim message.
 *
 * The signed payload is `poseidon2_hash([DOM_SEP__CLAIM_A, oldVersion, newVersion, notesHash, recipient, newApp])`.
 *
 * @param signer - Signing callback (typically {@link MigrationAccount.migrationKeySigner}).
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
