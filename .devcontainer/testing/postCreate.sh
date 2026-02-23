#!/bin/bash
set -e

echo "=== Starting devcontainer setup ==="

# Install yarn dependencies
echo "Installing yarn dependencies..."
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 yarn
echo "✓ Yarn dependencies installed"

# Install Solidity dependencies
echo "Installing Solidity dependencies..."
cd solidity && forge soldeer install && cd ..
echo "✓ Solidity dependencies installed"

echo "=== Devcontainer setup complete ==="
