#!/bin/bash
# =============================================================================
# Dual Rollup Stop Script
# =============================================================================
# Stops all running Aztec containers started by dual-rollup-setup.sh
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }

log_info "Stopping Aztec containers..."

# Kill Node 2 (named aztec-node2)
if docker ps -q --filter "name=aztec-node2" 2>/dev/null | grep -q .; then
    docker kill aztec-node2 2>/dev/null || true
    log_success "Node 2 (aztec-node2) stopped"
else
    log_info "Node 2 (aztec-node2) not running"
fi

# Kill Node 1 (named aztec-start-*)
NODE1_CONTAINERS=$(docker ps -q --filter "name=aztec-start" 2>/dev/null || true)
if [ -n "$NODE1_CONTAINERS" ]; then
    echo "$NODE1_CONTAINERS" | xargs -r docker kill 2>/dev/null || true
    log_success "Node 1 (aztec-start) stopped"
else
    log_info "Node 1 (aztec-start) not running"
fi

log_success "All Aztec containers stopped"
