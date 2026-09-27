# Built on Railway: there is no local Rust toolchain. cargo-chef caches the
# dependency build (librustzcash, Halo 2, tonic) in its own layer, so a change
# to src/ recompiles only this crate.
FROM rust:1-bookworm AS chef
RUN cargo install cargo-chef --locked
WORKDIR /app

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/zec-wallet /usr/local/bin/zec-wallet
ENV WALLET_DIR=/data
CMD ["zec-wallet"]
