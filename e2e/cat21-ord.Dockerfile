# Builds the cat21-ord binary from `../../cat21-ord/` using a current
# Rust toolchain (1.90+; ord@0.27 + redb@3.1 require >= 1.89).
#
# The cat21-ord repo's own Dockerfile pins rust:1.85.0-bookworm, which
# is correct for the production image used on happysrv but trails the
# crate ecosystem's MSRV (the cat21-ord HARD RULE says to minimise
# changes against upstream ord, including the Dockerfile). We override
# the toolchain here so the regtest stack builds against the current
# Cargo.lock without touching cat21-ord.

FROM rust:1.90-bookworm AS builder

WORKDIR /usr/src/ord

COPY . .

RUN cargo build --bin ord --release

FROM debian:bookworm-slim

COPY --from=builder /usr/src/ord/target/release/ord /usr/local/bin
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

ENV RUST_BACKTRACE=1
ENV RUST_LOG=info
