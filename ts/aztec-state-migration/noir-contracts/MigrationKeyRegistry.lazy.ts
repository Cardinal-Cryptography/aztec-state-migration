import { AztecAddress } from "@aztec/aztec.js/addresses";
import {
  type AztecAddressLike,
  type ContractArtifact,
  type FieldLike,
  loadContractArtifact,
  type NoirCompiledContract,
} from "@aztec/aztec.js/abi";
import {
  Contract,
  ContractBase,
  ContractFunctionInteraction,
  type ContractMethod,
  type ContractStorageLayout,
  DeployMethod,
} from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { PublicKeys } from "@aztec/aztec.js/keys";
import type { Wallet } from "@aztec/aztec.js/wallet";

let cachedArtifact: ContractArtifact | undefined;

/**
 * Lazily loads the MigrationKeyRegistry contract artifact.
 * Uses dynamic import to defer JSON loading until first call.
 */
export async function getMigrationKeyRegistryContractArtifact(): Promise<ContractArtifact> {
  if (!cachedArtifact) {
    const { default: json } =
      await import("../artifacts/migration_key_registry-MigrationKeyRegistry.json");
    cachedArtifact = loadContractArtifact(json as NoirCompiledContract);
  }
  return cachedArtifact;
}

/**
 * Type-safe interface for contract MigrationKeyRegistry.
 * Lazily loads the contract artifact — static factory methods are async.
 */
export class MigrationKeyRegistryContract extends ContractBase {
  private constructor(
    address: AztecAddress,
    artifact: ContractArtifact,
    wallet: Wallet,
  ) {
    super(address, artifact, wallet);
  }

  /**
   * Creates a contract instance.
   * @param address - The deployed contract's address.
   * @param wallet - The wallet to use when interacting with the contract.
   * @returns A new Contract instance.
   */
  public static async at(
    address: AztecAddress,
    wallet: Wallet,
  ): Promise<MigrationKeyRegistryContract> {
    const artifact = await getMigrationKeyRegistryContractArtifact();
    return Contract.at(
      address,
      artifact,
      wallet,
    ) as MigrationKeyRegistryContract;
  }

  /**
   * Creates a tx to deploy a new instance of this contract.
   */
  public static async deploy(wallet: Wallet) {
    const artifact = await getMigrationKeyRegistryContractArtifact();
    return new DeployMethod<MigrationKeyRegistryContract>(
      PublicKeys.default(),
      wallet,
      artifact,
      (instance, wallet) =>
        Contract.at(
          instance.address,
          artifact,
          wallet,
        ) as MigrationKeyRegistryContract,
      Array.from(arguments).slice(1),
    );
  }

  /**
   * Creates a tx to deploy a new instance of this contract using the specified public keys hash to derive the address.
   */
  public static async deployWithPublicKeys(
    publicKeys: PublicKeys,
    wallet: Wallet,
  ) {
    const artifact = await getMigrationKeyRegistryContractArtifact();
    return new DeployMethod<MigrationKeyRegistryContract>(
      publicKeys,
      wallet,
      artifact,
      (instance, wallet) =>
        Contract.at(
          instance.address,
          artifact,
          wallet,
        ) as MigrationKeyRegistryContract,
      Array.from(arguments).slice(2),
    );
  }

  /**
   * Creates a tx to deploy a new instance of this contract using the specified constructor method.
   */
  public static async deployWithOpts<
    M extends keyof MigrationKeyRegistryContract["methods"],
  >(
    opts: { publicKeys?: PublicKeys; method?: M; wallet: Wallet },
    ...args: Parameters<MigrationKeyRegistryContract["methods"][M]>
  ) {
    const artifact = await getMigrationKeyRegistryContractArtifact();
    return new DeployMethod<MigrationKeyRegistryContract>(
      opts.publicKeys ?? PublicKeys.default(),
      opts.wallet,
      artifact,
      (instance, wallet) =>
        Contract.at(
          instance.address,
          artifact,
          wallet,
        ) as MigrationKeyRegistryContract,
      Array.from(arguments).slice(1),
      opts.method ?? "constructor",
    );
  }

  public static get storage(): ContractStorageLayout<"registered_keys"> {
    return {
      registered_keys: {
        slot: new Fr(1n),
      },
    } as ContractStorageLayout<"registered_keys">;
  }

  /** Type-safe wrappers for the public methods exposed by the contract. */
  declare public methods: {
    /** constructor() */
    constructor: (() => ContractFunctionInteraction) &
      Pick<ContractMethod, "selector">;
    /** get(owner: struct) */
    get: ((owner: AztecAddressLike) => ContractFunctionInteraction) &
      Pick<ContractMethod, "selector">;
    /** process_message(message_ciphertext: struct, message_context: struct) */
    process_message: ((
      message_ciphertext: FieldLike[],
      message_context: {
        tx_hash: FieldLike;
        unique_note_hashes_in_tx: FieldLike[];
        first_nullifier_in_tx: FieldLike;
        recipient: AztecAddressLike;
      },
    ) => ContractFunctionInteraction) &
      Pick<ContractMethod, "selector">;
    /** public_dispatch(selector: field) */
    public_dispatch: ((selector: FieldLike) => ContractFunctionInteraction) &
      Pick<ContractMethod, "selector">;
    /** register(mpk: struct) */
    register: ((mpk: {
      x: FieldLike;
      y: FieldLike;
      is_infinite: boolean;
    }) => ContractFunctionInteraction) &
      Pick<ContractMethod, "selector">;
    /** sync_state() */
    sync_state: (() => ContractFunctionInteraction) &
      Pick<ContractMethod, "selector">;
  };
}
