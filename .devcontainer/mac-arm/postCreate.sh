#!/bin/bash
set -e

# Mac ARM overrides HOME to the host user's path, so Dockerfile-installed
# tools in /root/ are not on the default PATH. Install Foundry into $HOME.

# Install Foundry (forge, cast, anvil)
if ! command -v forge &> /dev/null; then
  echo "Installing Foundry..."
  curl -L https://foundry.paradigm.xyz | bash
  export PATH="$HOME/.foundry/bin:$PATH"
  foundryup
  echo "✓ Foundry installed at $(which forge)"
fi
export PATH="$HOME/.foundry/bin:$PATH"

# Run the standard development setup (yarn, aztec CLI, nargo, solidity deps)
bash .devcontainer/development/postCreate.sh

# Symlink nargo to a fixed path for VS Code (HOME varies per Mac user)
ln -sf "$HOME/.nargo/bin/nargo" /usr/local/bin/nargo

echo "=== Mac ARM setup complete ==="
echo "Rosetta-accelerated compilation is enabled via Docker-outside-of-Docker."
