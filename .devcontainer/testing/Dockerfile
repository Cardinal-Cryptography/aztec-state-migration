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

# Install Aztec CLI via official installer (same method as CI)
RUN curl -sL "https://install.aztec.network/${AZTEC_VERSION}/" -o /tmp/aztec-install.sh \
    && VERSION=${AZTEC_VERSION} bash /tmp/aztec-install.sh <<< "yes" \
    && rm /tmp/aztec-install.sh
ENV PATH="/root/.aztec/current/bin:/root/.aztec/current/node_modules/.bin:/root/.aztec/bin:${PATH}"
