#!/bin/bash
# =============================================================================
# Dual Rollup Stop Script
# =============================================================================
# Stops all processes started by dual-rollup-setup.sh
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }

log_info "Stopping dual-rollup processes..."

# Kill Aztec nodes (start-nodes.ts)
pkill -f "start-nodes.ts" 2>/dev/null && log_success "Nodes stopped" || log_info "Nodes not running"

# Kill any legacy aztec start processes
pkill -f "aztec.*start" 2>/dev/null && log_success "Legacy aztec processes stopped" || true

# Kill Anvil
pkill anvil 2>/dev/null && log_success "Anvil stopped" || log_info "Anvil not running"

# Free ports used by the setup
for port in 8080 8081 8545; do
    fuser -k "$port/tcp" 2>/dev/null || true
done

log_success "All processes stopped"
