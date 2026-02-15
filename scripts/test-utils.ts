import {
  ExampleMigrationAppContract,
  ExampleMigrationAppContractArtifact,
} from "../noir/target/artifacts/ExampleMigrationApp.js";
import { MigrationArchiveRegistryContract } from "../noir/target/artifacts/MigrationArchiveRegistry.js";
import { MigrationKeyRegistryContract } from "../noir/target/artifacts/MigrationKeyRegistry.js";
import { Fq, Fr } from "@aztec/foundation/curves/bn254";
import { BlockNumber } from "@aztec/foundation/branded-types";
import { EthAddress } from "@aztec/foundation/eth-address";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import {
  waitForBlockProof,
  migrateArchiveRootOnL1,
  waitForL1ToL2Message,
  buildArchiveProof,
} from "../ts/migration-lib/index.js";
import { FeeJuiceContract } from "@aztec/noir-contracts.js/FeeJuice";
import { ProtocolContractAddress } from "@aztec/protocol-contracts";
import type {
  ArchiveProof,
  L1MigrationResult,
  TestMigrationWallet,
} from "../ts/migration-lib/index.js";
import type { DeploymentResult } from "./deploy-types.js";
import { TestWallet } from "@aztec/test-wallet/server";
import { WaitOpts } from "@aztec/aztec.js/contracts";
import { AccountManager, Wallet } from "@aztec/aztec.js/wallet";
import { AztecNode } from "@aztec/aztec.js/node";
import { FeeJuicePaymentMethodWithClaim } from "@aztec/aztec.js/fee";
import { createLogger } from "@aztec/foundation/log";
import {
  L1FeeJuicePortalManager,
  L2AmountClaim,
  L2Claim,
} from "@aztec/aztec.js/ethereum";
import { GrumpkinScalar } from "@aztec/aztec.js/fields";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";

// ============================================================
// Contract deployment helpers
// ============================================================

/**
 * Deploy ExampleMigrationApp on both old and new rollups.
 * The new app is linked to the old app's address for migration verification.
 */
export async function deployAppPair(
  env: DeploymentResult,
  oldAppAddress?: AztecAddress,
) {
  const old_r = env[env.oldRollupVersion];
  const new_r = env[env.newRollupVersion];
  const oldApp = await ExampleMigrationAppContract.deploy(
    old_r.deployerWallet,
    {
      _is_some: false,
      _value: AztecAddress.ZERO,
    },
  )
    .send({ from: old_r.deployerManager.address })
    .deployed();
  const oldAppInstance = (
    await old_r.deployerWallet.getContractMetadata(oldApp.address)
  ).contractInstance;
  old_r.migrationWallet.registerContract(oldAppInstance!, oldApp.artifact);
  old_r.migrationWallet.registerSender(old_r.deployerManager.address)
  
  const effectiveOldAppAddress = oldAppAddress ?? oldApp.address;
  
  const newApp = await ExampleMigrationAppContract.deploy(
    new_r.deployerWallet,
    {
      _is_some: true,
      _value: effectiveOldAppAddress,
    },
  )
  .send({ from: new_r.deployerManager.address })
  .deployed();
  const newAppInstance = (
    await new_r.deployerWallet.getContractMetadata(newApp.address)
  ).contractInstance;
  new_r.migrationWallet.registerContract(newAppInstance!, newApp.artifact);
  new_r.migrationWallet.registerSender(new_r.deployerManager.address)

  return { oldApp, newApp };
}

/**
 * Deploy MigrationArchiveRegistry on the new rollup.
 * Pass `keyRegistryAddress` for Mode B, omit (defaults to ZERO) for Mode A.
 */
export async function deployArchiveRegistry(
  env: DeploymentResult,
  keyRegistryAddress?: AztecAddress,
) {
  const old_r = env[env.oldRollupVersion];
  const new_r = env[env.newRollupVersion];
  const registry = await MigrationArchiveRegistryContract.deploy(
    new_r.deployerWallet,
    EthAddress.fromString(env.l1MigratorAddress),
    env.oldRollupVersion,
    keyRegistryAddress ?? AztecAddress.ZERO,
  )
    .send({ from: new_r.deployerManager.address })
    .deployed();
  const archiveInstance = (
    await new_r.deployerWallet.getContractMetadata(registry.address)
  ).contractInstance;
  new_r.migrationWallet.registerContract(archiveInstance!, registry.artifact);

  return registry;
}

/**
 * Deploy MigrationKeyRegistry on the old rollup (Mode B only).
 */
export async function deployKeyRegistry(env: DeploymentResult) {
  const old_r = env[env.oldRollupVersion];
  const registry = await MigrationKeyRegistryContract.deploy(
    old_r.deployerWallet,
  )
    .send({ from: old_r.deployerManager.address })
    .deployed();

  const keyRegistryInstance = (
    await old_r.deployerWallet.getContractMetadata(registry.address)
  ).contractInstance;
  old_r.migrationWallet.registerContract(
    keyRegistryInstance!,
    registry.artifact,
  );

  return registry;
}

// ============================================================
// Bridge helper
// ============================================================

export interface BridgeResult {
  l1Result: L1MigrationResult;
  provenBlockNumber: BlockNumber;
  archiveProof: ArchiveProof;
}

/**
 * Full bridge sequence: wait for proof → L1 migrate → wait for L1→L2 message → register on new rollup.
 * Returns the L1 result, proven block number, and archive proof.
 *
 * @param env - Deployment result from deploy()
 * @param archiveRegistry - MigrationArchiveRegistry contract instance on new rollup
 * @param blockNumber - Block number that must be proven before bridging
 * @param opts.onWaitForProof - Called while waiting for block proof
 * @param opts.onWaitForMessage - Called while waiting for L1→L2 message
 */
export async function bridgeArchiveRoot(
  env: DeploymentResult,
  archiveRegistry: ReturnType<
    typeof MigrationArchiveRegistryContract.at
  > extends infer T
    ? T
    : never,
  blockNumber: number,
): Promise<BridgeResult> {
  const old_r = env[env.oldRollupVersion];
  const new_r = env[env.newRollupVersion];
  // Step 1: Wait for block proof
  await waitForBlockProof(old_r.aztecNode, blockNumber, {
    onPoll: async () => {
      await produceBlock(env, new_r.aztecNode);
    },
    intervalMs: 10,
  });

  // Step 2: L1 migrateArchiveRoot
  const l1Result = await migrateArchiveRootOnL1(
    env.l1WalletClient,
    env.publicClient,
    {
      l1MigratorAddress: env.l1MigratorAddress,
      oldRollupVersion: env.oldRollupVersion,
      newArchiveRegistryAddress: archiveRegistry.address,
      newRollupVersion: env.newRollupVersion,
      newInboxAddress: new_r.inboxAddress,
    },
  );

  // Step 3: Wait for L1→L2 message
  await waitForL1ToL2Message(new_r.aztecNode, l1Result.l1ToL2MessageHash, {
    onPoll: async () => {
      await produceBlock(env, new_r.aztecNode);
    },
    intervalMs: 10,
  });

  // Step 4: Register archive root on new rollup
  await archiveRegistry.methods
    .register_archive_root(
      l1Result.provenArchiveRoot,
      l1Result.provenBlockNumber,
      Fr.ZERO,
      new Fr(l1Result.l1ToL2LeafIndex),
    )
    .send({ from: new_r.deployerManager.address })
    .wait();

  const provenBlockNumber = BlockNumber(l1Result.provenBlockNumber);

  // Build archive proof while we're at it
  const archiveProof = await buildArchiveProof(
    old_r.aztecNode,
    provenBlockNumber,
  );

  return { l1Result, provenBlockNumber, archiveProof };
}

// ============================================================
// Other helpers
// ============================================================

/**
 * Deploy account with fee juice claim. The L1→L2 message may not be available
 * immediately — the sandbox only includes L1→L2 messages when L2 blocks are
 * produced. Uses Deployer wallet and address to deploy this account.
 */
export async function deployAndFundAccount(
  env: DeploymentResult,
  aztecNode: AztecNode,
  accountData?: { secret?: Fr; salt?: Fr; signingKey?: Fq },
  waitOptions?: WaitOpts,
): Promise<AccountManager> {
  const rollup = env[await aztecNode.getVersion()];

  const {
    secret = Fr.random(),
    salt = Fr.random(),
    signingKey = Fq.random(),
  } = accountData ?? {};

  const accountManager = await rollup.migrationWallet.createSchnorrAccount(
    secret,
    salt,
    signingKey,
  );

  const claim = await fundAccount(env, aztecNode, accountManager.address);
  await waitForL1ToL2Message(aztecNode, Fr.fromHexString(claim.messageHash), {
    onPoll: async () => {
      await produceBlock(env, aztecNode);
    },
    intervalMs: 10,
  });
  const deployMethod = await accountManager.getDeployMethod();
  await deployMethod
    .send({
      from: AztecAddress.ZERO,
      fee: {
        paymentMethod: new FeeJuicePaymentMethodWithClaim(
          accountManager.address,
          claim,
        ),
      },
    })
    .wait(waitOptions);
  return accountManager;
}

async function fundAccount(
  env: DeploymentResult,
  node: AztecNode,
  to: AztecAddress,
): Promise<L2AmountClaim> {
  const logger = createLogger("deploy");
  const portal = await L1FeeJuicePortalManager.new(
    node,
    env.l1ExtendedClient,
    logger,
  );
  const oldPortal = await L1FeeJuicePortalManager.new(
    env[env.oldRollupVersion].aztecNode,
    env.l1ExtendedClient,
    logger,
  );
  const mintAmount = await oldPortal.getTokenManager().getMintAmount();
  await oldPortal.getTokenManager().mint(env.l1ExtendedClient.account.address);
  return await portal.bridgeTokensPublic(to, mintAmount, false);
}

async function produceBlock(env: DeploymentResult, aztecNode: AztecNode) {
  const rollup = env[await aztecNode.getVersion()];

  const wallet = await TestWallet.create(aztecNode);
  const accountsData = await getInitialTestAccountsData();
  await wallet.createSchnorrAccount(
    accountsData[0].secret,
    accountsData[0].salt,
    accountsData[0].signingKey,
  );

  const accountManager = await wallet.createSchnorrAccount(
    Fr.random(),
    Fr.random(),
    GrumpkinScalar.random(),
  );
  const deployMethod = await accountManager.getDeployMethod();
  const tx = deployMethod.send({ from: rollup.deployerManager.address });
  await tx.getTxHash();
}
