# Security

## Reporting a vulnerability

Open a private advisory:
**[github.com/kaleidofinance/Underwater/security/advisories/new](https://github.com/kaleidofinance/Underwater/security/advisories/new)**

That gives you a private thread with a record of when it was filed, which a
mail to an inbox does not. If you would rather not use GitHub, reach
[@underwaterxyz](https://x.com/underwaterxyz) and ask for a channel — do not put
details in a public post or a DM you cannot delete.

There is **no bug bounty**. Nothing is deployed to a live mainnet and the token
does not exist, so there is no fund to pay one out of and no honest number to put
on a payout. What you get instead is credit here and a fast answer.

Please include the chain and the contract address, the transaction or call that
demonstrates it, and what an attacker gets. A proof against a local `anvil` fork
is ideal and is enough — we do not ask anyone to spend testnet gas to prove a
point.

**In scope:** the contracts in [`src/`](src), the frontend in [`web/`](web), and
the deployment configuration of the hostnames listed below.

**Out of scope:** Ink itself, the RPC providers, third-party wallets, and
anything reachable only with the private key of an account you already control.

## Official domains and accounts

This section exists because the project is young and impersonating a launchpad is
easy. Everything below is exhaustive. **Anything not on this list is not us**, no
matter what it looks like or what wordmark it wears.

| What | Where |
| --- | --- |
| Site | `gounderwater.fun`, `www.gounderwater.fun` |
| Site (same deployment) | `underwater-fun.vercel.app` |
| Source | `github.com/kaleidofinance/Underwater` |
| X | `x.com/underwaterxyz` |

Two things worth being blunt about, because both are the kind of thing a
lookalike site relies on you not noticing:

- The project is **called** underwater.fun and is **served from**
  `gounderwater.fun`. The bare `underwater.fun` is not registered to us and is
  not ours; treat a site there as unaffiliated until this table says otherwise.
- We have **no Discord, no Telegram, and no token sale.** There is no presale, no
  private round, and nobody from this project will ever DM you an allowlist link,
  ask for a seed phrase, or ask you to sign a message to "verify" a wallet.

## What the site asks a wallet to do

Auditable against the source rather than taken on trust, which is the point:

- Allowlist registration is `register()` or `registerWith(address referrer)` on
  `UnderwaterWaitlist` ([`src/nft/UnderwaterWaitlist.sol`](src/nft/UnderwaterWaitlist.sol)).
  Both are **`nonpayable`** — registering cannot move ETH, and the contract holds
  none.
- Nothing anywhere in the frontend calls `eth_sign`, `personal_sign`,
  `signTypedData`, or `setApprovalForAll`. There is no off-chain signature step
  in this application at all.
- The only ERC-20 `approve` the app ever requests is a router allowance on the
  swap path ([`web/lib/trade-engine.ts`](web/lib/trade-engine.ts)), for the token
  you are selling, in the amount you are selling. Behind the pre-launch gate that
  path is not reachable.

## Deployed contracts

Ink Sepolia (chain `763373`), explorer
[`explorer-sepolia.inkonchain.com`](https://explorer-sepolia.inkonchain.com):

| Contract | Address |
| --- | --- |
| `UnderwaterWaitlist` | `0x90a1620578CE419242F806e7387Db7e70c8cfa96` |
| `UnderwaterPlates` | `0xCF59972d09Dbf9b37c1e3CDa55c47d0253038D76` |
| `UnderwaterRenderer` | `0xe8a9eb6026D7f755aaC92a4B68C902Ee32334e3a` |
| `Launchpad` | `0xf9928C816b75Bb3EA081Fc0d1C0172E475957C48` |

Testnet only — **nothing is deployed to Ink mainnet yet.** Explorer source
verification is still outstanding, so verify the bytecode against a local build
rather than trusting the explorer's label until it is done.

## Maintaining this

[`web/public/.well-known/security.txt`](web/public/.well-known/security.txt)
points at this file and carries an `Expires` date. An expired `security.txt` is
treated as invalid by the tools that read it, so that date has to be moved
forward before it passes — and the contact links there and here have to keep
resolving.
