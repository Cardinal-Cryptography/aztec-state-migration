#!/bin/bash
set -e

# Mac ARM runs as host user (not root), so Dockerfile-installed tools
# in /root/ are inaccessible. Install Foundry + soldeer into $HOME.

# Install Foundry (forge, cast, anvil)
if ! command -v forge &> /dev/null; then
  echo "Installing Foundry..."
  curl -L https://foundry.paradigm.xyz | bash
  export PATH="$HOME/.foundry/bin:$PATH"
  foundryup
  echo "✓ Foundry installed at $(which forge)"
fi
export PATH="$HOME/.foundry/bin:$PATH"

# Install soldeer (Solidity dependency manager)
if ! command -v soldeer &> /dev/null; then
  echo "Installing soldeer..."
  if ! command -v cargo &> /dev/null; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    export PATH="$HOME/.cargo/bin:$PATH"
  fi
  cargo install soldeer
  echo "✓ soldeer installed at $(which soldeer)"
fi
export PATH="$HOME/.cargo/bin:$PATH"

# Run the standard development setup (yarn, aztec CLI, nargo, solidity deps)
bash .devcontainer/development/postCreate.sh

# Symlink nargo to a fixed path for VS Code (HOME varies per Mac user)
ln -sf "$HOME/.nargo/bin/nargo" /usr/local/bin/nargo

echo "=== Mac ARM setup complete ==="
echo "Rosetta-accelerated compilation is enabled via Docker-outside-of-Docker."
