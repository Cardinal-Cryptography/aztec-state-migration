import { Account, ChainInfo, SignerlessAccount } from "@aztec/aztec.js/account";
import { AccountInterface, BaseAccount } from "@aztec/aztec.js/account";
import {
  deriveKeys,
  generatePublicKey,
  PublicKeys,
} from "@aztec/aztec.js/keys";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import { Fq, Fr, Point } from "@aztec/aztec.js/fields";
import { deriveMasterMigrationSecretKey } from "../keys.js";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { MigrationSignature } from "../types.js";

/**
 * Extension of the standard Aztec {@link Account} with migration-specific
 * key management and signing capabilities.
 */
export interface MigrationAccount extends Account {
  /** Return the Grumpkin public key used for migration signing. */
  getMigrationPublicKey: () => Point;

  /**
   * Sign an arbitrary message with the master migration secret key (Schnorr).
   * @param msg - The message bytes to sign.
   * @returns The migration signature.
   */
  migrationKeySigner: (msg: Uint8Array) => Promise<MigrationSignature>;

  /**
   * Compute the masked nullifier secret key for cross-rollup note ownership transfer.
   * @param newRollupAccount - The recipient account on the new rollup.
   * @param contractAddress - The app contract address (used for domain separation).
   * @returns The masked `Fq` key.
   */
  getMaskedNsk: (
    newRollupAccount: MigrationAccount,
    contractAddress: AztecAddress,
  ) => Promise<Fq>;

  /** Return the full set of public keys derived from the account secret. */
  getPublicKeys: () => PublicKeys;
}

/**
 * Default implementation of {@link MigrationAccount} that derives and stores all
 * migration keys in memory.
 *
 * **Note:** Suitable for testing; production wallets should protect key material.
 */
export class BaseMigrationAccount
  extends BaseAccount
  implements MigrationAccount
{
  // NOTE: Stores the keys in memory,
  // which is fine for testing but should be handled securely in production.
  constructor(
    account: AccountInterface,
    protected readonly masterNullifierSecretKey: Fq,
    protected readonly masterMigrationSecretKey: Fq,
    protected readonly migrationPublicKey: Point,
    protected readonly publicKeys: PublicKeys,
  ) {
    super(account);
  }

  /**
   * Factory that derives all migration keys from an account interface and secret.
   *
   * @param account - The underlying account interface (e.g. Schnorr).
   * @param secret - The master secret key from which migration keys are derived.
   * @returns A fully initialised {@link BaseMigrationAccount}.
   */
  static async create(
    account: AccountInterface,
    secret: Fr,
  ): Promise<BaseMigrationAccount> {
    const msk = deriveMasterMigrationSecretKey(secret);
    const { masterNullifierSecretKey, publicKeys } = await deriveKeys(secret);
    const mpk = await generatePublicKey(msk);
    return new BaseMigrationAccount(
      account,
      masterNullifierSecretKey,
      msk,
      mpk,
      publicKeys,
    );
  }

  /** @returns The full set of public keys for this account. */
  getPublicKeys(): PublicKeys {
    return this.publicKeys;
  }

  /** @returns The Grumpkin point used as the migration public key. */
  getMigrationPublicKey(): Point {
    return this.migrationPublicKey;
  }

  /**
   * Schnorr-sign a message with the master migration secret key.
   * @param msg - The message bytes to sign.
   * @returns The migration signature.
   */
  migrationKeySigner = async (msg: Uint8Array): Promise<MigrationSignature> => {
    const schnorr = new Schnorr();
    return MigrationSignature.fromSchnorrSignature(
      await schnorr.constructSignature(msg, this.masterMigrationSecretKey),
    );
  };

  /**
   * Compute a masked nullifier secret key so the new-rollup account can
   * nullify notes originally owned by this account.
   *
   * @param newRollupAccount - The recipient account on the new rollup.
   * @param contractAddress - The app contract address (domain separation).
   * @returns The masked `Fq` value (`nsk.hi + mask`, `nsk.lo + mask`).
   */
  async getMaskedNsk(
    newRollupAccount: MigrationAccount,
    contractAddress: AztecAddress,
  ): Promise<Fq> {
    let mask = await this.getMask(newRollupAccount, contractAddress);
    return this.masterNullifierSecretKey.add(mask);
  }

  /**
   * Compute the mask applied to the nullifier secret key.
   * Currently returns zero (no mask); will be replaced with a Poseidon2-based
   * derivation.
   */
  protected getMask = async (
    _newRollupAccount: MigrationAccount,
    _contractAddress: AztecAddress,
  ): Promise<Fq> => {
    // const nskApp = await computeAppNullifierSecretKey(this.masterNullifierSecretKey, contractAddress);
    // return new Fq(poseidon2Hash([NSK_MASK_DOMAIN,nskApp]).toBigInt());
    // For now just return zero (no mask applied)
    return Fq.ZERO;
  };
}

/**
 * A {@link MigrationAccount} that cannot sign or produce keys.
 * Used as a placeholder for the `AztecAddress.ZERO` sender in fee-less transactions.
 */
export class SignerlessMigrationAccount
  extends SignerlessAccount
  implements MigrationAccount
{
  constructor(chainInfo: ChainInfo) {
    super(chainInfo);
  }

  getMigrationPublicKey(): Point {
    throw new Error(
      "SignerlessMigrationAccount: Method getMigrationPublicKey not implemented.",
    );
  }

  async migrationKeySigner(msg: Uint8Array): Promise<MigrationSignature> {
    throw new Error(
      "SignerlessMigrationAccount: Method migrationKeySigner not implemented.",
    );
  }

  getEnryptedNskApp(): Promise<Fr> {
    throw new Error(
      "SignerlessMigrationAccount: Method getEnryptedNskApp not implemented.",
    );
  }

  getMaskedNsk(
    _newRollupAccount: MigrationAccount,
    _contractAddress: AztecAddress,
  ): Promise<Fq> {
    throw new Error(
      "SignerlessMigrationAccount: Method getMaskedNsk not implemented.",
    );
  }

  getPublicKeys(): PublicKeys {
    throw new Error(
      "SignerlessMigrationAccount: Method getPublicKeys not implemented.",
    );
  }
}
