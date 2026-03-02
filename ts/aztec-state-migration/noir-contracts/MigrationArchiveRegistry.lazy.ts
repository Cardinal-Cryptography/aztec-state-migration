import { AztecAddress } from "@aztec/aztec.js/addresses";
import {
  type AztecAddressLike,
  type ContractArtifact,
  type EthAddressLike,
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
import { EthAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { PublicKeys } from "@aztec/aztec.js/keys";
import type { Wallet } from "@aztec/aztec.js/wallet";

let cachedArtifact: ContractArtifact | undefined;

/**
 * Lazily loads the MigrationArchiveRegistry contract artifact.
 * Uses dynamic import to defer JSON loading until first call.
 */
export async function getMigrationArchiveRegistryContractArtifact(): Promise<ContractArtifact> {
  if (!cachedArtifact) {
    const { default: json } = await import(
      "../artifacts/migration_archive_registry-MigrationArchiveRegistry.json",
      { with: { type: "json" } }
    );
    cachedArtifact = loadContractArtifact(json as NoirCompiledContract);
  }
  return cachedArtifact;
}

/**
 * Type-safe interface for contract MigrationArchiveRegistry.
 * Lazily loads the contract artifact — static factory methods are async.
 */
export class MigrationArchiveRegistryContract extends ContractBase {
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
  ): Promise<MigrationArchiveRegistryContract> {
    const artifact = await getMigrationArchiveRegistryContractArtifact();
    return Contract.at(
      address,
      artifact,
      wallet,
    ) as MigrationArchiveRegistryContract;
  }

  /**
   * Creates a tx to deploy a new instance of this contract.
   */
  public static async deploy(
    wallet: Wallet,
    l1_migrator: EthAddressLike,
    old_rollup_version: FieldLike,
    old_key_registry: AztecAddressLike,
  ) {
    const artifact = await getMigrationArchiveRegistryContractArtifact();
    return new DeployMethod<MigrationArchiveRegistryContract>(
      PublicKeys.default(),
      wallet,
      artifact,
      (instance, wallet) =>
        Contract.at(
          instance.address,
          artifact,
          wallet,
        ) as MigrationArchiveRegistryContract,
      Array.from(arguments).slice(1),
    );
  }

  /**
   * Creates a tx to deploy a new instance of this contract using the specified public keys hash to derive the address.
   */
  public static async deployWithPublicKeys(
    publicKeys: PublicKeys,
    wallet: Wallet,
    l1_migrator: EthAddressLike,
    old_rollup_version: FieldLike,
    old_key_registry: AztecAddressLike,
  ) {
    const artifact = await getMigrationArchiveRegistryContractArtifact();
    return new DeployMethod<MigrationArchiveRegistryContract>(
      publicKeys,
      wallet,
      artifact,
      (instance, wallet) =>
        Contract.at(
          instance.address,
          artifact,
          wallet,
        ) as MigrationArchiveRegistryContract,
      Array.from(arguments).slice(2),
    );
  }

  /**
   * Creates a tx to deploy a new instance of this contract using the specified constructor method.
   */
  public static async deployWithOpts<
    M extends keyof MigrationArchiveRegistryContract["methods"],
  >(
    opts: { publicKeys?: PublicKeys; method?: M; wallet: Wallet },
    ...args: Parameters<MigrationArchiveRegistryContract["methods"][M]>
  ) {
    const artifact = await getMigrationArchiveRegistryContractArtifact();
    return new DeployMethod<MigrationArchiveRegistryContract>(
      opts.publicKeys ?? PublicKeys.default(),
      opts.wallet,
      artifact,
      (instance, wallet) =>
        Contract.at(
          instance.address,
          artifact,
          wallet,
        ) as MigrationArchiveRegistryContract,
      Array.from(arguments).slice(1),
      opts.method ?? "constructor",
    );
  }

  public static get storage(): ContractStorageLayout<
    | "l1_migrator"
    | "old_rollup_version"
    | "old_key_registry"
    | "snapshot_height"
    | "snapshot_block_hash"
    | "archive_roots"
    | "block_hashes"
    | "latest_proven_block"
  > {
    return {
      l1_migrator: { slot: new Fr(1n) },
      old_rollup_version: { slot: new Fr(3n) },
      old_key_registry: { slot: new Fr(5n) },
      snapshot_height: { slot: new Fr(7n) },
      snapshot_block_hash: { slot: new Fr(9n) },
      archive_roots: { slot: new Fr(11n) },
      block_hashes: { slot: new Fr(12n) },
      latest_proven_block: { slot: new Fr(13n) },
    } as ContractStorageLayout<
      | "l1_migrator"
      | "old_rollup_version"
      | "old_key_registry"
      | "snapshot_height"
      | "snapshot_block_hash"
      | "archive_roots"
      | "block_hashes"
      | "latest_proven_block"
    >;
  }

  /** Type-safe wrappers for the public methods exposed by the contract. */
  declare public methods: {
    /** constructor(l1_migrator: struct, old_rollup_version: field, old_key_registry: struct) */
    constructor: ((
      l1_migrator: EthAddressLike,
      old_rollup_version: FieldLike,
      old_key_registry: AztecAddressLike,
    ) => ContractFunctionInteraction) &
      Pick<ContractMethod, "selector">;
    /** consume_l1_to_l2_message(archive_root: field, proven_block_number: integer, secret: field, leaf_index: field) */
    consume_l1_to_l2_message: ((
      archive_root: FieldLike,
      proven_block_number: bigint | number,
      secret: FieldLike,
      leaf_index: FieldLike,
    ) => ContractFunctionInteraction) &
      Pick<ContractMethod, "selector">;
    /** consume_l1_to_l2_message_and_register_block(archive_root: field, proven_block_number: integer, secret: field, leaf_index: field, block_header: struct, archive_sibling_path: array) */
    consume_l1_to_l2_message_and_register_block: ((
      archive_root: FieldLike,
      proven_block_number: bigint | number,
      secret: FieldLike,
      leaf_index: FieldLike,
      block_header: {
        last_archive: { root: FieldLike; next_available_leaf_index: FieldLike };
        state: {
          l1_to_l2_message_tree: {
            root: FieldLike;
            next_available_leaf_index: FieldLike;
          };
          partial: {
            note_hash_tree: {
              root: FieldLike;
              next_available_leaf_index: FieldLike;
            };
            nullifier_tree: {
              root: FieldLike;
              next_available_leaf_index: FieldLike;
            };
            public_data_tree: {
              root: FieldLike;
              next_available_leaf_index: FieldLike;
            };
          };
        };
        sponge_blob_hash: FieldLike;
        global_variables: {
          chain_id: FieldLike;
          version: FieldLike;
          block_number: bigint | number;
          slot_number: FieldLike;
          timestamp: bigint | number;
          coinbase: EthAddressLike;
          fee_recipient: AztecAddressLike;
          gas_fees: {
            fee_per_da_gas: bigint | number;
            fee_per_l2_gas: bigint | number;
          };
        };
        total_fees: FieldLike;
        total_mana_used: FieldLike;
      },
      archive_sibling_path: FieldLike[],
    ) => ContractFunctionInteraction) &
      Pick<ContractMethod, "selector">;
    /** get_block_hash(block_number: integer) */
    get_block_hash: ((
      block_number: bigint | number,
    ) => ContractFunctionInteraction) &
      Pick<ContractMethod, "selector">;
    /** get_latest_proven_block() */
    get_latest_proven_block: (() => ContractFunctionInteraction) &
      Pick<ContractMethod, "selector">;
    /** get_old_key_registry() */
    get_old_key_registry: (() => ContractFunctionInteraction) &
      Pick<ContractMethod, "selector">;
    /** get_snapshot_block_hash() */
    get_snapshot_block_hash: (() => ContractFunctionInteraction) &
      Pick<ContractMethod, "selector">;
    /** get_snapshot_height() */
    get_snapshot_height: (() => ContractFunctionInteraction) &
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
    /** register_block(proven_block_number: integer, block_header: struct, archive_sibling_path: array) */
    register_block: ((
      proven_block_number: bigint | number,
      block_header: {
        last_archive: { root: FieldLike; next_available_leaf_index: FieldLike };
        state: {
          l1_to_l2_message_tree: {
            root: FieldLike;
            next_available_leaf_index: FieldLike;
          };
          partial: {
            note_hash_tree: {
              root: FieldLike;
              next_available_leaf_index: FieldLike;
            };
            nullifier_tree: {
              root: FieldLike;
              next_available_leaf_index: FieldLike;
            };
            public_data_tree: {
              root: FieldLike;
              next_available_leaf_index: FieldLike;
            };
          };
        };
        sponge_blob_hash: FieldLike;
        global_variables: {
          chain_id: FieldLike;
          version: FieldLike;
          block_number: bigint | number;
          slot_number: FieldLike;
          timestamp: bigint | number;
          coinbase: EthAddressLike;
          fee_recipient: AztecAddressLike;
          gas_fees: {
            fee_per_da_gas: bigint | number;
            fee_per_l2_gas: bigint | number;
          };
        };
        total_fees: FieldLike;
        total_mana_used: FieldLike;
      },
      archive_sibling_path: FieldLike[],
    ) => ContractFunctionInteraction) &
      Pick<ContractMethod, "selector">;
    /** set_snapshot_height(height: integer, snapshot_block_header: struct, proven_block_number: integer, archive_sibling_path: array) */
    set_snapshot_height: ((
      height: bigint | number,
      snapshot_block_header: {
        last_archive: { root: FieldLike; next_available_leaf_index: FieldLike };
        state: {
          l1_to_l2_message_tree: {
            root: FieldLike;
            next_available_leaf_index: FieldLike;
          };
          partial: {
            note_hash_tree: {
              root: FieldLike;
              next_available_leaf_index: FieldLike;
            };
            nullifier_tree: {
              root: FieldLike;
              next_available_leaf_index: FieldLike;
            };
            public_data_tree: {
              root: FieldLike;
              next_available_leaf_index: FieldLike;
            };
          };
        };
        sponge_blob_hash: FieldLike;
        global_variables: {
          chain_id: FieldLike;
          version: FieldLike;
          block_number: bigint | number;
          slot_number: FieldLike;
          timestamp: bigint | number;
          coinbase: EthAddressLike;
          fee_recipient: AztecAddressLike;
          gas_fees: {
            fee_per_da_gas: bigint | number;
            fee_per_l2_gas: bigint | number;
          };
        };
        total_fees: FieldLike;
        total_mana_used: FieldLike;
      },
      proven_block_number: bigint | number,
      archive_sibling_path: FieldLike[],
    ) => ContractFunctionInteraction) &
      Pick<ContractMethod, "selector">;
    /** sync_state() */
    sync_state: (() => ContractFunctionInteraction) &
      Pick<ContractMethod, "selector">;
    /** verify_migration_mode_a(block_number: integer, block_hash: field) */
    verify_migration_mode_a: ((
      block_number: bigint | number,
      block_hash: FieldLike,
    ) => ContractFunctionInteraction) &
      Pick<ContractMethod, "selector">;
    /** verify_migration_mode_b(block_hash: field) */
    verify_migration_mode_b: ((
      block_hash: FieldLike,
    ) => ContractFunctionInteraction) &
      Pick<ContractMethod, "selector">;
  };
}
