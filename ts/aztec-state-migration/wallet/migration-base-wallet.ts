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
import { AbiType, decodeFromAbi, EventSelector } from "@aztec/stdlib/abi";
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
   * @param abiType - A single ABI type applied to all events.
   */
  async getMigrationNotesAndData<T>(
    contractAddress: AztecAddress,
    owner: AztecAddress,
    abiType: AbiType,
    scopes?: AztecAddress[],
  ): Promise<MigrationNoteAndData<T>[]> {
    const { noteByTxHash, eventSelector, eventFilter } =
      await this.getMigrationNotesEventSelector(contractAddress, owner, scopes);
    let notesAndData: MigrationNoteAndData<T>[] = [];
    for (const [txHash, notes] of noteByTxHash) {
      const events = await this.getPrivateEvents<T>(
        {
          eventSelector,
          abiType: abiType,
          fieldNames: ["migration_data"],
        },
        eventFilter(txHash),
      );
      if (events.length !== notes.length) {
        throw new Error(
          `Mismatched number of events (${events.length}) and notes (${notes.length}) for tx ${txHash}.`,
        );
      }
      for (let i = 0; i < notes.length; i++) {
        notesAndData.push({ note: notes[i], data: events[i].event });
      }
    }
    return notesAndData;
  }
  /**
   * Like {@link getMigrationNotesAndData}, but for mixed-type data structures.
   *
   * When a single `lock_state` chain emits events with different data structures,
   * pass an ordered `AbiType[]` where `abiTypes[i]` decodes the i-th event
   * within each tx (matching `lock_state` call order).
   *
   * @param abiTypes - Ordered array of ABI types, one per `lock_state` call.
   */
  async getMixedMigrationNotesAndData(
    contractAddress: AztecAddress,
    owner: AztecAddress,
    abiTypes: AbiType[],
    scopes?: AztecAddress[],
  ): Promise<MigrationNoteAndData<unknown>[]> {
    const { noteByTxHash, eventSelector, eventFilter } =
      await this.getMigrationNotesEventSelector(contractAddress, owner, scopes);

    let notesAndData: MigrationNoteAndData<unknown>[] = [];

    for (const [txHash, notes] of noteByTxHash) {
      if (abiTypes.length !== notes.length) {
        throw new Error(
          `abiTypes array length (${abiTypes.length}) does not match number of notes (${notes.length}) for tx ${txHash}.`,
        );
      }
      const pxeEvents = await this.pxe.getPrivateEvents(
        eventSelector,
        eventFilter(txHash),
      );
      if (pxeEvents.length !== notes.length) {
        throw new Error(
          `Mismatched number of events (${pxeEvents.length}) and notes (${notes.length}) for tx ${txHash}.`,
        );
      }
      for (let i = 0; i < notes.length; i++) {
        const decodedEvent = decodeFromAbi(
          [abiTypes[i]],
          pxeEvents[i].packedEvent,
        ) as unknown;
        notesAndData.push({ note: notes[i], data: decodedEvent });
      }
    }
    return notesAndData;
  }

  private async getMigrationNotesEventSelector(
    contractAddress: AztecAddress,
    owner: AztecAddress,
    scopes?: AztecAddress[],
  ): Promise<{
    noteByTxHash: Map<string, NoteDao[]>;
    eventSelector: EventSelector;
    eventFilter: (txHash: string) => {
      contractAddress: AztecAddress;
      scopes: AztecAddress[];
      txHash: TxHash;
    };
  }> {
    // get all migration notes for the user
    const allNotes = await this.getNotes({
      contractAddress,
      owner,
      scopes: scopes ?? [owner],
      storageSlot: MIGRATION_NOTE_STORAGE_SLOT,
    });
    // group notes by txHash
    const noteByTxHash: Map<string, NoteDao[]> = new Map();
    allNotes.map((n) => {
      const currentNotes = noteByTxHash.get(n.txHash.toString()) ?? [];
      noteByTxHash.set(n.txHash.toString(), [...currentNotes, n]);
    });

    const eventSelector =
      await EventSelector.fromSignature("MigrationDataEvent");
    const eventFilter = (txHash: string) => ({
      contractAddress,
      scopes: scopes ?? [owner],
      txHash: TxHash.fromString(txHash),
    });
    return { noteByTxHash, eventSelector, eventFilter };
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
   * @param blockReference - Block number or hash at which to prove inclusion.
   * @param note - The note to prove.
   * @param noteMapper - Callback that decodes the raw {@link Note} into the desired shape.
   * @returns Proof data containing the decoded note, storage slot, randomness, nonce, and sibling path.
   */
  async buildNoteProof<NoteLike>(
    blockReference: BlockNumber | BlockHash,
    note: NoteDao,
    noteMapper: (note: Note) => NoteLike,
  ): Promise<NoteProofData<NoteLike>> {
    return buildNoteProof(this.aztecNode, blockReference, note, noteMapper);
  }

  /**
   * Build note-hash inclusion proofs for a batch of notes.
   *
   * @param blockReference - Block number or hash at which to prove inclusion.
   * @param note - The note to prove.
   * @param noteMapper - Callback that decodes the raw {@link Note} into the desired shape.
   * @returns Proof data containing the decoded note, storage slot, randomness, nonce, and sibling path.
   */
  async buildMigrationNoteProof<T>(
    blockReference: BlockNumber | BlockHash,
    migrationNotesAndData: MigrationNoteAndData<T>,
  ): Promise<MigrationNoteProofData<T>> {
    return buildMigrationNoteProof(
      this.aztecNode,
      blockReference,
      migrationNotesAndData.note,
      migrationNotesAndData.data,
    );
  }

  /**
   * Build nullifier non-inclusion proofs for a batch of notes.
   *
   * @param blockReference - Block number or hash at which to prove non-inclusion.
   * @param notes - The notes whose siloed nullifiers are checked.
   * @returns Proof data containing the decoded note, storage slot, randomness, nonce, and sibling path.
   */
  async buildNullifierProof(
    blockReference: BlockNumber | BlockHash,
    note: NoteDao,
  ): Promise<NonNullificationProofData> {
    return buildNullifierProof(this.aztecNode, blockReference, note);
  }

  /**
   * Build combined note-hash inclusion **and** nullifier non-inclusion proofs.
   * Merges the results of {@link buildNoteProof} and {@link buildNullifierProof}.
   *
   * @param blockReference - Block number or hash at which to prove.
   * @param note - The note to prove.
   * @param noteMapper - Callback that decodes the raw {@link Note}.
   * @returns Proof data containing the decoded note, storage slot, randomness, nonce, and sibling path.
   */
  async buildFullNoteProof<NoteLike>(
    blockReference: BlockNumber | BlockHash,
    note: NoteDao,
    noteMapper: (note: Note) => NoteLike,
  ): Promise<FullProofData<NoteLike>> {
    const noteProof = await this.buildNoteProof(
      blockReference,
      note,
      noteMapper,
    );
    const nullifierProof = await this.buildNullifierProof(blockReference, note);
    return {
      note_proof_data: noteProof,
      non_nullification_proof_data: nullifierProof,
    };
  }

  /**
   * Build a note-hash inclusion proof for a key note.
   *
   * @param keyRegistry - Address of the key registry contract.
   * @param owner - Owner of the key note.
   * @param blockReference - Block number or hash at which to prove inclusion.
   * @returns Proof data containing the decoded key note, storage slot, randomness, nonce, and sibling path.
   */
  async buildKeyNoteProofData(
    keyRegistry: AztecAddress,
    owner: AztecAddress,
    blockReference: BlockNumber | BlockHash,
  ): Promise<NoteProofData<KeyNote>> {
    const keyNotes = await this.getNotes({
      owner: owner,
      contractAddress: keyRegistry,
      storageSlot:
        MigrationKeyRegistryContractArtifact.storageLayout.registered_keys.slot,
      scopes: [owner],
    });
    if (keyNotes.length === 0) {
      throw new Error("No key notes found");
    } else if (keyNotes.length > 1) {
      throw new Error("Multiple key notes found, expected exactly one");
    }
    return await buildNoteProof(
      this.aztecNode,
      blockReference,
      keyNotes[0],
      (note) => KeyNote.fromNote(note),
    );
  }
}
