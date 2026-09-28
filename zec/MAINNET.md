# Mainnet runbook

The testnet stack (`zec-wallet` + `zec-api` on Railway, the web app on Vercel) stays as staging. Mainnet is a second, separate stack: its own wallet, seed, log and volumes. Nothing is shared with testnet.

## Before go-live (the operator)

- [ ] **Cold wallet.** Restore the 24 words from `underwater-cold-seed.txt` in a Zcash wallet app. Copy them to paper, delete the file, and hand over the wallet's unified full viewing key (`uview1…`) for `COLD_UFVK`. Never hand over the words.
- [ ] **Backup key.** Move `underwater-backup-key.txt` offline (USB or paper) next to the cold seed. Without it, no backup can be restored.
- [ ] **Alerts.** Create a Telegram bot with @BotFather, and message it once. Hand over the bot token and your chat id (or a Discord webhook URL).
- [ ] **Accounts.** Turn on two-factor authentication on Railway, Vercel and GitHub. Anyone in Railway can reach the online wallet.
- [ ] **Audit.** Get an independent review of `zec/wallet-service`, `zec/rails` and `zec/server/auth.ts` before holding real money.
- [ ] **Legal.** The operator handles this.

## Create the stack

1. **Mainnet wallet service** (Railway, from `zec/wallet-service`, with a volume at `/data`, and **no public domain**):

   | Variable | Value |
   |---|---|
   | `ZEC_NETWORK` | `main` |
   | `ALLOW_MAINNET` | `1` |
   | `WALLET_API_TOKEN` | a fresh 64-hex secret (never the testnet one) |
   | `LIGHTWALLETD_URL` | `https://na.zec.rocks:443,https://eu.zec.rocks:443,https://zec.rocks:443,https://ap.zec.rocks:443,https://zcash.mysideoftheweb.com:9067` |
   | `COLD_UFVK` | the cold wallet's viewing key |
   | `BACKUP_PUBLIC_KEY` | the `public:` line of `underwater-backup-key.txt` |
   | `NO_CACHE` | `1` (Railway's builder otherwise stalls on "scheduling build") |

   The first start creates a new seed on the volume. **Before anything else, take a backup** (step 4) and restore it once to prove it opens.

2. **Mainnet API** (Railway, from `zec/`, with a volume at `/data` and a public domain):

   | Variable | Value |
   |---|---|
   | `WALLET_URL` | `http://<mainnet-wallet-service>.railway.internal:8080` |
   | `WALLET_API_TOKEN` | the same value as the wallet service |
   | `ADMIN_TOKEN` | a fresh 64-hex secret, kept in `zec/.env.admin.mainnet` |
   | `BACKUP_PUBLIC_KEY` | the same public key |
   | `ALERT_TELEGRAM_BOT_TOKEN`, `ALERT_TELEGRAM_CHAT_ID` | from the alerts step |
   | `ALERT_LABEL` | `[mainnet]` |
   | `ZEC_WEB_ORIGIN` | `https://www.underwater.fun` |
   | `NO_CACHE` | `1` |

   A new log starts with `ZEC_LAUNCH_FEES` in its header: 1% curve, 0.5% pool, 5% graduation, 0.001 ZEC to create, all protocol. Creators earn through the token taxes they set.

3. **Web** (Vercel production): set `NEXT_PUBLIC_ZEC_API` to the mainnet API URL and `NEXT_PUBLIC_ZEC_NETWORK=mainnet` (this drops the testnet badge). Keep a preview deployment pointed at testnet for staging.

4. **Backups:** `node ops/backup.ts <folder> --api https://<mainnet-api>`, daily. It needs `ADMIN_TOKEN` in the environment. Prove each new setup with `node ops/restore.ts <backup> <key file> <scratch dir>`, then delete the restored `seed.bin`.

## Guards at launch

The operator's call for launch: **every user's funds stay online, and withdrawals never pause automatically**, to study real traffic first.

- **Books check and hourly outflow check:** run in **alert-only** mode. If the wallets ever hold less than is owed, or the last hour's withdrawals pass 25% of everything owed, you get a critical alert, and withdrawals keep flowing. Set `GUARD_MODE=pause` on the API to make them stop withdrawals instead. Resume a pause with:
  `curl -X POST <api>/api/admin/withdrawals -H "authorization: Bearer $ADMIN_TOKEN" -d '{"paused":false,"reason":"checked"}'`
- **Cold sweeps:** **off**. With `COLD_SWEEPS=1` (and `COLD_UFVK` on the wallet), the reserve keeps 10% of what's owed online and sends the rest to cold, with a top-up alert when it runs low.
- **Still always on:**
  - 50 ZEC of withdrawals per account per day;
  - the 5 ZEC fast-credit cap and the 0.001 ZEC minimum deposit;
  - rate limits.

## Topping up the online wallet from cold

When the "online wallet low" alert fires, send the amount it names from the cold wallet app to the reserve address it names. Queued withdrawals pay out once that transfer confirms (about 10 blocks).
