//! HTTP API, one route per `ZcashWallet` method (zec/rails/wallet.ts).
//! Amounts are decimal strings: zatoshi can exceed what a JSON number holds
//! exactly. Everything except `/health` needs `Authorization: Bearer <WALLET_API_TOKEN>`.

use std::sync::Arc;

use axum::{
    extract::{Path, Query, Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use zcash_protocol::consensus::Network;

use crate::wallet::{parse_txid, IncomingNote, TxStatus, Wallet};

pub struct ApiError(anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        Self(e.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({ "error": format!("{:#}", self.0) }))).into_response()
    }
}

type ApiResult<T> = Result<Json<T>, ApiError>;

pub fn router(wallet: Arc<Wallet>) -> Router {
    let private = Router::new()
        .route("/tip", get(tip))
        .route("/address/{index}", get(address))
        .route("/incoming", get(incoming))
        .route("/spendable", get(spendable))
        .route("/validate", post(validate))
        .route("/prepare", post(prepare))
        .route("/broadcast", post(broadcast))
        .route("/status/{txid}", get(status))
        .route_layer(middleware::from_fn_with_state(wallet.clone(), auth));
    Router::new().route("/health", get(health)).merge(private).with_state(wallet)
}

async fn auth(State(wallet): State<Arc<Wallet>>, req: Request, next: Next) -> Response {
    let presented = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    match presented {
        Some(token) if constant_time_eq(token.as_bytes(), wallet.cfg.api_token.as_bytes()) => next.run(req).await,
        _ => (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response(),
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn network_name(n: Network) -> &'static str {
    match n {
        Network::MainNetwork => "main",
        Network::TestNetwork => "test",
    }
}

async fn health(State(w): State<Arc<Wallet>>) -> ApiResult<Value> {
    Ok(Json(json!({ "ok": true, "network": network_name(w.cfg.network), "scanned": w.tip().await? })))
}

async fn tip(State(w): State<Arc<Wallet>>) -> ApiResult<Value> {
    Ok(Json(json!({ "height": w.tip().await? })))
}

async fn address(State(w): State<Arc<Wallet>>, Path(index): Path<u32>) -> ApiResult<Value> {
    Ok(Json(json!({ "index": index, "address": w.address_at(index).await? })))
}

#[derive(Deserialize)]
struct FromHeight {
    from: u32,
}

async fn incoming(State(w): State<Arc<Wallet>>, Query(q): Query<FromHeight>) -> ApiResult<Vec<IncomingNote>> {
    Ok(Json(w.incoming(q.from).await?))
}

async fn spendable(State(w): State<Arc<Wallet>>) -> ApiResult<Value> {
    Ok(Json(json!({ "zats": w.spendable().await?.to_string() })))
}

#[derive(Deserialize)]
struct AddressBody {
    address: String,
}

async fn validate(State(w): State<Arc<Wallet>>, Json(body): Json<AddressBody>) -> ApiResult<Value> {
    Ok(Json(json!({ "valid": w.validate(&body.address) })))
}

#[derive(Deserialize)]
struct OutputBody {
    address: String,
    amount: String,
}

#[derive(Deserialize)]
struct PrepareBody {
    outputs: Vec<OutputBody>,
}

async fn prepare(State(w): State<Arc<Wallet>>, Json(body): Json<PrepareBody>) -> ApiResult<Value> {
    let outputs = body
        .outputs
        .into_iter()
        .map(|o| Ok((o.address, o.amount.parse::<u64>()?)))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let (txid, fee) = w.prepare(&outputs).await?;
    Ok(Json(json!({ "txid": txid.to_string(), "fee": fee.to_string() })))
}

#[derive(Deserialize)]
struct TxidBody {
    txid: String,
}

async fn broadcast(State(w): State<Arc<Wallet>>, Json(body): Json<TxidBody>) -> ApiResult<Value> {
    w.broadcast(parse_txid(&body.txid)?).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn status(State(w): State<Arc<Wallet>>, Path(txid): Path<String>) -> ApiResult<TxStatus> {
    Ok(Json(w.status(parse_txid(&txid)?).await?))
}
