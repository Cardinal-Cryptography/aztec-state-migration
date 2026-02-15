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

export interface MigrationAccount extends Account {
  getMigrationPublicKey: () => Point;
  migrationKeySigner: (
    msg: Uint8Array<ArrayBufferLike>,
  ) => Promise<Buffer<ArrayBufferLike>>;
  getMaskedNsk: (
    newRollupAccount: MigrationAccount,
    contractAddress: AztecAddress,
  ) => Promise<Fq>;
  getPublicKeys: () => PublicKeys;
}

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

  getPublicKeys(): PublicKeys {
    return this.publicKeys;
  }

  getMigrationPublicKey(): Point {
    return this.migrationPublicKey;
  }

  migrationKeySigner = async (
    msg: Uint8Array<ArrayBufferLike>,
  ): Promise<Buffer<ArrayBufferLike>> => {
    const schnorr = new Schnorr();
    return (
      await schnorr.constructSignature(msg, this.masterMigrationSecretKey)
    ).toBuffer();
  };

  async getMaskedNsk(
    newRollupAccount: MigrationAccount,
    contractAddress: AztecAddress,
  ): Promise<Fq> {
    let mask = await this.getMask(newRollupAccount, contractAddress);
    return Fq.fromHighLow(
      this.masterNullifierSecretKey.hi.add(mask),
      this.masterNullifierSecretKey.lo.add(mask),
    );
  }

  protected getMask = async (
    _newRollupAccount: MigrationAccount,
    _contractAddress: AztecAddress,
  ): Promise<Fr> => {
    // const nskApp = await computeAppNullifierSecretKey(this.masterNullifierSecretKey, contractAddress);
    // return poseidon2Hash([NSK_MASK_DOMAIN,nskApp]);

    // For now just return zero (no mask applied)
    return Fr.ZERO;
  };
}

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

  async migrationKeySigner(
    msg: Uint8Array<ArrayBufferLike>,
  ): Promise<Buffer<ArrayBufferLike>> {
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
