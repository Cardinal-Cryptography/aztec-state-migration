import type {
  Hex,
  PublicClient,
  WalletClient,
  Chain,
  Transport,
  Account,
} from "viem";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { TestWallet } from "@aztec/test-wallet/server";
import type { AccountManager } from "@aztec/aztec.js/wallet";
import { MigrationTestBaseWallet } from "../ts/migration-lib/wallet/migration-test-base-wallet.js";

export interface DeploymentResult {
  [rollupVersion: number]: {
    // Aztec node client
    aztecNode: AztecNode;

    // Wallet (TestWallet can act as any registered account)
    deployerWallet: TestWallet;

    // Deployer account
    deployerManager: AccountManager;

    // Migration wallet (for signing migration proofs)
    migrationWallet: MigrationTestBaseWallet;

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
