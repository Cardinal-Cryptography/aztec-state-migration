import { Fq, Fr } from "@aztec/foundation/curves/bn254";
import { Note, NoteDao } from "@aztec/stdlib/note";
import { BaseWallet } from "@aztec/wallet-sdk/base-wallet";
import { MIGRATION_NOTE_SLOT } from "../constants.js";
import type { AztecNode } from "@aztec/stdlib/interfaces/client";
import {
  ArchiveProofData,
  MigrationSignature,
  NoteProofData,
} from "../types.js";
import {
  FullProofData,
  NonNullificationProofData,
  KeyNote,
} from "../mode-b/types.js";
import { MigrationNoteProofData } from "../mode-a/types.js";
import { BlockNumber } from "@aztec/foundation/branded-types";
import type { NotesFilter, PXE } from "@aztec/pxe/server";
import { buildArchiveProof, buildNoteProof } from "../proofs.js";
import { buildNullifierProof } from "../mode-b/proofs.js";
import { Point } from "@aztec/foundation/schemas";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { MigrationAccount } from "./migration-account.js";
import {
  signMigrationModeA as signModeA,
  signMigrationModeB as signModeB,
  signPublicStateMigrationModeB as signPubStateModeB,
} from "../keys.js";
import { PublicKeys } from "@aztec/stdlib/keys";
import { PrivateEvent, PrivateEventFilter } from "@aztec/aztec.js/wallet";
import { AbiType, EventSelector } from "@aztec/stdlib/abi";
import { MigrationKeyRegistryContractArtifact } from "../noir-contracts/MigrationKeyRegistry.js";
import { buildMigrationNoteProof } from "../mode-a/proofs.js";
import { Logger } from "@aztec/foundation/log";
import { BlockHash } from "@aztec/stdlib/block";

/**
 * Abstract wallet that adds migration-specific helpers (signing, proof building,
 * key access) on top of the standard Aztec {@link BaseWallet}.
 *
 * Subclasses must implement account creation and key-lookup methods.
 */
export abstract class MigrationBaseWallet extends BaseWallet {
  constructor(pxe: PXE, aztecNode: AztecNode, log?: Logger) {
    super(pxe, aztecNode, log);
  }

  /**
   * Look up the migration public key for the given account.
   * @param account - The account address to look up.
   * @returns The Grumpkin point, or `undefined` if the account is not registered.
   */
  abstract getMigrationPublicKey(account: AztecAddress): Promise<Point>;

  /**
   * Look up the full set of public keys for the given account.
   * @param account - The account address to look up.
   * @returns The public keys, or `undefined` if the account is not registered.
   */
  abstract getPublicKeys(account: AztecAddress): Promise<PublicKeys>;

  /**
   * Retrieve the {@link MigrationAccount} for the given address.
   * @param address - The account address.
   * @returns The migration account instance.
   */
  abstract getMigrationSignerFromAddress(
    address: AztecAddress,
  ): Promise<(msg: Uint8Array) => Promise<MigrationSignature>>;

  getNotes(filter: NotesFilter): Promise<NoteDao[]> {
    return this.pxe.debug.getNotes(filter);
  }

  /**
   * Retrieve the {@link MigrationAccount} for the given address.
   * @param address - The account address.
   * @returns The migration account instance.
   */
  protected abstract getAccountFromAddress(
    address: AztecAddress,
  ): Promise<MigrationAccount>;

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
  ): Promise<MigrationSignature> {
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
    signer: (msg: Uint8Array) => Promise<MigrationSignature>,
    recipient: AztecAddress,
    oldRollupVersion: Fr,
    newRollupVersion: Fr,
    newAppAddress: AztecAddress,
    notes: NoteDao[],
  ): Promise<MigrationSignature> {
    return signModeB(
      signer,
      oldRollupVersion,
      newRollupVersion,
      notes,
      recipient,
      newAppAddress,
    );
  }

  async signPublicStateMigrationModeB(
    signer: (msg: Uint8Array) => Promise<MigrationSignature>,
    recipient: AztecAddress,
    oldRollupVersion: Fr,
    newRollupVersion: Fr,
    newAppAddress: AztecAddress,
    data: any,
    dataAbiType: AbiType,
  ): Promise<MigrationSignature> {
    return signPubStateModeB(
      signer,
      oldRollupVersion,
      newRollupVersion,
      data,
      dataAbiType,
      recipient,
      newAppAddress,
    );
  }

  async getMaskedNhk(
    oldOwner: AztecAddress,
    _newOwner: AztecAddress,
    _newAppAddress: AztecAddress,
  ): Promise<Fq> {
    const oldAccount = await this.getAccountFromAddress(oldOwner);
    // const newAccount = await this.getAccountFromAddress(newOwner);
    // const mask = await newAccount.getNhkApp(newAppAddress);
    const mask = Fq.ZERO; // for now just 0
    return oldAccount.getMaskedNhk(mask);
  }

  /**
   * Build an archive membership proof for the given block.
   *
   * @param blockHash - The proven block hash to build the proof for.
   * @returns An {@link ArchiveProofData} containing the block header and Merkle path.
   */
  async buildArchiveProof(blockHash: BlockHash): Promise<ArchiveProofData> {
    return buildArchiveProof(this.aztecNode, blockHash);
  }

  /**
   * Fetch Mode A migration notes from the PXE, filtering on the well-known
   * {@link MIGRATION_NOTE_SLOT} storage slot.
   *
   * FIXME: Currently, it returns ALL migraton notes created by the user,
   * meaning that also those which have been already migrated are
   * nullfied on the new rollup. We should add some filter options
   * which by default filter out already migrated notes.
   *
   * @param filter - Additional note filters (owner, contract address, etc.).
   * @returns The matching migration notes.
   */
  async getMigrationNotes(filter: NotesFilter): Promise<NoteDao[]> {
    return this.getNotes({
      ...filter,
      storageSlot: new Fr(MIGRATION_NOTE_SLOT),
    });
  }

  /**
   * Fetch Mode A migration data events from the PXE, filtering on the well-known
   * `MigrationDataEvent` selector.
   *
   * @param eventFilter - Additional note filters (owner, contract address, etc.).
   * @param eventDef - The event metadata definition.
   * @returns The matching migration notes.
   */
  async getMigrationDataEvents<T>(
    abiType: AbiType,
    eventFilter: PrivateEventFilter,
  ): Promise<PrivateEvent<T>[]> {
    const eventSelector =
      await EventSelector.fromSignature("MigrationDataEvent");
    const eventDefWithSelector = {
      eventSelector,
      abiType,
      fieldNames: ["migration_data"],
    };
    return this.getPrivateEvents(eventDefWithSelector, eventFilter);
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
   * Build note-hash inclusion proofs for a batch of notes.
   *
   * @param blockNumber - Block number at which to prove inclusion.
   * @param notes - The notes to prove.
   * @param noteMapper - Callback that decodes each raw {@link Note} into the desired shape.
   * @returns An array of {@link NoteProofData}, one per input note.
   */
  async buildMigrationNoteProofs<T>(
    blockNumber: BlockNumber,
    migrationNotes: NoteDao[],
    migrationDataEvents: PrivateEvent<T>[],
  ): Promise<MigrationNoteProofData<T>[]> {
    return Promise.all(
      migrationDataEvents.map((event, i) =>
        buildMigrationNoteProof(
          this.aztecNode,
          blockNumber,
          migrationNotes[i],
          event,
        ),
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
  ): Promise<NonNullificationProofData[]> {
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
  async buildFullNoteProofs<NoteLike>(
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
      note_proof_data: noteProof,
      non_nullification_proof_data: nullifierProofs[i],
    }));
  }

  /**
   * Build a note-hash inclusion proof for a key note.
   *
   * @param keyRegistry - Address of the key registry contract.
   * @param owner - Owner of the key note.
   * @param blockNumber - Block number at which to prove inclusion.
   * @returns Proof data containing the decoded key note, storage slot, randomness, nonce, and sibling path.
   */
  async buildKeyNoteProofData(
    keyRegistry: AztecAddress,
    owner: AztecAddress,
    blockNumber: BlockNumber,
  ): Promise<NoteProofData<KeyNote>> {
    const keyNotes = await this.getNotes({
      owner: owner,
      contractAddress: keyRegistry,
      storageSlot:
        MigrationKeyRegistryContractArtifact.storageLayout.registered_keys.slot,
      scopes: [owner], // Only fetch notes owned by the specified address
    });
    if (keyNotes.length === 0) {
      throw new Error("No key notes found");
    } else if (keyNotes.length > 1) {
      throw new Error("Multiple key notes found, expected exactly one");
    }
    return await buildNoteProof(
      this.aztecNode,
      blockNumber,
      keyNotes[0],
      (note) => KeyNote.fromNote(note),
    );
  }
}
