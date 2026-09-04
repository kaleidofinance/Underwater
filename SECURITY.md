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
| Site | `underwater.fun`, `www.underwater.fun` |
| Site (same deployment) | `underwater-fun.vercel.app` |
| Source | `github.com/kaleidofinance/Underwater` |
| X | `x.com/underwaterxyz` |

The project is called underwater.fun and is now served from it. Until 2026-09-04
it was not: the name was taken, the site ran on `gounderwater.fun`, and this
section said in as many words that a site at the bare `underwater.fun` was not
ours. That sentence is gone because it is no longer true, and it is worth knowing
it was ever there — anyone who read this page before that date was told the
opposite of what it says now.

`gounderwater.fun` and `www.gounderwater.fun` are deliberately **absent** from the
table above. They are still registered to us, but they are suspended at the
registry and resolve to nothing, so they serve no version of this site — not a
redirect, not a mirror. Because the table is exhaustive, that means: if a site
ever appears there, it is not us, and nothing about the fact that we once used the
name makes it safe.

One more thing worth being blunt about, because it is the kind of thing a
lookalike relies on you not noticing: we have **no Discord, no Telegram, and no
token sale.** There is no presale, no private round, and nobody from this project
will ever DM you an allowlist link, ask for a seed phrase, or ask you to sign a
message to "verify" a wallet.

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
  you are selling, in the amount you are selling.

## Deployed contracts

Ink Sepolia (chain `763373`), explorer
[`explorer-sepolia.inkonchain.com`](https://explorer-sepolia.inkonchain.com):

| Contract | Address | Source verified |
| --- | --- | --- |
| `UnderwaterWaitlist` | `0x90a1620578CE419242F806e7387Db7e70c8cfa96` | no |
| `UnderwaterPlates` | `0xCF59972d09Dbf9b37c1e3CDa55c47d0253038D76` | no |
| `UnderwaterRenderer` | `0xe8a9eb6026D7f755aaC92a4B68C902Ee32334e3a` | no |
| `UnderwaterLaunchpad` | `0xf9928C816b75Bb3EA081Fc0d1C0172E475957C48` | yes |
| `UnderwaterFactory` | `0xf9e2A7Ac9143Ea0f25116009095D0B5700e2317F` | yes |
| `UnderwaterRouter` | `0xcf00f8609deECcE0a84E2A7b9D11210ac495938B` | yes |
| `UnderwaterPoints` | `0x629C8Af0230466558953ea305a6319E5e938d7f0` | yes |

Where the column says no, verify the bytecode against a local build rather than
trusting the explorer's label. Checked against the explorer's own API on
2026-08-30, not from memory of what was submitted.

Robinhood Chain Testnet (chain `46630`), explorer
[`explorer.testnet.chain.robinhood.com`](https://explorer.testnet.chain.robinhood.com):

| Contract | Address | Source verified |
| --- | --- | --- |
| `UnderwaterFactory` | `0x931B2f7f75FaEcC5AaEA4E336A117a1ecc96becb` | yes |
| `UnderwaterRouter` | `0x0a74c808A0f849695b9CfBBC6800C46de1D3e4c5` | yes |
| `UnderwaterLaunchpad` | `0xeFe21b46e9603A574c7aBd3a88976f9B456D832B` | yes |
| `UnderwaterPoints` | `0x57440671f8F67A56C4D56665553Bf7d8c2C73794` | yes |

There is no collection and no waitlist here: both read Aave V3 health factors and
Robinhood has no Aave V3 deployment, so neither can be deployed to it honestly.

Testnets only — **nothing is deployed to either mainnet yet.**

## Maintaining this

[`web/public/.well-known/security.txt`](web/public/.well-known/security.txt)
points at this file and carries an `Expires` date. An expired `security.txt` is
treated as invalid by the tools that read it, so that date has to be moved
forward before it passes — and the contact links there and here have to keep
resolving.
