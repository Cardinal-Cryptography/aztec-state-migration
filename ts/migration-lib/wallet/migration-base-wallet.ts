import { Fq, Fr } from "@aztec/foundation/curves/bn254";
import { Note, NoteDao, NotesFilter } from "@aztec/stdlib/note";
import { BaseWallet } from "@aztec/wallet-sdk/base-wallet";
import { MIGRATION_NOTE_SLOT } from "../constants.js";
import { AztecNode } from "@aztec/aztec.js/node";
import {
  ArchiveProofData,
  FullProofData,
  NoteProofData,
  NullifierProofData,
} from "../types.js";
import { BlockNumber } from "@aztec/foundation/branded-types";
import { PXE } from "@aztec/pxe/server";
import {
  buildArchiveProof,
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

/**
 * Abstract wallet that adds migration-specific helpers (signing, proof building,
 * key access) on top of the standard Aztec {@link BaseWallet}.
 *
 * Subclasses must implement account creation and key-lookup methods.
 */
export abstract class BaseMigrationWallet extends BaseWallet {
  constructor(
    protected readonly pxe: PXE,
    protected readonly aztecNode: AztecNode,
  ) {
    super(pxe, aztecNode);
  }

  /**
   * Look up the migration public key for the given account.
   * @param account - The account address to look up.
   * @returns The Grumpkin point, or `undefined` if the account is not registered.
   */
  abstract getMigrationPublicKey(account: AztecAddress): Point | undefined;

  /**
   * Look up the full set of public keys for the given account.
   * @param account - The account address to look up.
   * @returns The public keys, or `undefined` if the account is not registered.
   */
  abstract getPublicKeys(account: AztecAddress): PublicKeys | undefined;

  /**
   * Retrieve the {@link MigrationAccount} for the given address.
   * @param address - The account address.
   * @returns The migration account instance.
   */
  async getMigrationAccount(address: AztecAddress): Promise<MigrationAccount> {
    return this.getAccountFromAddress(address) as Promise<MigrationAccount>;
  }

  /**
   * Produce a Mode A (cooperative lock-and-migrate) claim signature via the wallet.
   *
   * @param signer - The migration account that holds the signing key.
   * @param recipient - Address on the new rollup that will receive the balance.
   * @param oldRollupVersion - Version of the old rollup.
   * @param newRollupVersion - Version of the new rollup.
   * @param newAppAddress - App contract address on the new rollup.
   * @param migrationNotes - The locked migration notes being claimed.
   * @returns The raw Schnorr signature buffer.
   */
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

  /**
   * Produce a Mode B (emergency snapshot) claim signature via the wallet.
   *
   * @param signer - The migration account that holds the signing key.
   * @param recipient - Address on the new rollup that will receive the balance.
   * @param oldRollupVersion - Version of the old rollup.
   * @param newRollupVersion - Version of the new rollup.
   * @param newAppAddress - App contract address on the new rollup.
   * @param notes - The balance notes whose values are being claimed.
   * @returns The raw Schnorr signature buffer.
   */
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

  /**
   * Compute the masked nullifier secret key for cross-rollup ownership transfer.
   *
   * @param newOwner - The recipient migration account on the new rollup.
   * @param contractAddress - The app contract address (domain separation).
   * @returns The masked `Fq` key.
   */
  async getMaskedNsk(
    newOwner: MigrationAccount,
    contractAddress: AztecAddress,
  ): Promise<Fq> {
    const account = await this.getMigrationAccount(contractAddress);
    return account.getMaskedNsk(newOwner, contractAddress);
  }

  /**
   * Build an archive membership proof for the given block.
   *
   * @param blockNumber - The proven block number to build the proof for.
   * @returns An {@link ArchiveProofData} containing the block header and Merkle path.
   */
  async buildArchiveProof(blockNumber: BlockNumber): Promise<ArchiveProofData> {
    return buildArchiveProof(this.aztecNode, blockNumber);
  }

  /**
   * Fetch Mode A migration notes from the PXE, filtering on the well-known
   * {@link MIGRATION_NOTE_SLOT} storage slot.
   *
   * @param filter - Additional note filters (owner, contract address, etc.).
   * @returns The matching migration notes.
   */
  async getMigrationNotes(filter: NotesFilter): Promise<NoteDao[]> {
    return this.pxe.getNotes({
      ...filter,
      storageSlot: new Fr(MIGRATION_NOTE_SLOT),
    });
  }

  /**
   * Build note-hash inclusion proofs for a batch of notes.
   *
   * @param blockNumber - Block number at which to prove inclusion.
   * @param notes - The notes to prove.
   * @param noteMapper - Callback that decodes each raw {@link Note} into the desired shape.
   * @returns An array of {@link NoteProofData}, one per input note.
   */
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

  /**
   * Build nullifier non-inclusion proofs for a batch of notes.
   *
   * @param blockNumber - Block number at which to prove non-inclusion.
   * @param notes - The notes whose siloed nullifiers are checked.
   * @returns An array of {@link NullifierProofData}, one per input note.
   */
  async buildNullifierProofs(
    blockNumber: BlockNumber,
    notes: NoteDao[],
  ): Promise<NullifierProofData[]> {
    return Promise.all(
      notes.map((n) => buildNullifierProof(this.aztecNode, blockNumber, n)),
    );
  }

  /**
   * Build combined note-hash inclusion **and** nullifier non-inclusion proofs.
   * Merges the results of {@link buildNoteProofs} and {@link buildNullifierProofs}.
   *
   * @param blockNumber - Block number at which to prove.
   * @param notes - The notes to prove.
   * @param noteMapper - Callback that decodes each raw {@link Note}.
   * @returns An array of {@link FullProofData}, one per input note.
   */
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
