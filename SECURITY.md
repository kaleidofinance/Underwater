# Security

## Reporting a vulnerability

Open a private advisory:
**[github.com/kaleidofinance/Underwater/security/advisories/new](https://github.com/kaleidofinance/Underwater/security/advisories/new)**

That gives you a private thread with a record of when it was filed, which a
mail to an inbox does not. If you would rather not use GitHub, reach
[@underwaterxyz](https://x.com/underwaterxyz) and ask for a channel — do not put
details in a public post or a DM you cannot delete.

There is **no bug bounty** yet. The platform runs on Zcash testnet and holds no
real funds, so there is no honest number to put on a payout. What you get
instead is credit here and a fast answer.

Please include what you did, what an attacker gets, and a reproduction. A
proof against the sim server (`node zec/server/main.ts --sim`) is ideal and is
enough.

**In scope:** the engine, rails, API and treasury wallet in [`zec/`](zec), the
web app in [`web/`](web), and the deployment configuration of the hostnames
listed below. Anything that lets someone move value they don't own, withdraw
more than their balance, get credited for a deposit they didn't make, or make
the published liabilities or reserves disagree with reality is exactly what we
want to hear about.

**Out of scope:** Zcash itself, lightwalletd servers, third-party wallets, and
anything reachable only with a key you already control.

## Official domains and accounts

The project is young and impersonating a launchpad is easy. Everything below is
exhaustive. **Anything not on this list is not us**, no matter what it looks
like or what wordmark it wears.

| What | Where |
| --- | --- |
| Site | `underwater.fun`, `www.underwater.fun` |
| Site (same deployment) | `underwater-fun.vercel.app` |
| API | `zec-api-production.up.railway.app` |
| Source | `github.com/kaleidofinance/Underwater` |
| X | `x.com/underwaterxyz` |

`gounderwater.fun` and `www.gounderwater.fun` are deliberately **absent**. They
are registered to us but suspended at the registry and resolve to nothing, so if
a site ever appears there, it is not us.

We have **no Discord, no Telegram, and no token sale.** There is no presale and
no private round. Nobody from this project will ever DM you a link, ask for your
account backup (`uwzec1:…`), or ask you to send ZEC anywhere except the deposit
address your own Account page shows.

## What the site does with your key

Your account is an Ed25519 key generated in your browser and kept there. It
signs your requests to the API; it never leaves the browser, and the server
only ever sees its public half. The backup string on the Account page **is**
your account: anyone holding it can trade and withdraw as you.

## Verifying solvency

- `GET /api/solvency`: the root of a Merkle-sum tree over every balance. Your
  Account page fetches your proof and verifies it against that root in your
  browser.
- `GET /api/audit`: the reserve account's viewing key and every hash-chain
  anchor written to it. Import the key into any Zcash wallet to see the
  reserve's balance and the anchor memos directly.

## The retired EVM contracts

The Ink and Robinhood Chain version of underwater.fun is retired. Its contracts,
deployed addresses and security notes are archived at
[kaleidofinance/underwater-evm](https://github.com/kaleidofinance/underwater-evm).
Those deployments were testnet-only and are no longer maintained.

## Maintaining this

[`web/public/.well-known/security.txt`](web/public/.well-known/security.txt)
points at this file and carries an `Expires` date. An expired `security.txt` is
treated as invalid by the tools that read it, so that date has to be moved
forward before it passes — and the contact links there and here have to keep
resolving.
