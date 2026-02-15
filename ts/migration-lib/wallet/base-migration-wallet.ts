import { Fr } from "@aztec/foundation/curves/bn254";
import { NoteDao, NotesFilter } from "@aztec/stdlib/note";
import { BaseWallet } from "@aztec/wallet-sdk/base-wallet";
import {
  CLAIM_DOMAIN_A,
  CLAIM_DOMAIN_B,
  MIGRATION_NOTE_SLOT,
} from "../constants.js";
import { AztecNode } from "@aztec/aztec.js/node";
import {
  ArchiveProof,
  MigrationNoteProofData,
  NoteProofData,
} from "../types.js";
import { BlockNumber } from "@aztec/foundation/branded-types";
import { PXE } from "@aztec/pxe/server";
import {
  buildArchiveProof,
  buildMigrationNoteProof,
  buildNoteProof,
} from "../proofs.js";
import { Point } from "@aztec/foundation/schemas";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { MigrationAccount } from "./migration-account.js";
import {
  signMigrationModeA as signModeA,
  signMigrationModeB as signModeB,
} from "../keys.js";

export abstract class BaseMigrationWallet extends BaseWallet {
  constructor(
    protected readonly pxe: PXE,
    protected readonly aztecNode: AztecNode,
  ) {
    super(pxe, aztecNode);
  }

  abstract getMigrationPublicKey(account: AztecAddress): Point | undefined;

  async getMigrationAccount(address: AztecAddress): Promise<MigrationAccount> {
    return this.getAccountFromAddress(address) as Promise<MigrationAccount>;
  }

  async signMigrationModeA(
    signer: MigrationAccount,
    recipient: AztecAddress,
    oldRollupVersion: Fr,
    newRollupVersion: Fr,
    newAppAddress: AztecAddress,
    migrationNotes: NoteDao[],
  ): Promise<Buffer<ArrayBufferLike>> {
    return signModeA(
      signer.migrationKeySigner,
      oldRollupVersion,
      newRollupVersion,
      migrationNotes,
      recipient,
      newAppAddress,
    );
  }

  async signMigrationModeB(
    signer: MigrationAccount,
    recipient: AztecAddress,
    oldRollupVersion: Fr,
    newRollupVersion: Fr,
    newAppAddress: AztecAddress,
    notes: NoteDao[],
  ): Promise<Buffer<ArrayBufferLike>> {
    return signModeB(
      signer.migrationKeySigner,
      oldRollupVersion,
      newRollupVersion,
      notes,
      recipient,
      newAppAddress,
    );
  }

  async getEncryptedNsk(
    newOwner: AztecAddress,
  ): Promise<Buffer<ArrayBufferLike>> {
    const account = await this.getAccountFromAddress(newOwner);
    throw new Error(
      "Not implemented: encryption of NSK to the migration public key is not implemented yet",
    );
  }

  async buildArchiveProof(blockNumber: BlockNumber): Promise<ArchiveProof> {
    return buildArchiveProof(this.aztecNode, blockNumber);
  }

  async getMigrationNotes(filter: NotesFilter): Promise<NoteDao[]> {
    return this.pxe.getNotes({
      ...filter,
      storageSlot: new Fr(MIGRATION_NOTE_SLOT),
    });
  }

  async buildMigrationNoteProofs(
    migrationNotes: NoteDao[],
    blockNumber: BlockNumber,
  ): Promise<MigrationNoteProofData[]> {
    return Promise.all(
      migrationNotes.map((n) =>
        buildMigrationNoteProof(this.aztecNode, n, blockNumber),
      ),
    );
  }

  async buildNoteProofs(
    migrationNotes: NoteDao[],
    blockNumber: BlockNumber,
  ): Promise<NoteProofData[]> {
    return Promise.all(
      migrationNotes.map((n) => buildNoteProof(this.aztecNode, n, blockNumber)),
    );
  }
}
