FROM --platform=linux/amd64 ubuntu:24.04
SHELL ["/bin/bash", "-c"]

ENV NVM_DIR=/root/.nvm
ENV NODE_VERSION=24.12.0
ENV AZTEC_VERSION=4.0.0-devnet.2-patch.0

# Install dependencies including newer libstdc++
RUN apt update && apt install -y \
    curl \
    bash \
    git \
    tar \
    gzip \
    libc++-dev \
    libstdc++6 \
    jq \
    python3 \
    build-essential \
    ca-certificates

# Install nvm, node and npm
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.5/install.sh | bash \
    && . "$NVM_DIR/nvm.sh" \
    && nvm install ${NODE_VERSION} \
    && nvm use ${NODE_VERSION} \
    && nvm alias default ${NODE_VERSION}

# Add node and npm to path
ENV PATH="${NVM_DIR}/versions/node/v${NODE_VERSION}/bin:${PATH}"
RUN npm i -g yarn
# enable corepack 
RUN corepack enable

# Install Foundry (Forge, Cast, Anvil)
RUN curl -L https://foundry.paradigm.xyz | bash \
    && /root/.foundry/bin/foundryup
ENV PATH="/root/.foundry/bin:${PATH}"

# Install Rust and Soldeer for Solidity dependency management
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    && /root/.cargo/bin/cargo install soldeer
ENV PATH="/root/.cargo/bin:${PATH}"

# Install Aztec CLI binaries and set default version
RUN mkdir -p /root/.aztec \
    && echo "${AZTEC_VERSION}" > /root/.aztec/default_version \
    && for bin in .aztec-run aztec aztec-up; do \
         curl -fsSL "https://install.aztec.network/${AZTEC_VERSION}/${bin}" -o "/usr/local/bin/${bin}" \
         && chmod +x "/usr/local/bin/${bin}"; \
       done \
    && for bin in aztec-nargo aztec-postprocess-contract aztec-wallet; do \
         curl -fsSL "https://install.aztec.network/${AZTEC_VERSION}/${bin}" -o "/usr/local/bin/${bin}" \
         && chmod +x "/usr/local/bin/${bin}" || true; \
       done
