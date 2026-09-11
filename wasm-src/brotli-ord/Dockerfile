# rust:1.90-bookworm (pinned by digest) is the image the regtest ord-stock container is built
# with (e2e/docker-compose.regtest.yml), so the toolchain is pinned.
FROM rust:1.90-bookworm@sha256:3914072ca0c3b8aad871db9169a651ccfce30cf58303e5d6f2db16d1d8a7e58f
RUN rustup target add wasm32-unknown-unknown
WORKDIR /src
COPY . .
ARG LOCKED=--locked
RUN cargo build --release $LOCKED --target wasm32-unknown-unknown
