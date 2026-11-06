# syntax=docker/dockerfile:1
FROM docker.io/library/archlinux:base-devel AS build

# Arch packages supply the toolchain and headers, never the host installation.
RUN pacman -Syu --noconfirm --needed \
      git nodejs npm rust clang llvm pkgconf \
      webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg libpcap libelf \
    && pacman -Scc --noconfirm \
    && useradd --create-home --uid 1000 builder \
    && install -d -o builder -g builder /build /out

COPY package.json /tmp/rustnet-package.json
RUN npm install --global "$(node -p "require('/tmp/rustnet-package.json').packageManager")" --allow-scripts=pnpm \
    && rm /tmp/rustnet-package.json

USER builder
WORKDIR /build/work
ENV HOME=/home/builder \
    CARGO_HOME=/build/cargo \
    CARGO_TARGET_DIR=/build/target \
    CARGO_INCREMENTAL=0 \
    CI=true \
    GIT_TERMINAL_PROMPT=0 \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS=false

COPY --chown=builder:builder . .

# Only dependency fetching has network access. No package lifecycle hooks run here.
RUN setpriv --no-new-privs node scripts/isolated-phase.mjs fetch release

# Reuse the isolated workflow's offline install, tests, linting and embedded build.
ENV CARGO_NET_OFFLINE=true
RUN --network=none setpriv --no-new-privs node scripts/isolated-phase.mjs build release \
    && install -m 0755 /build/target/release/rustnet-desktop /out/rustnet-desktop \
    && install -m 0755 /build/target/release/rustnet-capture-engine /out/rustnet-capture-engine

# Export image only. Copy both files out; runtime libraries belong to the host.
FROM scratch AS artifacts
COPY --from=build /out/ /out/
CMD ["/out/rustnet-desktop"]
