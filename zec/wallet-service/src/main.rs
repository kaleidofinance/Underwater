//! zec-wallet: the Underwater ZEC treasury wallet service.
//!
//! Env: WALLET_API_TOKEN (required, >= 32 chars), ZEC_NETWORK (test|main,
//! default test; main also needs ALLOW_MAINNET=1), LIGHTWALLETD_URL,
//! WALLET_DIR (default /data, a persistent volume), SYNC_INTERVAL_SECS, PORT.

mod api;
mod backup;
mod cache;
mod wallet;

use std::{net::SocketAddr, sync::Arc};

use anyhow::Result;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    // Before any TLS: lightwalletd is reached over rustls.
    if rustls::crypto::ring::default_provider().install_default().is_err() {
        warn!("a rustls crypto provider was already installed");
    }

    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    let wallet = Arc::new(runtime.block_on(wallet::Wallet::open(wallet::Config::from_env()?))?);

    // Sync gets its own thread and runtime: a long catch-up never ties up the
    // API's workers, and `sync::run`'s future doesn't have to be Send.
    let syncer = wallet.clone();
    std::thread::Builder::new().name("sync".into()).spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("sync runtime");
        rt.block_on(async move {
            let mut last = 0;
            loop {
                match syncer.sync_once().await {
                    Ok(()) => {
                        let scanned = syncer.tip().await.unwrap_or(0);
                        if scanned != last {
                            info!(scanned, "synced");
                            last = scanned;
                        }
                    }
                    Err(e) => warn!("sync failed: {e:#}"),
                }
                tokio::time::sleep(syncer.cfg.sync_interval).await;
            }
        });
    })?;

    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    runtime.block_on(async move {
        // [::] also accepts IPv4 on Linux, and Railway's private network is IPv6.
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([0u16; 8], port))).await?;
        info!(port, "listening");
        axum::serve(listener, api::router(wallet)).await?;
        Ok(())
    })
}
