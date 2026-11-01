# 02 — Local Development Setup (Ubuntu / Arch / CachyOS)

This is the **planned setup for the app implementation**. The blueprint zip itself does not contain runnable app code.

## Prerequisites

- Linux workstation/VPS, Git, Node.js **current supported LTS** (pin actual tested version in `.nvmrc` once app exists), Corepack/pnpm, Python 3 for diagnostics, SQLite CLI, Docker optional.
- Network access to Helius RPC, PumpPortal WebSocket, DEX Screener HTTPS and Jupiter HTTPS.
- Already obtained: `HELIUS_API_KEY`, `PUMPPORTAL_API_KEY`, `JUPITER_API_KEY` (if available). DEX Screener public endpoints do not require credentials.
- SQLite stored on a persistent SSD; daily backups and disk alerting.

## Verify tools

```bash
node --version
corepack --version
pnpm --version
git --version
sqlite3 --version
```

## Initialize implementation workspace

```bash
mkdir solana-sentinel && cd solana-sentinel
# Copy files from this blueprint preserving the docs/ and config/ structure.
cp .env.example .env
chmod 600 .env
# Edit .env locally; never post keys into chat or commit them.
```

**For the coding agent:** create a pnpm workspace and the packages described in `01-SYSTEM-ARCHITECTURE.md`. Scripts after implementation should include:

```bash
pnpm install
pnpm db:migrate
pnpm test
pnpm typecheck
pnpm lint
pnpm dev:worker
pnpm dev:api
pnpm dev:web
```

Do **not** expect these commands to work until implementation adds `package.json`, scripts and migrations.

## Start-up milestones

1. **Provider health:** successful Helius JSON-RPC test and PumpPortal subscription; provider checks never print API keys.
2. **Discovery:** persist `subscribeNewToken` events. Dedup by signature/mint/slot.
3. **Research:** Creator history and mint state; store reason codes and confidence.
4. **DRY_RUN:** generate audit signals, zero balance mutations, no wallet.
5. **PAPER:** configure virtual starting SOL, send simulated quote requests only, record full ledger.
6. **UI:** consume read-only API, then implement safe settings editing.
7. **Production:** supervision, backups, TLS/reverse proxy, no exposed database port.

## Sanity checklist

- `APP_MODE=DRY_RUN` and `LIVE_TRADING_ENABLED=false`.
- No real-wallet keypair is present anywhere in process env, YAML, bind mounts, database or CI.
- `.env` is ignored by Git; accidental commits trigger secret rotation.
- RPC timestamps and log timestamps are normalized to UTC.
- Paper account currency SOL, initial lamports set and immutable after ledger first entry without a ledger adjustment event.
- All provider adapters can run in mock/fixture mode for tests.

## Provider command examples

```bash
# Public DEX Screener sample: replace <TOKEN_MINT> with a known mint.
curl -fsS 'https://api.dexscreener.com/token-pairs/v1/solana/<TOKEN_MINT>'

# Helius health and rate limits should be verified by code using the official RPC docs;
# do not paste secrets into shell history or command output.
```

## Note on Docker

Use Docker Compose **after** implementation creates `Dockerfile` for worker/API/web and tested volumes. Keep live-executor in a separate deployment/compose profile and host. Do not put live signer secrets in a shared compose file.

---
