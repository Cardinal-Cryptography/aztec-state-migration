import type { ExampleMigrationAppContract } from "../noir/target/artifacts/ExampleMigrationApp.js";
import type { MigratorModeAContract } from "../noir/target/artifacts/MigratorModeA.js";
import type { Hex, PublicClient, WalletClient, Chain, Transport, Account } from "viem";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { TestWallet } from "@aztec/test-wallet/server";
import type { AztecAddress } from "@aztec/stdlib/aztec-address";

export interface DeploymentResult {
  // L1 addresses
  poseidon2Address: Hex;
  l1MigratorAddress: Hex;

  // L2 contract instances
  oldApp: ExampleMigrationAppContract;
  newMigrator: MigratorModeAContract;
  newApp: ExampleMigrationAppContract;

  // Rollup metadata
  oldRollupVersion: number;
  newRollupVersion: number;

  // Aztec node clients
  aztecOldNode: AztecNode;
  aztecNewNode: AztecNode;

  // Wallets (TestWallet can act as any registered account)
  oldRollupWallet: TestWallet;
  newRollupWallet: TestWallet;

  // Account addresses
  oldDeployer: AztecAddress;
  oldRollupUser: AztecAddress;
  newDeployer: AztecAddress;
  newRollupUser: AztecAddress;

  // L1 clients
  publicClient: PublicClient;
  l1WalletClient: WalletClient<Transport, Chain, Account>;

  // L1 addresses needed for event parsing
  newInboxAddress: string;
}
