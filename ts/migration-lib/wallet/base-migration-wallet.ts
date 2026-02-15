import { Fq, Fr } from "@aztec/foundation/curves/bn254";
import { Note, NoteDao, NotesFilter } from "@aztec/stdlib/note";
import { BaseWallet } from "@aztec/wallet-sdk/base-wallet";
import { MIGRATION_NOTE_SLOT } from "../constants.js";
import { AztecNode } from "@aztec/aztec.js/node";
import {
  ArchiveProof,
  FullProofData,
  MigrationNoteProofData,
  NoteProofData,
  NullifierProofData,
} from "../types.js";
import { BlockNumber } from "@aztec/foundation/branded-types";
import { PXE } from "@aztec/pxe/server";
import {
  buildArchiveProof,
  buildMigrationNoteProof,
  buildNoteProof,
  buildNullifierProof,
} from "../proofs.js";
import { Point } from "@aztec/foundation/schemas";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { MigrationAccount } from "./migration-account.js";
import {
  signMigrationModeA as signModeA,
  signMigrationModeB as signModeB,
} from "../keys.js";
import { PublicKeys } from "@aztec/stdlib/keys";

export abstract class BaseMigrationWallet extends BaseWallet {
  constructor(
    protected readonly pxe: PXE,
    protected readonly aztecNode: AztecNode,
  ) {
    super(pxe, aztecNode);
  }

  abstract getMigrationPublicKey(account: AztecAddress): Point | undefined;

  abstract getPublicKeys(account: AztecAddress): PublicKeys | undefined;

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

  async getMaskedNsk(
    newOwner: MigrationAccount,
    contractAddress: AztecAddress,
  ): Promise<Fq> {
    const account = await this.getMigrationAccount(contractAddress);
    return account.getMaskedNsk(newOwner, contractAddress);
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

  async buildNoteProofs<NoteLike>(
    blockNumber: BlockNumber,
    notes: NoteDao[],
    noteMapper: (note: Note) => NoteLike,
  ): Promise<NoteProofData<NoteLike>[]> {
    return Promise.all(
      notes.map((n) =>
        buildNoteProof(this.aztecNode, blockNumber, n, noteMapper),
      ),
    );
  }

  async buildNullifierProofs(
    blockNumber: BlockNumber,
    notes: NoteDao[],
  ): Promise<NullifierProofData[]> {
    return Promise.all(
      notes.map((n) => buildNullifierProof(this.aztecNode, blockNumber, n)),
    );
  }

  async buildNoteAndNullifierProofs<NoteLike>(
    blockNumber: BlockNumber,
    notes: NoteDao[],
    noteMapper: (note: Note) => NoteLike,
  ): Promise<FullProofData<NoteLike>[]> {
    const noteProofs = await this.buildNoteProofs(
      blockNumber,
      notes,
      noteMapper,
    );
    const nullifierProofs = await this.buildNullifierProofs(blockNumber, notes);
    return noteProofs.map((noteProof, i) => ({
      ...noteProof,
      ...nullifierProofs[i],
    }));
  }
}
