//! The treasury wallet: two librustzcash accounts over lightwalletd, exposed
//! as exactly the operations `ZcashWallet` in zec/rails/wallet.ts needs.
//!
//! - **treasury** (ZIP-32 account 0) owns every user's deposit address:
//!   Orchard-only unified addresses at explicit diversifier indices, so the
//!   engine's dense index -> user mapping is the wallet's own. Its viewing
//!   key stays private, because it would link deposits to addresses.
//! - **reserve** (account 1) holds the funds. Deposits are swept into it, and
//!   withdrawals are paid from it. Its full viewing key is *published*: anyone
//!   can load it into a Zcash wallet and watch the reserve balance, which is
//!   the on-chain half of proof of solvency. Withdrawals discard their
//!   outgoing viewing data, so the public key reveals no destinations.
//!   The hash-chain anchors are memos on this account, readable by that key.
//!
//! Every account lookup goes by name, never by position: once two accounts
//! share diversifier index 0, an unscoped query would mix them.
//!
//! The seed is generated inside this service on first start, kept on the
//! volume, and never logged or returned by any endpoint.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    str::FromStr,
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use rand::{rngs::OsRng, RngCore};
use secrecy::{ExposeSecret, SecretVec};
use serde::Serialize;
use tokio::sync::Mutex;
use tonic::transport::{Channel, ClientTlsConfig};
use tracing::{info, warn};
use zcash_address::ZcashAddress;
use zcash_client_backend::{
    data_api::{
        wallet::{
            create_proposed_transactions,
            input_selection::{GreedyInputSelector, LockedInputPolicy, SpendPolicy},
            propose_send_max_transfer, propose_transfer, ConfirmationsPolicy, SpendingKeys,
        },
        AccountBirthday, MaxSpendMode, WalletCommitmentTrees, WalletRead, WalletWrite,
    },
    fees::{standard::MultiOutputChangeStrategy, DustOutputPolicy, SplitPolicy, StandardFeeRule},
    proto::service::{self, compact_tx_streamer_client::CompactTxStreamerClient},
    wallet::OvkPolicy,
};
use zcash_client_sqlite::{util::SystemClock, wallet::init::init_wallet_db, AccountUuid, WalletDb};
use zcash_keys::{
    address::Address,
    keys::{UnifiedAddressRequest, UnifiedSpendingKey},
};
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::{
    consensus::Network,
    memo::{Memo, MemoBytes},
    value::Zatoshis,
    ShieldedPool, TxId,
};
use zip32::DiversifierIndex;
use zip321::{Payment, TransactionRequest};

use crate::cache::MemoryBlockCache;

pub type Db = WalletDb<rusqlite::Connection, Network, SystemClock, OsRng>;

const TREASURY: &str = "treasury";
const RESERVE: &str = "reserve";
/// What an anchor pays to the reserve's own address. It comes straight back; only the fee is spent.
const ANCHOR_ZATS: u64 = 10_000;

pub struct Config {
    pub network: Network,
    pub lightwalletd: String,
    pub dir: PathBuf,
    pub api_token: String,
    pub sync_interval: Duration,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let network = match std::env::var("ZEC_NETWORK").unwrap_or_else(|_| "test".into()).as_str() {
            "test" => Network::TestNetwork,
            "main" if std::env::var("ALLOW_MAINNET").as_deref() == Ok("1") => Network::MainNetwork,
            "main" => bail!("ZEC_NETWORK=main also needs ALLOW_MAINNET=1: this is a hot wallet"),
            other => bail!("ZEC_NETWORK must be \"test\" or \"main\", got {other:?}"),
        };
        let api_token = std::env::var("WALLET_API_TOKEN").context("WALLET_API_TOKEN is required")?;
        if api_token.len() < 32 {
            bail!("WALLET_API_TOKEN must be at least 32 characters");
        }
        Ok(Self {
            network,
            lightwalletd: std::env::var("LIGHTWALLETD_URL").unwrap_or_else(|_| "https://testnet.zec.rocks:443".into()),
            dir: PathBuf::from(std::env::var("WALLET_DIR").unwrap_or_else(|_| "/data".into())),
            api_token,
            sync_interval: Duration::from_secs(
                std::env::var("SYNC_INTERVAL_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(15),
            ),
        })
    }
}

#[derive(Serialize)]
pub struct IncomingNote {
    pub id: String,
    pub txid: String,
    #[serde(rename = "addressIndex")]
    pub address_index: i64,
    /// Zatoshi, as a decimal string.
    pub amount: String,
    pub height: u32,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum TxStatus {
    Mined { height: u32 },
    Mempool,
    Expired,
    Unknown,
}

#[derive(Serialize)]
pub struct AccountTotals {
    /// Everything the account holds, including change and notes still confirming. Decimal string.
    pub total: String,
    /// What can be spent right now. Decimal string.
    pub spendable: String,
}

#[derive(Serialize)]
pub struct Balances {
    pub treasury: AccountTotals,
    pub reserve: AccountTotals,
}

#[derive(Serialize)]
pub struct ReserveInfo {
    /// The reserve's unified full viewing key. Public by design.
    pub ufvk: String,
    pub address: String,
    pub birthday: u32,
}

#[derive(Clone, Copy)]
struct Acct {
    id: AccountUuid,
    /// ZIP-32 account index, for deriving its spending key from the seed.
    index: u32,
}

pub struct Wallet {
    pub cfg: Config,
    db: Mutex<Db>,
    db_path: PathBuf,
    treasury: Acct,
    reserve: Acct,
    seed: SecretVec<u8>,
    cache: MemoryBlockCache,
    /// Transactions this process has handed to lightwalletd. Lost on restart,
    /// which is fine: an unknown status makes the rails rebroadcast, and
    /// rebroadcasting the same transaction is harmless.
    broadcast: Mutex<HashSet<TxId>>,
}

impl Wallet {
    pub async fn open(cfg: Config) -> Result<Self> {
        std::fs::create_dir_all(&cfg.dir).with_context(|| format!("creating {}", cfg.dir.display()))?;
        let seed = load_or_create_seed(&cfg.dir.join("seed.bin"))?;
        let db_path = cfg.dir.join("wallet.sqlite");

        let mut db = Db::for_path(&db_path, cfg.network, SystemClock, OsRng)?;
        init_wallet_db(&mut db, Some(SecretVec::new(seed.expose_secret().clone())))
            .map_err(|e| anyhow!("wallet db migration failed: {e:?}"))?;

        let ensure =|name: &'static str| -> Result<Option<Acct>> { account_by_name(&db_path, name) };
        if ensure(TREASURY)?.is_none() {
            let birthday = fresh_birthday(&cfg).await?;
            db.create_account(TREASURY, &seed, &birthday, None)?;
            info!(birthday = u32::from(birthday.height()), "created treasury account");
        }
        if ensure(RESERVE)?.is_none() {
            let birthday = fresh_birthday(&cfg).await?;
            db.create_account(RESERVE, &seed, &birthday, None)?;
            info!(birthday = u32::from(birthday.height()), "created reserve account");
        }
        let treasury = ensure(TREASURY)?.ok_or_else(|| anyhow!("treasury account missing after creation"))?;
        let reserve = ensure(RESERVE)?.ok_or_else(|| anyhow!("reserve account missing after creation"))?;
        if treasury.index == reserve.index {
            bail!("treasury and reserve share ZIP-32 account index {}", treasury.index);
        }

        Ok(Self {
            cfg,
            db: Mutex::new(db),
            db_path,
            treasury,
            reserve,
            seed,
            cache: MemoryBlockCache::default(),
            broadcast: Mutex::new(HashSet::new()),
        })
    }

    /// Sync from lightwalletd until caught up. `sync::run` also handles reorgs:
    /// it rewinds the wallet, which drops orphaned notes, and the rails see
    /// them vanish from `incoming`.
    pub async fn sync_once(&self) -> Result<()> {
        let mut client = connect(&self.cfg.lightwalletd).await?;
        let mut db = self.db.lock().await;
        zcash_client_backend::sync::run(&mut client, &self.cfg.network, &self.cache, &mut *db, 1_000)
            .await
            .map_err(|e| anyhow!("sync: {e:?}"))?;
        Ok(())
    }

    /// Highest block every note is known for. The rails count confirmations
    /// from this, so a note is never judged against blocks not yet scanned.
    pub async fn tip(&self) -> Result<u32> {
        let db = self.db.lock().await;
        Ok(db.block_fully_scanned()?.map(|m| u32::from(m.block_height())).unwrap_or(0))
    }

    /// The Orchard-only deposit address at `index` of the treasury. Idempotent.
    pub async fn address_at(&self, index: u32) -> Result<String> {
        self.address_of(TREASURY, self.treasury, index).await
    }

    async fn address_of(&self, name: &str, acct: Acct, index: u32) -> Result<String> {
        if let Some(existing) = self.stored_address(name, index)? {
            return Ok(existing);
        }
        let mut db = self.db.lock().await;
        let ua = db
            .get_address_for_index(acct.id, DiversifierIndex::from(index), UnifiedAddressRequest::ORCHARD)?
            .ok_or_else(|| anyhow!("no Orchard address at diversifier index {index}"))?;
        Ok(ua.encode(&self.cfg.network))
    }

    /// Non-change notes received by the **treasury** at `from` or later, up
    /// to the fully scanned height, across every shielded pool. Reserve notes
    /// (sweeps, anchors, change) are never deposits and never appear here.
    pub async fn incoming(&self, from: u32) -> Result<Vec<IncomingNote>> {
        let to = self.tip().await?;
        let conn = self.read_conn()?;
        let mut parts = Vec::new();
        for (table, pool, index_col) in [
            ("orchard_received_notes", "orchard", "action_index"),
            ("ironwood_received_notes", "ironwood", "action_index"),
            ("sapling_received_notes", "sapling", "output_index"),
        ] {
            if table_exists(&conn, table)? {
                parts.push(format!(
                    "SELECT t.txid, n.{index_col}, '{pool}', n.value, t.mined_height, a.diversifier_index_be \
                     FROM {table} n \
                     JOIN transactions t ON t.id_tx = n.transaction_id \
                     JOIN accounts acc ON acc.id = n.account_id \
                     LEFT JOIN addresses a ON a.id = n.address_id \
                     WHERE acc.name = '{TREASURY}' AND n.is_change = 0 AND t.mined_height IS NOT NULL \
                       AND t.mined_height >= ?1 AND t.mined_height <= ?2"
                ));
            }
        }
        if parts.is_empty() {
            return Ok(vec![]);
        }
        let sql = format!("{} ORDER BY 5, 1, 2", parts.join(" UNION ALL "));
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params![from, to], |row| {
            let txid: Vec<u8> = row.get(0)?;
            let output: i64 = row.get(1)?;
            let pool: String = row.get(2)?;
            let value: i64 = row.get(3)?;
            let height: u32 = row.get(4)?;
            let div: Option<Vec<u8>> = row.get(5)?;
            Ok((txid, output, pool, value, height, div))
        })?;
        let mut notes = Vec::new();
        for row in rows {
            let (txid, output, pool, value, height, div) = row?;
            let txid = display_txid(&txid)?;
            notes.push(IncomingNote {
                id: format!("{txid}:{pool}:{output}"),
                txid,
                address_index: div.as_deref().and_then(index_from_be).map_or(-1, i64::from),
                amount: value.to_string(),
                height,
            });
        }
        Ok(notes)
    }

    /// What the reserve can pay out right now: the funds withdrawals draw on.
    pub async fn spendable(&self) -> Result<u64> {
        let b = self.balances().await?;
        Ok(b.reserve.spendable.parse()?)
    }

    pub async fn balances(&self) -> Result<Balances> {
        let db = self.db.lock().await;
        let summary = db.get_wallet_summary(ConfirmationsPolicy::default())?;
        let of = |a: Acct| -> AccountTotals {
            let bal = summary.as_ref().and_then(|s| s.account_balances().get(&a.id));
            AccountTotals {
                total: bal.map_or(0, |b| b.total().into_u64()).to_string(),
                spendable: bal.map_or(0, |b| b.spendable_value().into_u64()).to_string(),
            }
        };
        Ok(Balances { treasury: of(self.treasury), reserve: of(self.reserve) })
    }

    pub async fn reserve_info(&self) -> Result<ReserveInfo> {
        let address = self.address_of(RESERVE, self.reserve, 0).await?;
        let db = self.db.lock().await;
        let ufvk = db
            .get_unified_full_viewing_keys()?
            .get(&self.reserve.id)
            .ok_or_else(|| anyhow!("no viewing key for the reserve"))?
            .encode(&self.cfg.network);
        let birthday = u32::from(db.get_account_birthday(self.reserve.id)?);
        Ok(ReserveInfo { ufvk, address, birthday })
    }

    pub fn validate(&self, address: &str) -> bool {
        Address::decode(&self.cfg.network, address).is_some()
    }

    /// Build, prove and sign one transaction from the reserve paying every
    /// output, and store it in the wallet. Nothing is broadcast. Outgoing
    /// viewing data is discarded, so the public reserve key can see that
    /// value left but not where to.
    pub async fn prepare(&self, outputs: &[(String, u64)]) -> Result<(TxId, u64)> {
        if outputs.is_empty() {
            bail!("no outputs");
        }
        let payments = outputs
            .iter()
            .map(|(address, amount)| {
                let to = ZcashAddress::from_str(address).map_err(|e| anyhow!("bad address {address}: {e:?}"))?;
                let value = Zatoshis::from_u64(*amount).map_err(|e| anyhow!("bad amount {amount}: {e:?}"))?;
                Ok(Payment::without_memo(to, value))
            })
            .collect::<Result<Vec<_>>>()?;
        let request = TransactionRequest::new(payments).map_err(|e| anyhow!("bad request: {e:?}"))?;
        self.pay_from_reserve(request, OvkPolicy::Discard).await
    }

    /// Anchor a hash-chain head: a small self-payment on the reserve carrying
    /// `memo`, readable by anyone holding the published reserve viewing key.
    pub async fn anchor(&self, memo: &str) -> Result<(TxId, u64)> {
        let to = ZcashAddress::from_str(&self.address_of(RESERVE, self.reserve, 0).await?)
            .map_err(|e| anyhow!("reserve address: {e:?}"))?;
        let memo = MemoBytes::from(Memo::from_str(memo).map_err(|e| anyhow!("memo: {e:?}"))?);
        let payment = Payment::new(to, Some(Zatoshis::from_u64(ANCHOR_ZATS).expect("valid")), Some(memo), None, None, vec![])
            .map_err(|e| anyhow!("anchor payment: {e:?}"))?;
        let request = TransactionRequest::new(vec![payment]).map_err(|e| anyhow!("bad request: {e:?}"))?;
        self.pay_from_reserve(request, OvkPolicy::Sender).await
    }

    /// Move everything the treasury can spend into the reserve. `None` when
    /// there's nothing spendable yet.
    pub async fn sweep(&self) -> Result<Option<(TxId, u64)>> {
        let to = ZcashAddress::from_str(&self.address_of(RESERVE, self.reserve, 0).await?)
            .map_err(|e| anyhow!("reserve address: {e:?}"))?;
        let mut db = self.db.lock().await;
        let proposal = match propose_send_max_transfer::<_, _, _, <Db as WalletCommitmentTrees>::Error>(
            &mut *db,
            &self.cfg.network,
            self.treasury.id,
            &[ShieldedPool::Orchard, ShieldedPool::Ironwood, ShieldedPool::Sapling],
            &StandardFeeRule::Zip317,
            to,
            None,
            MaxSpendMode::MaxSpendable,
            ConfirmationsPolicy::default(),
            &LockedInputPolicy::Exclude,
            None,
        ) {
            Ok(p) => p,
            // Nothing confirmed enough to move yet is the normal case, not an error.
            Err(e) => {
                let text = format!("{e:?}");
                if text.contains("InsufficientFunds") || text.contains("NoSpendableNotes") || text.contains("Insufficient") {
                    return Ok(None);
                }
                bail!("sweep proposal failed: {text}");
            }
        };
        let fee: u64 = proposal.steps().iter().map(|s| s.balance().fee_required().into_u64()).sum();
        let usk = self.spending_key(self.treasury)?;
        let txids = create_proposed_transactions::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
            &mut *db,
            &self.cfg.network,
            &LocalTxProver::bundled(),
            &LocalTxProver::bundled(),
            &SpendingKeys::from_unified_spending_key(usk),
            OvkPolicy::Sender,
            &proposal,
            None,
        )
        .map_err(|e| anyhow!("building sweep failed: {e:?}"))?;
        if txids.len() > 1 {
            bail!("the wallet proposed {} sweep transactions; expected one", txids.len());
        }
        Ok(Some((*txids.first(), fee)))
    }

    async fn pay_from_reserve(&self, request: TransactionRequest, ovk: OvkPolicy) -> Result<(TxId, u64)> {
        let prover = LocalTxProver::bundled();
        let change = MultiOutputChangeStrategy::new(
            StandardFeeRule::Zip317,
            None,
            ShieldedPool::Orchard,
            DustOutputPolicy::default(),
            // Keep change spread over a few notes, so back-to-back batches
            // aren't all waiting on one unconfirmed change note.
            SplitPolicy::with_min_output_value(
                std::num::NonZeroUsize::new(4).expect("nonzero"),
                Zatoshis::from_u64(10_000_000).expect("valid"),
            ),
        );
        let selector = GreedyInputSelector::new();

        let mut db = self.db.lock().await;
        // The commitment-tree error type can't be inferred from the call alone.
        let proposal = propose_transfer::<_, _, _, _, <Db as WalletCommitmentTrees>::Error>(
            &mut *db,
            &self.cfg.network,
            self.reserve.id,
            &selector,
            &change,
            request,
            ConfirmationsPolicy::default(),
            &SpendPolicy::default(),
            None,
            None,
        )
        .map_err(|e| anyhow!("proposal failed: {e:?}"))?;
        let fee: u64 = proposal.steps().iter().map(|s| s.balance().fee_required().into_u64()).sum();

        let usk = self.spending_key(self.reserve)?;
        // The input-selection and change error types can't arise here (selection
        // already happened in the proposal), so pin them to Infallible.
        let txids = create_proposed_transactions::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
            &mut *db,
            &self.cfg.network,
            &prover,
            &prover,
            &SpendingKeys::from_unified_spending_key(usk),
            ovk,
            &proposal,
            None,
        )
        .map_err(|e| anyhow!("building transaction failed: {e:?}"))?;
        if txids.len() > 1 {
            bail!("the wallet proposed {} transactions; batches must be one", txids.len());
        }
        Ok((*txids.first(), fee))
    }

    fn spending_key(&self, acct: Acct) -> Result<UnifiedSpendingKey> {
        let index = zip32::AccountId::try_from(acct.index).map_err(|e| anyhow!("account index: {e:?}"))?;
        UnifiedSpendingKey::from_seed(&self.cfg.network, self.seed.expose_secret(), index)
            .map_err(|e| anyhow!("spending key: {e:?}"))
    }

    /// Send a stored transaction. Resending one the network already has is not an error.
    pub async fn broadcast(&self, txid: TxId) -> Result<()> {
        let data = {
            let db = self.db.lock().await;
            let tx = db.get_transaction(txid)?.ok_or_else(|| anyhow!("unknown transaction {txid}"))?;
            let mut data = Vec::new();
            tx.write(&mut data)?;
            data
        };
        let mut client = connect(&self.cfg.lightwalletd).await?;
        let response = client.send_transaction(service::RawTransaction { data, height: 0 }).await?.into_inner();
        if response.error_code != 0 && !is_already_known(&response.error_message) {
            bail!("rejected ({}): {}", response.error_code, response.error_message);
        }
        self.broadcast.lock().await.insert(txid);
        Ok(())
    }

    /// Mined, pending, or expired. "Expired" is only claimed once every block
    /// up to the expiry height has been scanned without the transaction in
    /// it, because the rails refund on it, and a premature refund is a double
    /// payment.
    pub async fn status(&self, txid: TxId) -> Result<TxStatus> {
        let (mined, expiry, scanned) = {
            let db = self.db.lock().await;
            let mined = db.get_tx_height(txid)?;
            let expiry = db.get_transaction(txid)?.map(|tx| tx.expiry_height());
            let scanned = db.block_fully_scanned()?.map(|m| m.block_height());
            (mined, expiry, scanned)
        };
        if let Some(height) = mined {
            return Ok(TxStatus::Mined { height: u32::from(height) });
        }
        let sent = self.broadcast.lock().await.contains(&txid);
        match (expiry, scanned) {
            (Some(e), Some(s)) if u32::from(e) != 0 && s >= e => Ok(TxStatus::Expired),
            (Some(_), _) if sent => Ok(TxStatus::Mempool),
            _ => Ok(TxStatus::Unknown),
        }
    }

    fn stored_address(&self, account: &str, index: u32) -> Result<Option<String>> {
        let conn = self.read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT a.address FROM addresses a JOIN accounts acc ON acc.id = a.account_id \
             WHERE acc.name = ?1 AND a.key_scope = 0 AND a.diversifier_index_be = ?2",
        )?;
        let mut rows = stmt.query(rusqlite::params![account, index_to_be(index)])?;
        Ok(match rows.next()? {
            Some(row) => Some(row.get(0)?),
            None => None,
        })
    }

    fn read_conn(&self) -> Result<rusqlite::Connection> {
        open_read(&self.db_path)
    }
}

fn open_read(path: &Path) -> Result<rusqlite::Connection> {
    Ok(rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?)
}

fn account_by_name(db_path: &Path, name: &str) -> Result<Option<Acct>> {
    let conn = open_read(db_path)?;
    let mut stmt = conn.prepare("SELECT uuid, hd_account_index FROM accounts WHERE name = ?1")?;
    let mut rows = stmt.query(rusqlite::params![name])?;
    let Some(row) = rows.next()? else { return Ok(None) };
    let uuid: Vec<u8> = row.get(0)?;
    let index: Option<u32> = row.get(1)?;
    let id = AccountUuid::from_uuid(uuid::Uuid::from_slice(&uuid).map_err(|e| anyhow!("account uuid: {e}"))?);
    Ok(Some(Acct { id, index: index.ok_or_else(|| anyhow!("{name} is not an HD account"))? }))
}

async fn fresh_birthday(cfg: &Config) -> Result<AccountBirthday> {
    let mut client = connect(&cfg.lightwalletd).await?;
    let tip = client.get_latest_block(service::ChainSpec::default()).await?.into_inner().height;
    // A new account has nothing before now. A little slack costs nothing.
    let height = tip.saturating_sub(20);
    let treestate = client
        .get_tree_state(service::BlockId { height: height - 1, ..Default::default() })
        .await?
        .into_inner();
    AccountBirthday::from_treestate(treestate, None).map_err(|e| anyhow!("bad birthday tree state: {e:?}"))
}

pub async fn connect(url: &str) -> Result<CompactTxStreamerClient<Channel>> {
    let uri: tonic::transport::Uri = url.parse().with_context(|| format!("bad lightwalletd url {url}"))?;
    let mut endpoint = Channel::from_shared(url.to_string())?.connect_timeout(Duration::from_secs(20));
    if uri.scheme_str() == Some("https") {
        let host = uri.host().ok_or_else(|| anyhow!("no host in {url}"))?.to_string();
        endpoint = endpoint.tls_config(ClientTlsConfig::new().domain_name(host).assume_http2(true).with_webpki_roots())?;
    }
    Ok(CompactTxStreamerClient::new(endpoint.connect().await?))
}

fn load_or_create_seed(path: &Path) -> Result<SecretVec<u8>> {
    if path.exists() {
        let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        if bytes.len() != 32 {
            bail!("{} is not a 32-byte seed", path.display());
        }
        return Ok(SecretVec::new(bytes));
    }
    let mut bytes = vec![0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    std::fs::write(path, &bytes).with_context(|| format!("writing {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    warn!("generated a new treasury seed at {} (not logged; back up the volume)", path.display());
    Ok(SecretVec::new(bytes))
}

fn table_exists(conn: &rusqlite::Connection, table: &str) -> Result<bool> {
    Ok(conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1")?
        .exists(rusqlite::params![table])?)
}

/// The wallet stores diversifier indices as 11-byte big-endian blobs.
fn index_to_be(index: u32) -> Vec<u8> {
    let mut be = vec![0u8; 7];
    be.extend_from_slice(&index.to_be_bytes());
    be
}

fn index_from_be(be: &[u8]) -> Option<u32> {
    if be.len() != 11 || be[..7].iter().any(|b| *b != 0) {
        return None;
    }
    Some(u32::from_be_bytes([be[7], be[8], be[9], be[10]]))
}

/// txids are stored in internal byte order; people and explorers use the reverse.
fn display_txid(internal: &[u8]) -> Result<String> {
    if internal.len() != 32 {
        bail!("txid is {} bytes", internal.len());
    }
    let mut bytes = internal.to_vec();
    bytes.reverse();
    Ok(hex::encode(bytes))
}

pub fn parse_txid(display: &str) -> Result<TxId> {
    let mut bytes: [u8; 32] = hex::decode(display)?
        .try_into()
        .map_err(|_| anyhow!("a txid is 32 bytes of hex"))?;
    bytes.reverse();
    Ok(TxId::from_bytes(bytes))
}

fn is_already_known(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("already") || m.contains("txn-already-known") || m.contains("txn-already-in-mempool")
}
