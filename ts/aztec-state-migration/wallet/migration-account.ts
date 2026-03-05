import { Account, AccountWithSecretKey, Salt } from "@aztec/aztec.js/account";
import { deriveKeys, PublicKeys } from "@aztec/aztec.js/keys";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import { Fq, Fr, Point } from "@aztec/aztec.js/fields";
import { deriveMasterMigrationSecretKey } from "../key.js";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { MigrationSignature } from "../types.js";
import { derivePublicKeyFromSecretKey } from "@aztec/stdlib/keys";
import { ChainInfo, EntrypointInterface } from "@aztec/entrypoints/interfaces";
import { DefaultMultiCallEntrypoint } from "@aztec/entrypoints/multicall";
import { ExecutionPayload, TxExecutionRequest } from "@aztec/stdlib/tx";
import { GasSettings } from "@aztec/stdlib/gas";
import {
  AuthWitness,
  CallIntent,
  IntentInnerHash,
} from "@aztec/aztec.js/authorization";
import { CompleteAddress } from "@aztec/stdlib/contract";

/**
 * Extension of the standard Aztec {@link Account} with migration-specific
 * key management and signing capabilities.
 */
export interface MigrationAccount extends Account {
  /** Return the Grumpkin public key used for migration signing. */
  getMigrationPublicKey: () => Promise<Point>;

  /**
   * Sign an arbitrary message with the master migration secret key (Schnorr).
   * @param msg - The message bytes to sign.
   * @returns The migration signature.
   */
  migrationKeySigner: (msg: Uint8Array) => Promise<MigrationSignature>;

  /**
   * Return the master nullifier hiding key for this account.
   * @returns The raw `Fq` nullifier hiding key.
   */
  getNhk: () => Promise<Fq>;

  /** Return the full set of public keys derived from the account secret. */
  getPublicKeys: () => Promise<PublicKeys>;
}

/**
 * Default implementation of {@link MigrationAccount} that derives and stores all
 * migration keys in memory.
 *
 * **Note:** Suitable for testing; production wallets should protect key material.
 */
export class MigrationAccountWithSecretKey
  extends AccountWithSecretKey
  implements MigrationAccount
{
  // NOTE: Stores the keys in memory,
  // which is fine for testing but should be handled securely in production.
  constructor(
    account: Account,
    secretKey: Fr,
    /** Deployment salt for this account contract. */
    salt: Salt,
  ) {
    super(account, secretKey, salt);
  }

  /** @returns The full set of public keys for this account. */
  async getPublicKeys(): Promise<PublicKeys> {
    const { publicKeys } = await deriveKeys(this.getSecretKey());
    return publicKeys;
  }

  /** @returns The Grumpkin point used as the migration public key. */
  async getMigrationPublicKey(): Promise<Point> {
    let msk = deriveMasterMigrationSecretKey(this.getSecretKey());
    let mpk = derivePublicKeyFromSecretKey(msk);
    return mpk;
  }

  /**
   * Schnorr-sign a message with the master migration secret key.
   * @param msg - The message bytes to sign.
   * @returns The migration signature.
   */
  migrationKeySigner = async (msg: Uint8Array): Promise<MigrationSignature> => {
    const schnorr = new Schnorr();
    let msk = deriveMasterMigrationSecretKey(this.getSecretKey());
    return MigrationSignature.fromSchnorrSignature(
      await schnorr.constructSignature(msg, msk),
    );
  };

  async getNhk(): Promise<Fq> {
    const { masterNullifierHidingKey } = await deriveKeys(this.getSecretKey());
    return masterNullifierHidingKey;
  }
}

/**
 * Account implementation which creates a transaction using the multicall protocol contract as entrypoint.
 */
export class SignerlessMigrationAccount implements MigrationAccount {
  private entrypoint: EntrypointInterface;

  constructor() {
    this.entrypoint = new DefaultMultiCallEntrypoint();
  }

  createTxExecutionRequest(
    exec: ExecutionPayload,
    gasSettings: GasSettings,
    chainInfo: ChainInfo,
  ): Promise<TxExecutionRequest> {
    return this.entrypoint.createTxExecutionRequest(
      exec,
      gasSettings,
      chainInfo,
    );
  }

  wrapExecutionPayload(
    exec: ExecutionPayload,
    options?: any,
  ): Promise<ExecutionPayload> {
    return this.entrypoint.wrapExecutionPayload(exec, options);
  }

  createAuthWit(
    _intent: Fr | Buffer | IntentInnerHash | CallIntent,
  ): Promise<AuthWitness> {
    throw new Error(
      "SignerlessMigrationAccount: Method createAuthWit not implemented.",
    );
  }

  getCompleteAddress(): CompleteAddress {
    throw new Error(
      "SignerlessMigrationAccount: Method getCompleteAddress not implemented.",
    );
  }

  getAddress(): AztecAddress {
    throw new Error(
      "SignerlessMigrationAccount: Method getAddress not implemented.",
    );
  }

  getMigrationPublicKey(): Promise<Point> {
    throw new Error(
      "SignerlessMigrationAccount: Method getMigrationPublicKey not implemented.",
    );
  }

  migrationKeySigner(msg: Uint8Array): Promise<MigrationSignature> {
    throw new Error(
      "SignerlessMigrationAccount: Method migrationKeySigner not implemented.",
    );
  }

  getNhk(): Promise<Fq> {
    throw new Error(
      "SignerlessMigrationAccount: Method getNhk not implemented.",
    );
  }

  getPublicKeys(): Promise<PublicKeys> {
    throw new Error(
      "SignerlessMigrationAccount: Method getPublicKeys not implemented.",
    );
  }
}
