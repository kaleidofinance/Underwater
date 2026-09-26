# Underwater ZEC — launchpad spec

**Status:** ⚠️ **Core design superseded by [underwater-zec-v2.md](underwater-zec-v2.md)** (instant trading on an internal engine). Kept for the ZRC-20 reference (§1–2), issuance-via-transfer (§7), the wallet findings (§12), and the call auction as an optional "fair launch" mode.
**Written:** 2026-09-22.

---

## 1. What is actually on Zcash right now

Zcash has no VM, no contracts, no atomic settlement, and 75-second blocks. Everything token-shaped there is an inscription: JSON interpreted by an off-chain indexer, with consensus never learning a token exists.

**There are two incompatible things both calling themselves `zrc-20`.** This is the single most important finding and it has to be decided before a line of code.

| | **Zerdinals** (live) | **docs.zrc20.io** (draft) |
|---|---|---|
| Carrier | Transparent, Ordinals-style | **Shielded memo** (Sapling/Orchard, 512 B) |
| Ownership | UTXO — owner is a `t1…` address | Ed25519 `acct` + `sig` + nonce, in-payload |
| ID | `<txid>i0`, `LOCATION <txid>:0`, `OFFSET` | No inscription identity; pure balance sheet |
| Since | Nov 13 2025 (block 3,133,112) | Published **Sep 21 2026** — one day old |
| Traction | **149 tickers**, 113k+ inscriptions, live marketplace | Spec only |

Verified live Zerdinals inscription:

```json
{ "p": "zrc-20", "op": "transfer", "tick": "ZECS", "amt": "4000" }
```

Owner: `t1g3FPpgo1SJVhytCkkoGLSjiQ2kDv9iSXA` — **a transparent address.**

So: everything with actual liquidity today is transparent, despite the ecosystem's privacy marketing. The eight NFT projects, zkSNARKs' $17.5M included, all sit on t-addrs. The draft spec is the first design that puts the carrier in the shielded pool — and it is honest that this does not make tokens private by itself (§4).

Note that Zerdinals' ops carry no `acct`/`sig`/`n`. An indexer written to the draft spec treats every live Zerdinals op as **inert**. These standards cannot be merged. The draft's own "open questions" flags a name collision with ZetaChain and Zilliqa but misses the nearer one: itself.

**Decision: build on the shielded-memo standard (docs.zrc20.io).** It is a better design, it hands us the Ed25519 account layer we need for signed bids anyway, and the privacy claim is defensible instead of decorative. We give up interop with the 149 existing tickers. They are memecoins; that liquidity is not worth inheriting a transparent ownership model that kills the only differentiator we have.

---

## 2. Base layer: ZRC-20 as adopted

Three ops, BRC-20 shaped. Payload is compact JSON in the 512-byte memo of a shielded output, ZIP-302 text (first byte `0x7B`), so any wallet that sends a text memo can write one.

**deploy** — claims a ticker, fixes issuance. No signature; first valid deploy wins.

```json
{"p":"zrc-20","op":"deploy","tick":"zrc","max":"21000000","lim":"1000","dec":"8"}
```

`tick` 1–8 bytes (NFC-normalised, lowercased) · `max` > 0 · `lim` defaults to `max` · `dec` 0–18, default 18 · `start` optional opening height.

**mint** — issues against a ticker, ≤ `lim` per op, partial-fills at the tail.

```json
{"p":"zrc-20","op":"mint","tick":"zrc","amt":"1000","acct":"zrc1q9k…","n":"0","pk":"Gv7…","sig":"3nQ…"}
```

**transfer** — one op, no inscribe-then-send dance.

```json
{"p":"zrc-20","op":"transfer","tick":"zrc","amt":"500","acct":"zrc1q9k…","to":"zrc1m4x…","n":"7","sig":"9Lp…"}
```

Authorization, because a shielded sender is unlinkable and the transaction tells an indexer nothing: identity is `acct` (Bech32m of a 20-byte hash of an Ed25519 pubkey), every mint/transfer carries `sig` over canonical JSON (keys sorted lexicographically, compact, `sig` removed), plus nonce `n` starting at 0. `pk` on first use binds key to account.

Ordering is `(height, tx index, shielded output index)`, Sapling outputs before Orchard within a transaction. Amounts are decimal strings, never JSON numbers. Unknown fields ignored; unknown `op` inert; duplicate keys inert.

---

## 3. Why a call auction, not a bonding curve

A continuous curve needs atomic settlement. Zcash has none — no contracts, no reverts, and a buy that races another buy cannot fail safely, it just loses the money.

**Use a periodic uniform-price call auction.** Each epoch collects bids, then clears every winner at one price taken off the supply curve. This is not a workaround; on this chain it is strictly better:

- Ordering stops mattering → no MEV, no sniping, no first-block advantage
- No failed buys, so nothing is unrecoverable on a chain that cannot revert
- It is the mechanic that just cleared $17.5M for zkSNARKs — proven in this exact market
- **It is the only structure compatible with shielded bidding**, because clearing needs the bid *set*, never the bid *order*

---

## 4. The core mechanism: value-bound intent

A Zcash shielded output carries **both value and a 512-byte memo**, in one note ciphertext.

So a bid is a single shielded output to the launch's treasury address whose memo *is* the bid. The indexer holds that address's incoming viewing key, decrypts, and sees `{value, intent}` together and inseparably.

This removes the escrow reconciliation problem entirely: **you cannot declare a bid without paying it, and you cannot pay without declaring.** No matching, no orphaned deposits, no "I sent but the UI didn't see it."

### Visibility model

Per-launch treasury address, its own IVK. **Publish that IVK when the epoch closes, not before.**

- **During** the epoch: only we can read bids. The auction is genuinely blind. Users trust our live UI.
- **After** close: anyone syncs the key, replays the epoch, and recomputes the clearing price byte-for-byte. A lie is detectable by anyone, forever.
- **Always hidden:** every bidder's identity, and every other output of their funding transaction. Shielded senders are unlinkable, and that does not change when the key is published.

What is public after close: amounts and the clearing price. What is never public: who. That is a real, checkable claim, and it is the thing no incumbent on Zcash can currently make.

---

## 5. Protocol: `uw-1`

A distinct `p` tag, **not** an extension of `zrc-20`. Plain ZRC-20 indexers see an unrecognised `p` and ignore our ops completely; our indexer runs both reducers. No divergence, no fork.

### launch

Opens a sale. Written by the launchpad account; also performs the `zrc-20` deploy in the same transaction (separate output).

```json
{"p":"uw-1","op":"launch","tick":"abcd","curve":"lin","a":"1000","b":"25",
 "ep":"80","cap":"250000","start":"3492400","acct":"zrc1lp…","n":"12","sig":"…"}
```

`curve` curve id · `a`,`b` curve params in zatoshi · `ep` epoch length in blocks (80 ≈ 100 min) · `cap` max tokens issuable per epoch, optional · `start` first epoch's opening height.

### bid

One shielded output: the ZEC is the payment, the memo is the bid.

```json
{"p":"uw-1","op":"bid","tick":"abcd","e":"142","max":"1500000000","acct":"zrc1q9k…","n":"7","sig":"…"}
```

`e` target epoch (inert if it is not the open one at the carrying output's height) · `max` highest price per token, in zatoshi, the bidder will accept · optional `r` = unified address for ZEC refund; omitted means refund is credited forward (§7).

### ask *(post-graduation, §8)*

```json
{"p":"uw-1","op":"ask","tick":"abcd","e":"310","amt":"5000","min":"1800000000","acct":"zrc1q9k…","n":"9","sig":"…"}
```

Locks `amt` from the seller's ZRC-20 balance for that epoch. **The reducer enforces this escrow directly — the token side is non-custodial.** Only the ZEC side needs trust.

### cancel

Withdraws an unfilled `ask` before its epoch closes. Bids cannot be cancelled; the money is already in the treasury.

### Byte budget (512-byte ceiling)

Worked `bid`, counting literally:

| Component | Bytes |
|---|---|
| `{` … `}` + scaffolding | 2 |
| `"p":"uw-1",` | 11 |
| `"op":"bid",` | 11 |
| `"tick":"abcd",` | 14 |
| `"e":"142",` | 10 |
| `"max":"1500000000",` | 19 |
| `"acct":"<43>",` | 53 |
| `"n":"7",` | 8 |
| `"sig":"<88 b64>"` | 96 |
| **Subtotal** | **224** |
| `+ "pk":"<44 b64>",` first use | +51 |
| `+ "r":"<141 Orchard UA>",` | +147 |

Worst case (first use + refund address) = **422 of 512**. It fits, with 90 bytes of headroom and no room for a second optional field. This is why `r` is optional and credit-carry is the default: at 275 bytes the common path leaves real space to extend the standard later.

---

## 6. Epoch state machine

```
OPEN ──(height ≥ epoch_end)──> SEALED ──(+10 confirmations)──> CLEARED ──> SETTLED
```

- **OPEN** — bids accepted. Live UI shows total pot only, never the book.
- **SEALED** — no further bids for this epoch; the next epoch opens immediately, so there is no gap where a buyer cannot bid.
- **CLEARED** — at `epoch_end + 10` (the draft spec's reorg depth, ~12.5 min at 75 s blocks) the bid set is final. Compute the clearing price, publish the epoch IVK and the state root.
- **SETTLED** — issuance transfers broadcast (§7).

Clearing must never run at chain tip. A reorg that reorders two bids changes who is marginal, and on a 75-second chain reorgs are proportionally more frequent than on Bitcoin. Keep an undo log per block and expose provisional vs confirmed views.

### Clearing algorithm

Supply curve `p(s)` = marginal price at cumulative supply `s`, strictly increasing. `s0` = supply already issued.

```
accepted(P) = { bids b : b.max >= P }
V(P)        = sum of value of accepted(P)
Q(P)        = min(V(P) / P, cap)

solve for P*:  P* = p( s0 + Q(P*) )        # bisect; unique because p is increasing
```

- Every bid with `max >= P*` fills at `P*`, receiving `value / P*` tokens. Uniform price: the marginal bidder and the most aggressive bidder pay the same.
- Every bid with `max < P*` is rejected in full.
- If `cap` binds, the marginal price tier is rationed **pro-rata by value**, deterministically; ties broken by `(height, tx index, output index)`.
- Rejected bids and rationing remainders become refunds.

Bidding your true reservation price is optimal here, which is the point — there is no advantage to timing, ordering, or gas.

---

## 7. Issuance and interop

The subtle part. ZRC-20 balances only move through valid `mint`/`transfer` ops, and those are signed by the account being debited. We cannot mint straight into a winner's account — we do not hold their key. If instead our reducer credited balances directly, those balances would be invisible to every other ZRC-20 indexer, and the token would no longer be a ZRC-20 at all.

**Resolution: deploy → mint to ourselves → transfer out.**

1. `launch` deploys the ticker with `start` set beyond the sale, so no public fair-mint can front-run the auction.
2. The launchpad account mints the epoch's cleared quantity to *itself*. Signed by our key, valid under plain ZRC-20 rules.
3. One `transfer` per winner, launchpad → winner's `acct`. Also signed by us, also plainly valid.

Every independent ZRC-20 indexer replays these and arrives at exactly our balance sheet. Full interop, no special-casing, and no trust in our reducer for *token state* at all.

Cost: one ~282-byte memo and one shielded output per winner. Zcash batches many outputs per transaction; ZIP-317 fees scale with output count. Budget this — a 2,000-winner epoch is 2,000 outputs.

**Refunds** default to a credit carried into the next epoch (auditable, no payout machinery, no address to leak). A bidder who supplied `r` gets ZEC back to that unified address instead. Credits are claimable at any time.

---

## 8. Graduation: a two-sided call market

There is no AMM on Zcash, so there is no pool to seed and no LP to burn. Graduation is a **change of market structure, not of venue**: once the curve's allocation is exhausted, the same epoch clock keeps running and `ask` ops start clearing against `bid` ops at a single price per epoch.

A periodic call market. It needs no AMM, non-atomicity is irrelevant by construction, and it is how real illiquid markets actually open. The token side is escrowed by the reducer; only ZEC in flight is custodial.

This is also the honest answer to why the product is not a pump.fun clone: on a chain without contracts, a call market is the correct primitive and a constant-product pool is not available at any price.

---

## 9. Trust model — state this publicly

Where trust is genuinely required:

1. **We hold bid ZEC in the treasury.** Custodial. Unavoidable without contracts. The draft spec concedes the same point: *"there is no equivalent here yet, so the first exchanges will necessarily be custodial."*
2. **We run the canonical indexer** and are the only party who can read an epoch while it is open.
3. **Refunds and issuance are discretionary acts**, not enforced settlement.

Where trust is not required:

- Token balances are plain ZRC-20, verifiable by any independent indexer (§7)
- `ask` escrow is reducer-enforced
- Every cleared epoch is fully recomputable once its IVK is published

Mitigations we commit to: deterministic rules, open-source reducer, per-epoch state root and IVK published at clearing, treasury under multisig.

zkSNARKs took $17.5M and delivered nothing because nothing bound them and nobody asked. Publishing the trust model, in these words, is itself the positioning.

---

## 10. Open questions

- **Curve shape.** `lin` is a placeholder. Needs modelling against realistic bid distributions before it is fixed, since `cap` and curve steepness jointly set how long a launch takes.
- **Ticker squatting.** Deploy costs only a Zcash fee, so every short ticker gets claimed within days. The draft spec flags this and specifies no fix. A deposit or commit-reveal on `launch` is probably ours to solve.
- **Epoch length.** 80 blocks (~100 min) is a guess. Shorter feels more alive and costs more in issuance fees; longer improves price discovery.
- **Fee model.** No protocol fee exists in ZRC-20. Ours would be a cut of cleared value, taken in the mint step. Not yet specified.
- ~~**Wallet support.**~~ Resolved 2026-09-26: no custom wallet needed. See §12.
- **`r` field pressure.** At 422/512 with refund address and first-use pubkey, adding any further required field breaks the budget. Extensions must be optional.

---

## 11. Build order

1. **Indexer first.** Sync via `zebrad` or lightwalletd, trial-decrypt with the protocol IVK, reduce, undo log per block. This is the product; the site is a view over it. Validate by replaying real Zcash blocks and reproducing known state.
2. **ZRC-20 reducer** on its own, tested against the draft spec's own reducer sketch.
3. **`uw-1` reducer + clearing**, with property tests: uniform price, no ordering advantage, deterministic rationing, reorg-safe rollback.
4. **Wallet path** (§12) — fork WebZjs for memos, in-page Ed25519 key, ZIP-321 link builder. No longer the schedule risk it looked like; it's a small fork plus integration.
5. **Issuance pipeline** — batched transfers, fee modelling at realistic winner counts.
6. Only then, front end.

Steps 1–3 are pure functions over blocks and can be built and tested with no ZEC and no counterparty.

---

## 12. Wallet path (verified 2026-09-26)

A bid needs two things: a shielded send carrying our memo, and an Ed25519 signature inside that memo. **They are separable**, and that is what makes this easy.

### The Ed25519 key is ours, not the wallet's

ZRC-20's `acct` is deliberately decoupled from Zcash addresses. So the page holds the key and signs the bid JSON itself; the Zcash wallet only has to carry an opaque memo.

Best UX: derive the key deterministically from a MetaMask `personal_sign` over a fixed, domain-bound message, hashed into an Ed25519 seed. It recovers from the same MetaMask with no new seed phrase. MetaMask's ECDSA is RFC 6979 deterministic, so the derivation is stable. The catch is that any site that gets a user to sign that exact message can derive their `acct` key. The message must name our domain and say plainly what it does. Fallback for non-MetaMask users: a generated key with explicit export and backup.

### Desktop: MetaMask Zcash Snap

ChainSafe's Zcash Snap is live, audited by Hacken, and listed in MetaMask's official Snaps directory. Built on WebZjs. RPC surface: `getViewingKey`, `signPczt`, `getSeedFingerprint`, birthday and state get/set.

The page builds the transaction with WebZjs, and the snap signs it. `signPczt` signs **any** PCZT the page hands it, so memo contents are entirely under our control.

**Blocker, and it is small.** WebZjs's `pczt_create(account_id, to_address, value)` takes no memo. Internally it calls:

```rust
TransactionRequest::new(vec![Payment::without_memo(to_address, value)])
```

librustzcash's `Payment` already supports memos. The fix swaps in `Payment::new(…, Some(memo), …)` and threads a `memo` argument through the wasm binding, a few lines of Rust plus a wasm rebuild. We bundle WebZjs ourselves, so we fork it without anyone's approval. **The audited snap doesn't change.** Worth upstreaming to ChainSafe regardless.

Other notes on this path:
- The snap may be Sapling-only (ChainSafe's launch post mentions Sapling key management). That's fine, since Sapling outputs carry the same 512-byte memo and ZRC-20 orders Sapling before Orchard within a transaction.
- Onboarding cost: the page syncs in-browser via lightwalletd from a birthday height, and proving runs in a web worker for "10s of seconds" per WebZjs's own docs. Needs a proper progress UI.

### Mobile: Zodl via ZIP-321

Zashi was rebranded **Zodl** in Feb 2026, after its team left ECC in January to form Zcash Open Development Lab. Repo is now `zodl-inc/zodl-android`, and the old ECC URLs 301 to it.

Zodl scans ZIP-321 payment URIs, and its CHANGELOG records *"Scanning zip321 now properly prefills memo."* So the page builds a `zcash:` URI with `address`, `amount`, and `memo` (base64url of the signed bid JSON, within ZIP-321's 512-byte limit), shows it as a QR code or deep link, and the user sends from Zodl. No MetaMask needed.

Caveats:
- "Prefills" means the memo is editable. A user who touches it makes the bid inert while the ZEC still lands, and the refund path (§7) has to handle that gracefully.
- The URI carries the signed bid. A screenshot or clipboard copy leaks the `acct` ↔ bid link outside the chain. This is minor, but say it in the UI.

### Security issue to report upstream

The snap's `signPczt` confirmation dialog renders `signDetails.recipient` and `signDetails.amount` **as supplied by the calling site**, not parsed from the PCZT it's about to sign. A malicious page can show "0.01 ZEC to X" while the transaction sends the whole balance elsewhere.

That doesn't affect our honest page, but it does mean phishing clones of Underwater ZEC could drain users through a dialog that looks legitimate. Given this project's history with phishing blocklists, it's worth a responsible disclosure to ChainSafe before we build a user base on the snap. We should also never ask users to trust that dialog's numbers. Our own UI should show what the PCZT actually contains.
