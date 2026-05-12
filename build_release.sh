#!/bin/bash
set -euo pipefail

# Build VM-compatible wasm for Injective: nightly + build-std + target-cpu=mvp
# strips bulk-memory ops that Injective's cosmwasm-vm rejects. Required while
# cw-std 3.x deps force rustc >= 1.85 (which would otherwise emit bulk-memory
# in the precompiled std).
#
# Requires: nightly toolchain with `rust-src`.
#   rustup toolchain install nightly --component rust-src

mkdir -p artifacts

RUSTFLAGS="-C link-arg=-s -C target-cpu=mvp -C target-feature=-bulk-memory,-multivalue,-reference-types,-sign-ext" \
  cargo +nightly build \
    --release \
    --target wasm32-unknown-unknown \
    --lib \
    -p choice-token-locker \
    -Z build-std=std,panic_abort \
    -Z build-std-features=panic_immediate_abort

cp target/wasm32-unknown-unknown/release/choice_token_locker.wasm artifacts/

# Print checksum
(cd artifacts && sha256sum -- *.wasm | tee checksums.txt)
