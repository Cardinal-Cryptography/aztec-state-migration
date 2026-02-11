#!/bin/bash
set -e

echo "=== Starting devcontainer setup ==="

# Install yarn dependencies
echo "Installing yarn dependencies..."
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 yarn
echo "✓ Yarn dependencies installed"

# Install Aztec
echo "Installing Aztec..."
AZTEC_VERSION="3.0.0-devnet.6-patch.1"
AZTEC_BIN_PATH="/usr/local/bin"
AZTEC_INSTALL_URI="https://install.aztec.network/${AZTEC_VERSION}"

echo "  VERSION: ${AZTEC_VERSION}"
echo "  BIN_PATH: ${AZTEC_BIN_PATH}"

# Create .aztec directory with version file so the aztec CLI wrapper
# knows which Docker image tag to use (otherwise it defaults to "latest")
mkdir -p "$HOME/.aztec"
echo "${AZTEC_VERSION}" > "$HOME/.aztec/default_version"
echo "  Created $HOME/.aztec/default_version -> ${AZTEC_VERSION}"

# Pull the Docker image
echo "Pulling aztec version ${AZTEC_VERSION}..."
docker pull "aztecprotocol/aztec:${AZTEC_VERSION}"

# Install available binaries manually (some don't exist for this version)
# Required binaries that must exist:
for bin in .aztec-run aztec aztec-up; do
  echo "Installing ${bin}..."
  curl -fsSL "${AZTEC_INSTALL_URI}/${bin}" -o "${AZTEC_BIN_PATH}/${bin}"
  chmod +x "${AZTEC_BIN_PATH}/${bin}"
  echo "  Installed: ${AZTEC_BIN_PATH}/${bin}"
done

# Optional binaries (may not exist for all versions)
for bin in aztec-nargo aztec-postprocess-contract aztec-wallet; do
  echo "Installing ${bin} (optional)..."
  if curl -fsSL "${AZTEC_INSTALL_URI}/${bin}" -o "${AZTEC_BIN_PATH}/${bin}" 2>/dev/null; then
    chmod +x "${AZTEC_BIN_PATH}/${bin}"
    echo "  Installed: ${AZTEC_BIN_PATH}/${bin}"
  else
    echo "  Skipped: ${bin} (not available for this version)"
  fi
done

echo "✓ Aztec installed"

# Verify installation
echo "Verifying Aztec installation..."
if command -v aztec &> /dev/null; then
  echo "✓ aztec command found at: $(which aztec)"
  aztec --version || echo "Warning: Could not get aztec version"
else
  echo "✗ ERROR: aztec command not found in PATH"
  echo "PATH: $PATH"
  ls -la /usr/local/bin/ | grep -i aztec || echo "No aztec files in /usr/local/bin"
  exit 1
fi

# Install Solidity dependencies
echo "Installing Solidity dependencies..."
cd solidity && soldeer install && cd ..
echo "✓ Solidity dependencies installed"

echo "=== Devcontainer setup complete ==="
