import { Fq, Fr } from "@aztec/foundation/curves/bn254";
import { Note, NoteDao } from "@aztec/stdlib/note";
import { BaseWallet } from "@aztec/wallet-sdk/base-wallet";
import { MIGRATION_NOTE_STORAGE_SLOT } from "../constants.js";
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
import {
  MigrationNoteAndData,
  MigrationNoteProofData,
} from "../mode-a/types.js";
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
import { AbiType, EventSelector } from "@aztec/stdlib/abi";
import { MigrationKeyRegistryContractArtifact } from "../noir-contracts/MigrationKeyRegistry.js";
import { buildMigrationNoteProof } from "../mode-a/proofs.js";
import { Logger } from "@aztec/foundation/log";
import { BlockHash } from "@aztec/stdlib/block";
import { TxHash } from "@aztec/stdlib/tx";
import { poseidon2HashWithSeparator } from "@aztec/foundation/crypto/sync";
import { DomainSeparator } from "@aztec/constants";
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
   * Fetch Mode A migration notes and migration data from the PXE,
   * filtering on the well-known {@link MIGRATION_NOTE_STORAGE_SLOT} storage slot.
   *
   * @typeParam T - The shape of the migration data (e.g. `bigint` for token amounts).
   * @param contractAddress - The old rollup contract address (used for filtering and event decoding).
   * @param owner - The note owner to filter by.
   * @param abiType - The ABI type of the migration data (used for event decoding).
   * @param scopes - Optional additional scope addresses to filter by (in addition to the owner).
   * @returns An array of note+data pairs, where each note is a migration note and each data is the decoded migration data from the corresponding event.
   */
  async getMigrationNotesAndData<T>(
    contractAddress: AztecAddress,
    owner: AztecAddress,
    abiType: AbiType,
    scopes?: AztecAddress[],
  ): Promise<MigrationNoteAndData<T>[]> {
    // get all migration notes for the user
    const allNotes = await this.getNotes({
      contractAddress,
      owner,
      scopes: scopes ?? [owner],
      storageSlot: MIGRATION_NOTE_STORAGE_SLOT,
    });
    // group events by txHash
    const noteByTxHash: Map<string, NoteDao[]> = new Map();
    allNotes.map((n) => {
      const currentNotes = noteByTxHash.get(n.txHash.toString()) ?? [];
      noteByTxHash.set(n.txHash.toString(), [...currentNotes, n]);
    });
    // prepare event definition for MigrationDataEvent
    const eventSelector =
      await EventSelector.fromSignature("MigrationDataEvent");
    const eventDefWithSelector = {
      eventSelector,
      abiType,
      fieldNames: ["migration_data"],
    };
    let notesAndData: MigrationNoteAndData<T>[] = [];
    // for each txHash, get the corresponding MigrationDataEvent and pair it with the notes
    for (const [txHash, notes] of noteByTxHash) {
      const events = await this.getPrivateEvents<T>(eventDefWithSelector, {
        contractAddress,
        scopes: scopes ?? [owner],
        txHash: TxHash.fromString(txHash),
      });
      if (events.length != notes.length) {
        throw new Error(
          `Mismatched number of events (${events.length}) and notes (${notes.length}) for tx ${txHash}.`,
        );
      }
      for (let i = 0; i < notes.length; i++) {
        notesAndData.push({
          note: notes[i],
          data: events[i].event,
        });
      }
    }
    return notesAndData;
  }

  /**
   * Filter out notes that have already been migrated
   * (i.e. whose nullifier exists on the new rollup).
   *
   * @param contractAddress - The new rollup contract address (used for nullifier siloing).
   * @param notes - The notes to check.
   * @returns Only the notes that have NOT been migrated yet.
   */
  async filterOutMigratedNotes<T extends { note: NoteDao }>(
    contractAddress: AztecAddress,
    notes: T[],
  ): Promise<T[]> {
    const results = await Promise.all(
      notes.map(async (note) => {
        // Inner nullifier: poseidon2([noteHash, randomness], NOTE_NULLIFIER)
        const innerNullifier = poseidon2HashWithSeparator(
          [note.note.noteHash, note.note.randomness],
          DomainSeparator.NOTE_NULLIFIER,
        );
        // Silo with contract address (as the kernel does on-chain)
        const siloedNullifier = poseidon2HashWithSeparator(
          [contractAddress, innerNullifier],
          DomainSeparator.SILOED_NULLIFIER,
        );
        const witness = await this.aztecNode.getNullifierMembershipWitness(
          "latest",
          siloedNullifier,
        );
        return { note, migrated: witness !== undefined };
      }),
    );
    return results.filter(({ migrated }) => !migrated).map(({ note }) => note);
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
    migrationNotesAndData: MigrationNoteAndData<T>[],
  ): Promise<MigrationNoteProofData<T>[]> {
    return Promise.all(
      migrationNotesAndData.map(({ note, data }) =>
        buildMigrationNoteProof(this.aztecNode, blockNumber, note, data),
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
