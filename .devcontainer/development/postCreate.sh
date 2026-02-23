#!/bin/bash
set -e

echo "=== Starting devcontainer setup ==="

# Install yarn dependencies
echo "Installing yarn dependencies..."
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 yarn
echo "✓ Yarn dependencies installed"

# Install nargo natively via noirup (for Noir LSP / editor support)
NARGO_VERSION="1.0.0-beta.18"
echo "Installing nargo ${NARGO_VERSION} via noirup..."
curl -L https://raw.githubusercontent.com/noir-lang/noirup/refs/heads/main/install | bash
export PATH="$HOME/.nargo/bin:$PATH"
noirup -v "${NARGO_VERSION}"
echo "✓ nargo installed at $(which nargo)"

# Install Solidity dependencies
echo "Installing Solidity dependencies..."
cd solidity && forge soldeer install && cd ..
echo "✓ Solidity dependencies installed"
echo "=== Devcontainer setup complete ==="
