#!/bin/bash
# =============================================================================
# Dual Rollup Setup Script
# =============================================================================
# Follows the official Aztec governance rollup upgrade tutorial:
#   https://docs.aztec.network/developers/nightly/docs/tutorials/testing_governance_rollup_upgrade
#
# Steps:
#   1. Start local network (Anvil + deploy contracts + Node 1)
#   2. Extract addresses from the running node
#   3. Setup forge environment for l1-contracts
#   4. Deploy Rollup 2 via forge script
#   5. Deploy governance payload (RegisterNewRollupVersionPayload)
#   6. Deposit governance tokens
#   7. Advance time, propose, advance time, vote, advance time, execute
#   8. Verify registration & save deployment info
#   9. Start Node 2
#
# =============================================================================

set -euo pipefail

# Disable Foundry's nightly warning
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

# Directories and files
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEPLOYMENT_FILE="$SCRIPT_DIR/dual-rollups-deployment.json"

# Ports
ANVIL_PORT=8545
NODE1_PORT=8080
NODE2_PORT=8081

# URLs
L1_CHAIN_ID=31337
L1_RPC_URL="http://localhost:$ANVIL_PORT"

# Anvil default accounts
PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
DEPLOYER_ADDRESS="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
PRIVATE_KEY_2="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

# Aztec version (must match .devcontainer/setup.sh and package.json)
AZTEC_VERSION="3.0.0-devnet.6-patch.1"
DOCKER_REPO="${DOCKER_REPO:-aztecprotocol/aztec}"

# Paths
L1_CONTRACTS_DIR="$PROJECT_DIR/solidity/dependencies/@aztec-v3.0.2"
AZTEC_BIN=$(command -v aztec 2>/dev/null || echo "$HOME/.aztec/bin/aztec")

# Log files
NODE1_LOG="$SCRIPT_DIR/node1.log"
NODE2_LOG="$SCRIPT_DIR/node2.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }
log_debug()   { echo -e "${PURPLE}[DEBUG]${NC} $1"; }

advance_anvil_time() {
    local seconds=$1
    CURRENT_TS=$(cast block latest --rpc-url "$L1_RPC_URL" -f timestamp)
    TARGET_TS=$((CURRENT_TS + seconds))
    cast rpc anvil_setNextBlockTimestamp $TARGET_TS --rpc-url $L1_RPC_URL -q
    cast rpc anvil_mine 1 --rpc-url $L1_RPC_URL -q

    NEW_TS=$(cast block latest --rpc-url "$L1_RPC_URL" -f timestamp)
    if [ $NEW_TS -ge $TARGET_TS ]; then
        log_success "Time advanced successfully by $seconds seconds (new timestamp: $NEW_TS)"
    else
        log_error "Failed to advance time"
        echo "Current timestamp: $CURRENT_TS"
        echo "Target timestamp: $TARGET_TS"
        echo "New timestamp: $NEW_TS"
        exit 1
    fi
}

# =============================================================================
# Step 0: Clean up old state
# =============================================================================
echo ""
echo "=========================================="
echo "Step 0: Cleaning up"
echo "=========================================="

docker ps -q --filter "ancestor=aztecprotocol/aztec" 2>/dev/null | xargs -r docker kill 2>/dev/null || true
sleep 2

rm -rf "$SCRIPT_DIR/node1-data" "$SCRIPT_DIR/node2-data"
> "$NODE1_LOG"
> "$NODE2_LOG"

log_success "Cleaned up"

# =============================================================================
# Step 1: Start local network (Anvil + deploy contracts + Node 1)
# =============================================================================
echo ""
echo "=========================================="
echo "Step 1: Starting local network"
echo "=========================================="

log_info "Starting aztec local network (Anvil + L1 contracts + Node 1)..."
log_info "  Anvil port: $ANVIL_PORT"
log_info "  Node 1 port: $NODE1_PORT"

ANVIL_PORT=$ANVIL_PORT \
AZTEC_PORT=$NODE1_PORT \
TEST_ACCOUNTS=true \
  $AZTEC_BIN start --local-network > "$NODE1_LOG" 2>&1 &

# Wait for Node 1 to be ready
log_info "Waiting for Node 1 to be ready..."
for i in $(seq 1 300); do
    if curl -s "http://localhost:$NODE1_PORT" -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"node_getNodeInfo","params":[],"id":1}' 2>/dev/null | grep -q "rollupAddress"; then
        log_success "Node 1 is ready on port $NODE1_PORT"
        break
    fi
    if [ "$i" -eq 300 ]; then
        log_error "Node 1 failed to start within 300 seconds"
        echo "Last 50 lines of node1.log:"
        tail -50 "$NODE1_LOG"
        exit 1
    fi
    sleep 2
    printf "."
done

# =============================================================================
# Step 2: Extract addresses from Node 1
# =============================================================================
echo ""
echo "=========================================="
echo "Step 2: Extracting L1 contract addresses"
echo "=========================================="

NODE_INFO=$(curl -s "http://localhost:$NODE1_PORT" -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"node_getNodeInfo","params":[],"id":1}')

REGISTRY_ADDRESS=$(echo "$NODE_INFO" | jq -r '.result.l1ContractAddresses.registryAddress')
ROLLUP1_ADDRESS=$(echo "$NODE_INFO" | jq -r '.result.l1ContractAddresses.rollupAddress')
GOVERNANCE_ADDRESS=$(echo "$NODE_INFO" | jq -r '.result.l1ContractAddresses.governanceAddress')
ROLLUP1_VERSION=$(echo "$NODE_INFO" | jq -r '.result.rollupVersion')

if [ "$REGISTRY_ADDRESS" = "null" ] || [ -z "$REGISTRY_ADDRESS" ]; then
    log_error "Failed to extract registry address from node info"
    echo "$NODE_INFO" | jq .
    exit 1
fi

log_success "Addresses extracted:"
echo "  Registry:    $REGISTRY_ADDRESS"
echo "  Rollup 1:    $ROLLUP1_ADDRESS"
echo "  Governance:  $GOVERNANCE_ADDRESS"
echo "  Rollup 1 Version: $ROLLUP1_VERSION"

# Extract genesis constants for Rollup 2
# The genesis archive root depends on which accounts are pre-funded at genesis.
# --local-network genesis includes extra state (portal balances etc), so Rollup 1's
# archiveAt(0) gives a different value than what --node computes.
# We must compute the genesis root with the SAME accounts Node 2 will use.
log_info "Computing genesis constants for Rollup 2..."

# Compute genesis archive root using the Aztec Docker image's native world state.
# Must match TEST_ACCOUNTS=true and SPONSORED_FPC=true settings used for Node 2.
GENESIS_ARCHIVE_ROOT_HEX=$(docker run --rm --entrypoint sh "$DOCKER_REPO:$AZTEC_VERSION" -c "
cd /usr/src && node --input-type=module -e '
import { getGenesisValues } from \"/usr/src/yarn-project/world-state/dest/testing.js\";
import { getInitialTestAccountsData } from \"/usr/src/yarn-project/accounts/dest/testing/index.js\";
import { getSponsoredFPCAddress } from \"/usr/src/yarn-project/cli/dest/utils/setup_contracts.js\";

const testAccounts = (await getInitialTestAccountsData()).map(a => a.address);
const sponsoredFPC = await getSponsoredFPCAddress();
const allAccounts = testAccounts.concat([sponsoredFPC]);
const { genesisArchiveRoot } = await getGenesisValues(allAccounts);
console.log(genesisArchiveRoot.toString());
process.exit(0);
'
" 2>/dev/null)

if [ -z "$GENESIS_ARCHIVE_ROOT_HEX" ]; then
    log_error "Failed to compute genesis archive root"
    exit 1
fi
export GENESIS_ARCHIVE_ROOT=$(cast --to-dec "$GENESIS_ARCHIVE_ROOT_HEX")

# vkTreeRoot and protocolContractsHash: read from Rollup 1's config storage
# RollupStore is at slot keccak256("aztec.stf.storage")
# config starts at offset +2 (after two mappings)
# vkTreeRoot = config+0, protocolContractsHash = config+1
BASE_SLOT=$(cast keccak "aztec.stf.storage")
VK_SLOT=$(python3 -c "print(hex(int('$BASE_SLOT', 16) + 2))")
PCH_SLOT=$(python3 -c "print(hex(int('$BASE_SLOT', 16) + 3))")

VK_TREE_ROOT_HEX=$(cast storage "$ROLLUP1_ADDRESS" "$VK_SLOT" --rpc-url "$L1_RPC_URL")
PROTOCOL_CONTRACTS_HASH_HEX=$(cast storage "$ROLLUP1_ADDRESS" "$PCH_SLOT" --rpc-url "$L1_RPC_URL")

export VK_TREE_ROOT=$(cast --to-dec "$VK_TREE_ROOT_HEX")
export PROTOCOL_CONTRACTS_HASH=$(cast --to-dec "$PROTOCOL_CONTRACTS_HASH_HEX")

log_success "Genesis constants:"
echo "  GENESIS_ARCHIVE_ROOT:    $GENESIS_ARCHIVE_ROOT_HEX (computed for test accounts + sponsored FPC)"
echo "  VK_TREE_ROOT:            $VK_TREE_ROOT_HEX (from Rollup 1 storage)"
echo "  PROTOCOL_CONTRACTS_HASH: $PROTOCOL_CONTRACTS_HASH_HEX (from Rollup 1 storage)"

# =============================================================================
# Step 3: Deploy Rollup 2 via forge script
# =============================================================================
echo ""
echo "=========================================="
echo "Step 3: Deploying Rollup 2"
echo "=========================================="

log_info "Preparing forge environment for L1 contracts..."
# Copy HonkVerifier.sol to generated directory
mkdir -p "$L1_CONTRACTS_DIR/generated"
cp "$L1_CONTRACTS_DIR/src/HonkVerifier.sol" "$L1_CONTRACTS_DIR/generated/HonkVerifier.sol"

log_info "Running forge script DeployRollupForUpgrade..."

export DEPLOYER_ADDRESS=$DEPLOYER_ADDRESS
# L1 RPC
export L1_CHAIN_ID=$L1_CHAIN_ID
# Registry address
export REGISTRY_ADDRESS=$REGISTRY_ADDRESS
# Rollup configuration (local network defaults)
export AZTEC_SLOT_DURATION=36
export AZTEC_EPOCH_DURATION=16
export AZTEC_TARGET_COMMITTEE_SIZE=0
export AZTEC_LAG_IN_EPOCHS_FOR_VALIDATOR_SET=2
export AZTEC_LAG_IN_EPOCHS_FOR_RANDAO=2
export AZTEC_INBOX_LAG=1
export AZTEC_PROOF_SUBMISSION_EPOCHS=2
export AZTEC_LOCAL_EJECTION_THRESHOLD=0
export AZTEC_SLASHING_ROUND_SIZE_IN_EPOCHS=1
export AZTEC_SLASHING_LIFETIME_IN_ROUNDS=10
export AZTEC_SLASHING_EXECUTION_DELAY_IN_ROUNDS=1
export AZTEC_SLASHING_OFFSET_IN_ROUNDS=0
export AZTEC_SLASHER_FLAVOR=none
export AZTEC_SLASHING_VETOER=0x0000000000000000000000000000000000000000
export AZTEC_SLASHING_DISABLE_DURATION=0
export AZTEC_MANA_TARGET=100000000
export AZTEC_EXIT_DELAY_SECONDS=0
export AZTEC_PROVING_COST_PER_MANA=0
export AZTEC_SLASH_AMOUNT_SMALL=0
export AZTEC_SLASH_AMOUNT_MEDIUM=0
export AZTEC_SLASH_AMOUNT_LARGE=0
export AZTEC_INITIAL_ETH_PER_FEE_ASSET=10000000

DEPLOY_OUTPUT=$(cd solidity && forge script $L1_CONTRACTS_DIR/script/deploy/DeployRollupForUpgrade.s.sol:DeployRollupForUpgrade \
    --rpc-url "$L1_RPC_URL" \
    --broadcast \
    --private-key "$PRIVATE_KEY" \
    --use 0.8.27 2>&1) || {
        log_error "forge script failed:"
        echo "$DEPLOY_OUTPUT"
        exit 1
    }

# Extract JSON from forge output
DEPLOY_JSON=$(echo "$DEPLOY_OUTPUT" | grep "JSON DEPLOY RESULT:" | sed 's/.*JSON DEPLOY RESULT: //' || true)

if [ -z "$DEPLOY_JSON" ]; then
    log_error "Could not find JSON DEPLOY RESULT in forge output"
    echo "$DEPLOY_OUTPUT"
    exit 1
fi

NEW_ROLLUP_ADDRESS=$(echo "$DEPLOY_JSON" | jq -r '.rollupAddress')
ROLLUP2_VERSION=$(echo "$DEPLOY_JSON" | jq -r '.rollupVersion')

log_success "Rollup 2 deployed:"
echo "  Address: $NEW_ROLLUP_ADDRESS"
echo "  Version: $ROLLUP2_VERSION"

# =============================================================================
# Step 4: Deploy governance payload (RegisterNewRollupVersionPayload)
# =============================================================================
echo ""
echo "=========================================="
echo "Step 4: Deploying governance payload"
echo "=========================================="

log_info "Deploying RegisterNewRollupVersionPayload..."
log_info "  This creates 2 governance actions: Registry.addRollup + GSE.addRollup"

CREATE_OUTPUT=$(cd solidity && forge create \
    --rpc-url "$L1_RPC_URL" \
    --broadcast \
    --private-key "$PRIVATE_KEY" \
    $L1_CONTRACTS_DIR/test/governance/scenario/RegisterNewRollupVersionPayload.sol:RegisterNewRollupVersionPayload \
    --constructor-args "$REGISTRY_ADDRESS" "$NEW_ROLLUP_ADDRESS" 2>&1) || {
    log_error "forge create failed:"
    echo "$CREATE_OUTPUT"
    exit 1
}

PAYLOAD_ADDRESS=$(echo "$CREATE_OUTPUT" | grep "Deployed to:" | awk '{print $3}' || true)

if [ -z "$PAYLOAD_ADDRESS" ]; then
    log_error "Could not extract payload address from forge output"
    echo "$CREATE_OUTPUT"
    exit 1
fi

log_success "Payload deployed at: $PAYLOAD_ADDRESS"

# =============================================================================
# Step 5: Deposit governance tokens
# =============================================================================
echo ""
echo "=========================================="
echo "Step 5: Depositing governance tokens"
echo "=========================================="

log_info "Opening governance floodgates (allow all depositors)..."

# Impersonate governance contract on Anvil to call onlySelf function
cast rpc anvil_setBalance "$GOVERNANCE_ADDRESS" "0xDE0B6B3A7640000" --rpc-url "$L1_RPC_URL" -q
cast rpc anvil_impersonateAccount "$GOVERNANCE_ADDRESS" --rpc-url "$L1_RPC_URL" -q
cast send "$GOVERNANCE_ADDRESS" "openFloodgates()" \
    --rpc-url "$L1_RPC_URL" \
    --unlocked \
    --from "$GOVERNANCE_ADDRESS" \
    -q
cast rpc anvil_stopImpersonatingAccount "$GOVERNANCE_ADDRESS" --rpc-url "$L1_RPC_URL" -q

log_info "Minting and depositing governance tokens..."

$AZTEC_BIN deposit-governance-tokens \
    -r "$REGISTRY_ADDRESS" \
    --recipient "$DEPLOYER_ADDRESS" \
    --amount "2000000000000000000000000" \
    --mint \
    --l1-rpc-urls "$L1_RPC_URL" \
    -c $L1_CHAIN_ID \
    --private-key "$PRIVATE_KEY"

log_success "Governance tokens deposited"

# =============================================================================
# Step 6: Advance time (token checkpoint must be in the past)
# =============================================================================
echo ""
echo "=========================================="
echo "Step 6: Advancing time for token checkpoint"
echo "=========================================="

advance_anvil_time 120

# =============================================================================
# Step 7: Create governance proposal
# =============================================================================
echo ""
echo "=========================================="
echo "Step 7: Creating governance proposal"
echo "=========================================="

log_info "Proposing with lock..."

PROPOSE_OUTPUT=$($AZTEC_BIN propose-with-lock \
    -r "$REGISTRY_ADDRESS" \
    -p "$PAYLOAD_ADDRESS" \
    --l1-rpc-urls "$L1_RPC_URL" \
    -c 31337 \
    --private-key "$PRIVATE_KEY" \
    --json 2>&1)

# Try to extract proposal ID from JSON output
PROPOSAL_ID=$(echo "$PROPOSE_OUTPUT" | grep -oP '"proposalId"\s*:\s*\K[0-9]+')

if [ -z "$PROPOSAL_ID" ]; then
    # Fallback: try parsing as plain JSON
    PROPOSAL_ID=$(echo "$PROPOSE_OUTPUT" | jq -r '.proposalId' 2>/dev/null)
fi

if [ -z "$PROPOSAL_ID" ] || [ "$PROPOSAL_ID" = "null" ]; then
    # Default to 0 for the first proposal
    log_warn "Could not parse proposal ID from output, defaulting to 0"
    PROPOSAL_ID=0
fi

log_success "Proposal created with ID: $PROPOSAL_ID"

# =============================================================================
# Step 8: Advance time past voting delay (60s default)
# =============================================================================
echo ""
echo "=========================================="
echo "Step 8: Advancing time past voting delay"
echo "=========================================="

# 120 seconds = 60 (voting delay) + 60 (buffer)
advance_anvil_time 120

# =============================================================================
# Step 9: Vote on proposal
# =============================================================================
echo ""
echo "=========================================="
echo "Step 9: Voting on proposal"
echo "=========================================="

log_info "Checking proposal state..."

CALL_PROPOSAL_STATE_OUTPUT=$(cast call $GOVERNANCE_ADDRESS "getProposalState(uint256)(uint8)" $PROPOSAL_ID --rpc-url "$L1_RPC_URL" 2>&1) || {
    log_error "forge call failed:"
    echo "$CALL_PROPOSAL_STATE_OUTPUT"
    exit 1
}

if [ "$CALL_PROPOSAL_STATE_OUTPUT" -eq 1 ]; then
    log_success "Proposal is active"
else
    log_error "Proposal is not active"
    echo "Proposal state: $CALL_PROPOSAL_STATE_OUTPUT"
    exit 1
fi 

log_info "Voting in favor..."

# Use cast send directly to bypass CLI's pre-check that fails with NotInPast
# We deposited 2M tokens, lockAmount for propose is 1M, so ~1M available for voting
VOTE_AMOUNT="1000000000000000000000000"

VOTE_OUTPUT=$(cast send "$GOVERNANCE_ADDRESS" "vote(uint256,uint256,bool)" \
    "$PROPOSAL_ID" "$VOTE_AMOUNT" true \
    --rpc-url "$L1_RPC_URL" \
    --private-key "$PRIVATE_KEY") || {
    log_error "Voting transaction failed:"
    echo "$VOTE_OUTPUT"
    exit 1
}

log_success "Vote cast"


# =============================================================================
# Step 10: Advance time past voting duration (3600s) + execution delay (60s)
# =============================================================================
echo ""
echo "=========================================="
echo "Step 10: Advancing time past voting + execution delay"
echo "=========================================="

# 3700 seconds = 3600 (voting) + 60 (execution delay) + 40 (buffer)
advance_anvil_time 3700

# =============================================================================
# Step 11: Execute proposal
# =============================================================================
echo ""
echo "=========================================="
echo "Step 11: Executing governance proposal"
echo "=========================================="

EXEC_OUTPUT=$(cast send "$GOVERNANCE_ADDRESS" "execute(uint256)" \
    "$PROPOSAL_ID" \
    --rpc-url "$L1_RPC_URL" \
    --private-key "$PRIVATE_KEY" \
    --gas-limit 5000000 2>&1) || {
    log_error "Execute transaction failed:"
    echo "$EXEC_OUTPUT"
    exit 1
}

# Verify the proposal is now in Executed state (5)
POST_EXEC_STATE=$(cast call "$GOVERNANCE_ADDRESS" "getProposalState(uint256)(uint8)" "$PROPOSAL_ID" --rpc-url "$L1_RPC_URL" 2>&1)
if [ "$POST_EXEC_STATE" -eq 5 ]; then
    log_success "Proposal executed successfully"
else
    log_error "Proposal execution may have failed on-chain (state=$POST_EXEC_STATE)"
    # Check tx receipt status
    TX_HASH=$(echo "$EXEC_OUTPUT" | grep -i "transactionHash" | awk '{print $2}' || true)
    if [ -n "$TX_HASH" ]; then
        TX_STATUS=$(cast receipt "$TX_HASH" status --rpc-url "$L1_RPC_URL" 2>&1 || true)
        log_debug "Transaction receipt status: $TX_STATUS (1 = success, 0 = reverted)"
    fi
    exit 1
fi

# =============================================================================
# Step 12: Verify registration
# =============================================================================
echo ""
echo "=========================================="
echo "Step 12: Verifying registration"
echo "=========================================="

NUM_VERSIONS=$(cast call "$REGISTRY_ADDRESS" "numberOfVersions()(uint256)" --rpc-url "$L1_RPC_URL")
CANONICAL_ROLLUP=$(cast call "$REGISTRY_ADDRESS" "getCanonicalRollup()(address)" --rpc-url "$L1_RPC_URL")

if [ "$NUM_VERSIONS" -lt 2 ]; then
    log_error "Unexpected number of rollup versions in registry"
    echo "Expected 2, got $NUM_VERSIONS"
    exit 1
fi

if [ "$CANONICAL_ROLLUP" != "$NEW_ROLLUP_ADDRESS" ]; then
    log_error "Canonical rollup does not match expected Rollup 2 address"
    exit 1
fi

log_success "Verification successful!"

# =============================================================================
# Step 13: Save deployment info
# =============================================================================
echo ""
echo "=========================================="
echo "Step 13: Saving deployment info"
echo "=========================================="

cat > "$DEPLOYMENT_FILE" << EOF
{
  "registryAddress": "$REGISTRY_ADDRESS",
  "governanceAddress": "$GOVERNANCE_ADDRESS",
  "rollup1": {
    "address": "$ROLLUP1_ADDRESS",
    "version": "$ROLLUP1_VERSION"
  },
  "rollup2": {
    "address": "$NEW_ROLLUP_ADDRESS",
    "version": "$ROLLUP2_VERSION"
  },
  "l1RpcUrl": "$L1_RPC_URL",
  "node1Port": $NODE1_PORT,
  "node2Port": $NODE2_PORT
}
EOF

log_success "Deployment info saved to $DEPLOYMENT_FILE"

# =============================================================================
# Step 14: Start Node 2
# =============================================================================
echo ""
echo "=========================================="
echo "Step 14: Starting Node 2 (Rollup 2)"
echo "=========================================="

log_info "Starting Node 2 for Rollup 2 (version $ROLLUP2_VERSION)..."

# Use the custom start script with TestDateProvider to handle L1 time warps
# from the governance flow. The script is mounted into the container at /usr/src/
# so that @aztec/* package resolution works via the yarn workspace.

docker run --rm \
  --name aztec-node2 \
  --add-host host.docker.internal:host-gateway \
  -p "$NODE2_PORT:$NODE2_PORT" \
  -v "$HOME:$HOME" \
  -v "$SCRIPT_DIR/start-node-with-time-sync.mjs:/usr/src/start-node-with-time-sync.mjs:ro" \
  -e HOME="$HOME" \
  -e AZTEC_PORT="$NODE2_PORT" \
  -e ETHEREUM_HOSTS="http://host.docker.internal:$ANVIL_PORT" \
  -e L1_CHAIN_ID="$L1_CHAIN_ID" \
  -e REGISTRY_CONTRACT_ADDRESS="$REGISTRY_ADDRESS" \
  -e ROLLUP_VERSION="$ROLLUP2_VERSION" \
  -e SEQ_PUBLISHER_PRIVATE_KEY="$PRIVATE_KEY_2" \
  -e VALIDATOR_PRIVATE_KEY="$PRIVATE_KEY_2" \
  -e P2P_ENABLED=false \
  -e PROVER_REAL_PROOFS=false \
  -e TEST_ACCOUNTS=true \
  -e SPONSORED_FPC=true \
  -e SEQ_ENFORCE_TIME_TABLE=false \
  -e ARCHIVER_POLLING_INTERVAL_MS=200 \
  -e FORCE_COLOR=1 \
  --entrypoint "" \
  "$DOCKER_REPO:$AZTEC_VERSION" \
  node --no-warnings /usr/src/start-node-with-time-sync.mjs \
  > "$NODE2_LOG" 2>&1 &

log_info "Waiting for Node 2 to be ready..."
for i in $(seq 1 300); do
    if curl -s "http://localhost:$NODE2_PORT" -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"node_getNodeInfo","params":[],"id":1}' 2>/dev/null | grep -q "rollupAddress"; then
        log_success "Node 2 is ready on port $NODE2_PORT"
        break
    fi
    if [ "$i" -eq 300 ]; then
        log_error "Node 2 failed to start within 300 seconds"
        echo "Last 50 lines of node2.log:"
        tail -50 "$NODE2_LOG"
        exit 1
    fi
    sleep 2
    printf "."
done

echo ""
echo "=========================================="
echo "Dual rollup setup complete!"
echo "=========================================="
log_success "Node 1 running on port $NODE1_PORT (Rollup 1)"
log_success "Node 2 running on port $NODE2_PORT (Rollup 2)"
log_info "Logs: $NODE1_LOG, $NODE2_LOG"
log_info "To stop: ./scripts/utils/dual-rollup-stop.sh"
