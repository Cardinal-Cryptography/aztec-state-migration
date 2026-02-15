import { Fr, GrumpkinScalar } from "@aztec/aztec.js/fields";
import { sha512ToGrumpkinScalar } from "@aztec/foundation/crypto/sha512";
import { CLAIM_DOMAIN_A, CLAIM_DOMAIN_B, MSK_M_GEN } from "./constants.js";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { NoteDao } from "@aztec/stdlib/note";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";

export function deriveMasterMigrationSecretKey(secretKey: Fr): GrumpkinScalar {
  return sha512ToGrumpkinScalar([secretKey, MSK_M_GEN]);
}

export async function signMigrationModeA(
  signer: (msg: Buffer<ArrayBufferLike>) => Promise<Buffer<ArrayBufferLike>>,
  oldRollupVersion: Fr,
  newRollupVersion: Fr,
  migrationNotes: NoteDao[],
  recipient: AztecAddress,
  newAppAddress: AztecAddress,
): Promise<Buffer<ArrayBufferLike>> {
  const notesHash = await poseidon2Hash(migrationNotes.map(n => n.noteHash));
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

export async function signMigrationModeB(
  signer: (msg: Buffer<ArrayBufferLike>) => Promise<Buffer<ArrayBufferLike>>,
  oldRollupVersion: Fr,
  newRollupVersion: Fr,
  notes: NoteDao[],
  recipient: AztecAddress,
  newAppAddress: AztecAddress,
): Promise<Buffer<ArrayBufferLike>> {
  const notesHash = await poseidon2Hash(notes.map(n => n.noteHash));
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
