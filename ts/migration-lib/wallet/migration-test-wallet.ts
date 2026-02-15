import {
  EcdsaKAccountContract,
  EcdsaRAccountContract,
} from "@aztec/accounts/ecdsa";
import { SchnorrAccountContract } from "@aztec/accounts/schnorr";
import {
  StubAccountContractArtifact,
  createStubAccount,
} from "@aztec/accounts/stub";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { getContractInstanceFromInstantiationParams } from "@aztec/aztec.js/contracts";
import { Fq, Fr, Point } from "@aztec/aztec.js/fields";
import type { AztecNode } from "@aztec/aztec.js/node";
import { AccountManager } from "@aztec/aztec.js/wallet";
import {
  type PXEConfig,
  type PXECreationOptions,
  createPXE,
  getPXEConfig,
} from "@aztec/pxe/server";
import { deriveSigningKey, PublicKeys } from "@aztec/stdlib/keys";
import { MigrationTestBaseWallet } from "./migration-test-base-wallet.js";

/**
 * Concrete migration wallet for testing. Creates its own PXE instance and
 * supports Schnorr, ECDSA-R, and ECDSA-K account types.
 */
export class MigrationTestWallet extends MigrationTestBaseWallet {
  /**
   * Create a new {@link MigrationTestWallet} backed by a fresh PXE.
   *
   * @param node - The Aztec node to connect the PXE to.
   * @param overridePXEConfig - Optional overrides for the default PXE configuration.
   * @param options - PXE creation options (loggers, etc.).
   * @returns A ready-to-use wallet instance.
   */
  static async create(
    node: AztecNode,
    overridePXEConfig?: Partial<PXEConfig>,
    options: PXECreationOptions = { loggers: {} },
  ): Promise<MigrationTestWallet> {
    const pxeConfig = Object.assign(getPXEConfig(), {
      proverEnabled: overridePXEConfig?.proverEnabled ?? false,
      ...overridePXEConfig,
    });
    const pxe = await createPXE(node, pxeConfig, options);
    return new MigrationTestWallet(pxe, node);
  }

  /** @inheritdoc */
  getMigrationPublicKey(account: AztecAddress): Point | undefined {
    return this.accounts.get(account.toString())?.getMigrationPublicKey();
  }

  /** @inheritdoc */
  getPublicKeys(account: AztecAddress): PublicKeys | undefined {
    return this.accounts.get(account.toString())?.getPublicKeys();
  }

  /**
   * Create and register a Schnorr-based account.
   *
   * @param secret - The master secret key.
   * @param salt - Salt for address derivation.
   * @param signingKey - Optional Grumpkin signing key; derived from `secret` if omitted.
   * @returns An {@link AccountManager} for the new account.
   */
  createSchnorrAccount(
    secret: Fr,
    salt: Fr,
    signingKey?: Fq,
  ): Promise<AccountManager> {
    signingKey = signingKey ?? deriveSigningKey(secret);
    const accountData = {
      secret,
      salt,
      contract: new SchnorrAccountContract(signingKey),
    };
    return this.createAccount(accountData);
  }

  /**
   * Create and register an ECDSA-R account.
   *
   * @param secret - The master secret key.
   * @param salt - Salt for address derivation.
   * @param signingKey - The ECDSA signing key buffer.
   * @returns An {@link AccountManager} for the new account.
   */
  createECDSARAccount(
    secret: Fr,
    salt: Fr,
    signingKey: Buffer,
  ): Promise<AccountManager> {
    const accountData = {
      secret,
      salt,
      contract: new EcdsaRAccountContract(signingKey),
    };
    return this.createAccount(accountData);
  }

  /**
   * Create and register an ECDSA-K account.
   *
   * @param secret - The master secret key.
   * @param salt - Salt for address derivation.
   * @param signingKey - The ECDSA signing key buffer.
   * @returns An {@link AccountManager} for the new account.
   */
  createECDSAKAccount(
    secret: Fr,
    salt: Fr,
    signingKey: Buffer,
  ): Promise<AccountManager> {
    const accountData = {
      secret,
      salt,
      contract: new EcdsaKAccountContract(signingKey),
    };
    return this.createAccount(accountData);
  }

  /**
   * Build a stub account + contract instance for simulated simulations.
   *
   * @param address - The real account address to impersonate.
   * @returns Stub account, contract instance, and artifact for the PXE override.
   */
  async getFakeAccountDataFor(address: AztecAddress) {
    const chainInfo = await this.getChainInfo();
    const originalAccount = await this.getAccountFromAddress(address);
    const originalAddress = originalAccount.getCompleteAddress();
    const { contractInstance } = await this.pxe.getContractMetadata(
      originalAddress.address,
    );
    if (!contractInstance) {
      throw new Error(
        `No contract instance found for address: ${originalAddress.address}`,
      );
    }
    const stubAccount = createStubAccount(originalAddress, chainInfo);
    const instance = await getContractInstanceFromInstantiationParams(
      StubAccountContractArtifact,
      {
        salt: Fr.random(),
      },
    );
    return {
      account: stubAccount,
      instance,
      artifact: StubAccountContractArtifact,
    };
  }
}
