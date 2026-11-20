# Kea's Linux release toolchain on Ubuntu 22.04 (glibc 2.35), for a non-root builder user
# (the package path check refuses a build that leaks its home path, and /root occurs in Electron files).
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates curl git xz-utils \
      build-essential python3 dpkg rpm apparmor desktop-file-utils lintian rpmlint binutils file >/dev/null \
    && rm -rf /var/lib/apt/lists/*
ARG NARCH
ARG NODE_VERSION=26.8.2
ARG PNPM_VERSION=11.0.8
ARG RUST_VERSION=1.99.0
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NARCH}.tar.xz" | tar -xJ -C /usr/local --strip-components=1 \
    && npm install -g --silent "pnpm@${PNPM_VERSION}"
RUN useradd -m -s /bin/bash kbuild
USER kbuild
WORKDIR /home/kbuild
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --profile minimal --default-toolchain "${RUST_VERSION}"
ENV PATH=/home/kbuild/.cargo/bin:$PATH
# rpmlint's spell checker (a missing checker produces a warning that the lint step refuses)
USER root
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends python3-enchant hunspell-en-us >/dev/null \
    && rm -rf /var/lib/apt/lists/*
USER kbuild
