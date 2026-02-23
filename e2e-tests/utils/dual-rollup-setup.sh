#!/bin/bash
# =============================================================================
# Dual Rollup Setup Script
# =============================================================================
# Sets up a local dual-rollup environment for E2E testing:
#   1. Start Anvil (local L1)
#   2. Deploy L1 contracts for both rollups (TS)
#   3. Start both Aztec nodes (TS, shared dateProvider)
#
# =============================================================================

set -euo pipefail

# Directories and files
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEPLOYMENT_FILE="$SCRIPT_DIR/dual-rollups-deployment.json"

# Ports
ANVIL_PORT=8545
NODE1_PORT=8080
NODE2_PORT=8081

# URLs
L1_RPC_URL="http://localhost:$ANVIL_PORT"

# Log files
NODES_LOG="$SCRIPT_DIR/nodes.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# =============================================================================
# Step 0: Clean up old state
# =============================================================================
echo ""
echo "=========================================="
echo "Step 0: Cleaning up"
echo "=========================================="

pkill anvil || true
pkill -f "start-nodes.ts" || true
pkill -f "aztec.*start" || true
# Kill anything holding our ports
for port in $NODE1_PORT $NODE2_PORT $ANVIL_PORT; do
    fuser -k "$port/tcp" 2>/dev/null || true
done
sleep 2

rm -rf "$SCRIPT_DIR/node1-data" "$SCRIPT_DIR/node2-data"
> "$NODES_LOG"
rm -f "$DEPLOYMENT_FILE"

log_success "Cleaned up"

# =============================================================================
# Step 1: Start Anvil
# =============================================================================
echo ""
echo "=========================================="
echo "Step 1: Starting Anvil"
echo "=========================================="

log_info "Starting Anvil on port $ANVIL_PORT..."
anvil --port "$ANVIL_PORT" --accounts 20 --silent &
ANVIL_PID=$!

# Wait for Anvil to be ready
for i in $(seq 1 30); do
    if curl -s "$L1_RPC_URL" -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
        2>/dev/null | grep -q "result"; then
        log_success "Anvil is ready on port $ANVIL_PORT (PID: $ANVIL_PID)"
        break
    fi
    if [ "$i" -eq 30 ]; then
        log_error "Anvil failed to start within 30 seconds"
        exit 1
    fi
    sleep 1
done

# =============================================================================
# Step 2: Deploy L1 contracts for both rollups
# =============================================================================
echo ""
echo "=========================================="
echo "Step 2: Deploying L1 contracts"
echo "=========================================="

log_info "Deploying L1 contracts for both rollups..."

L1_RPC_URL="$L1_RPC_URL" \
L1_CHAIN_ID=31337 \
  npx tsx "$SCRIPT_DIR/deploy-rollups.ts" || {
    log_error "L1 contract deployment failed"
    kill $ANVIL_PID 2>/dev/null || true
    exit 1
}

if [ ! -f "$DEPLOYMENT_FILE" ]; then
    log_error "Deployment file not created: $DEPLOYMENT_FILE"
    kill $ANVIL_PID 2>/dev/null || true
    exit 1
fi

log_success "L1 contracts deployed"
echo "  Deployment info: $DEPLOYMENT_FILE"

# =============================================================================
# Step 3: Start both Aztec nodes
# =============================================================================
echo ""
echo "=========================================="
echo "Step 3: Starting Aztec nodes"
echo "=========================================="

log_info "Starting Node 1 (port $NODE1_PORT) and Node 2 (port $NODE2_PORT)..."

# Env vars for node config
ETHEREUM_HOSTS="$L1_RPC_URL" \
L1_CHAIN_ID=31337 \
P2P_ENABLED=false \
PROVER_REAL_PROOFS=false \
TEST_ACCOUNTS=true \
SPONSORED_FPC=true \
SEQ_ENFORCE_TIME_TABLE=false \
ARCHIVER_POLLING_INTERVAL_MS=200 \
  node --no-warnings "$SCRIPT_DIR/start-nodes.ts" \
  </dev/null 2>&1 | stdbuf -oL sed 's/\x1b\[[0-9;]*m//g' > "$NODES_LOG" &

NODES_PID=$!

# Wait for both nodes to be ready
for port in $NODE1_PORT $NODE2_PORT; do
    log_info "Waiting for node on port $port..."
    for i in $(seq 1 300); do
        if curl -s "http://localhost:$port" -X POST -H "Content-Type: application/json" \
            -d '{"jsonrpc":"2.0","method":"node_getNodeInfo","params":[],"id":1}' \
            2>/dev/null | grep -q "rollupAddress"; then
            log_success "Node on port $port is ready"
            break
        fi
        if [ "$i" -eq 300 ]; then
            log_error "Node on port $port failed to start within 600 seconds"
            echo "Last 50 lines of nodes.log:"
            tail -50 "$NODES_LOG"
            kill $NODES_PID 2>/dev/null || true
            kill $ANVIL_PID 2>/dev/null || true
            exit 1
        fi
        sleep 2
        printf "."
    done
    echo ""
done

# =============================================================================
# Done!
# =============================================================================
echo ""
echo "=========================================="
echo "Dual rollup setup complete!"
echo "=========================================="
log_success "Node 1 running on port $NODE1_PORT (Rollup 1)"
log_success "Node 2 running on port $NODE2_PORT (Rollup 2)"
log_info "Logs: $NODES_LOG"
log_info "Deployment: $DEPLOYMENT_FILE"
log_info "To stop: ./e2e-tests/utils/dual-rollup-stop.sh"
