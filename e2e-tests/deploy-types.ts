import type {
  Hex,
  PublicClient,
  WalletClient,
  Chain,
  Transport,
  Account,
} from "viem";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { AccountManager } from "@aztec/aztec.js/wallet";
import { MigrationEmbeddedWallet } from "aztec-state-migration/wallet/base";

export interface DeploymentResult {
  [rollupVersion: number]: {
    // Aztec node client
    aztecNode: AztecNode;

    // Wallet (EmbeddedWallet can act as any registered account)
    deployerWallet: EmbeddedWallet;

    // Deployer account
    deployerManager: AccountManager;

    // Migration wallet (for signing migration proofs)
    migrationWallet: MigrationEmbeddedWallet;

    inboxAddress: string;
  };
  // L1 addresses
  poseidon2Address: Hex;
  l1MigratorAddress: Hex;

  // Rollup metadata
  oldRollupVersion: number;
  newRollupVersion: number;

  // L1 clients
  publicClient: PublicClient;
  l1WalletClient: WalletClient<Transport, Chain, Account>;

  // ExtendedWalletClient L1
  l1ExtendedClient: any;
}

export interface FundResult {
  claimAmount: bigint;
  claimSecret: import("@aztec/foundation/curves/bn254").Fr;
  messageLeafIndex: bigint;
  messageHash: Hex;
}
