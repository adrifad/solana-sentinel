# Solana Sentinel — Early Launch Intelligence & Trading Bot

**Status:** Read-only discovery and analysis plus an isolated, virtual `PAPER` runtime. Automatic entries remain disabled by default and live trade coverage is unverified.
**Language:** TypeScript, Node.js, SQLite; optional React dashboard.  
**Network:** Solana **mainnet** data for all modes; no live trading until separately armed.  
**Initial focus:** Pump.fun new-token detection, creator intelligence, anti-scam, test-token classification, and shadow trading.

> WARNING: Highly speculative, high-loss-risk token trading. A token that passes security checks can still lose 100% of its value. Never add a real wallet's private key to the scanner, dashboard, logs or repository. `DRY_RUN` is the default.

## Modes

| Mode      | Mainnet market data | Virtual order fills               | Real signing/sending |
| --------- | ------------------- | --------------------------------- | -------------------- |
| `DRY_RUN` | Yes                 | No                                | Never                |
| `PAPER`   | Yes                 | Yes, with conservative fill model | Never                |
| `LIVE`    | Unsupported         | No                                | Not implemented      |

`REPLAY` is a **data source** for repeatable historical tests, not a live trading mode. Do not describe offline replay as realtime paper trading.

## Read the documents in this order

1. [Product requirements](docs/00-PRODUCT-REQUIREMENTS.md)
2. [Architecture](docs/01-SYSTEM-ARCHITECTURE.md)
3. [Local setup](docs/02-SETUP-LOCAL.md)
4. [Provider integrations](docs/03-PROVIDER-INTEGRATIONS.md)
5. [Configuration](docs/04-CONFIGURATION.md) and [example config](config/default.yaml)
6. [Trading modes](docs/05-TRADING-MODES.md)
7. [Discovery & creator forensics](docs/06-DISCOVERY-FORENSICS.md)
8. [Risk/security rules](docs/07-SECURITY-RISK.md)
9. [Paper execution](docs/08-PAPER-EXECUTION.md)
10. [Live trading readiness](docs/09-LIVE-READINESS.md)
11. [Data model](docs/10-DATA-MODEL.md)
12. [Dashboard and API](docs/11-API-DASHBOARD.md)
13. [Tests and acceptance](docs/12-TESTING-ACCEPTANCE.md)
14. [Operations](docs/13-OPERATIONS.md)
15. [Implementation roadmap](docs/14-IMPLEMENTATION-ROADMAP.md)
16. [Agent implementation brief](docs/15-AGENT-IMPLEMENTATION-PROMPT.md)
17. [Architecture decisions](docs/16-ARCHITECTURE-DECISIONS.md)
18. [Event contracts](docs/17-EVENT-CONTRACTS.md)
19. [Replay methodology](docs/18-REPLAY-AND-VALIDATION.md)
20. [Threat model](docs/19-THREAT-MODEL.md)
21. [Official provider references](docs/20-REFERENCES.md)

## Configuration & starter templates

- `.env.example`: environment variables and secrets placeholders.
- `config/default.yaml`: baseline non-secret settings, conservative limits; **example only**.
- `.gitignore`: excludes `.env`, DBs, signer secrets, logs.

The current runtime supports explicit `DRY_RUN` and virtual `PAPER` modes. PAPER initializes a persistent virtual wallet, recovers pending orders, obtains fresh Pump curve/PumpSwap quotes through read-only Helius RPC, and monitors positions for stop-loss, take-profit, or maximum holding time. Automatic entry evaluation wakes on persisted decisions independently of the exit-monitor interval, but automatic entries remain disabled by default. Monitoring slots expire after the configured observation duration, and Helius request budgeting reserves capacity for risk-reducing exit quotes. Automatic entries still require complete observation coverage, which the current log observer cannot establish; manual entry has a separate narrow evidence-backed coverage exception. PAPER has no signer or transaction submission path, LIVE, the dashboard, and profitability claims remain unsupported. See [implementation status](docs/IMPLEMENTATION-STATUS.md), the [Sprint 3.2 validation report](SPRINT32_VALIDATION_REPORT.md), and the [current zero-trade diagnostic report](ZERO_TRADE_DIAGNOSTIC_REPORT.md) for evidence and remaining gates.

## Local implementation commands

With Node.js 24 or 26 and pnpm 11 installed:

Provider validation is available with `pnpm validate:providers --seconds=45`. The default live check makes at most four Helius RPC requests, listens only to free PumpPortal create/migration feeds, and never enables metered trade subscriptions. Optional state-capture flags run additional bounded Helius account requests for Pump curve or PumpSwap snapshots. Sanitized public evidence can be written under `tests/fixtures/captures`; see `--help` in the script for the supported capture flags.

The read-only trade-event harness is `pnpm validate:trade-events -- --mint=<MINT> --max-signatures=5`. It examines at most 20 finalized address signatures and makes at most eight Helius RPC requests, without opening the application database. It does not prove exhaustive observation coverage; only a verified trade can be written as a sanitized fixture under `tests/fixtures/captures/`.

```bash
pnpm install
pnpm db:migrate
pnpm test
pnpm typecheck
pnpm lint
```

Set `PUMPPORTAL_API_KEY` in the process environment to start discovery. `HELIUS_API_KEY` enables on-chain creator history, security analysis, and read-only quotes. `APP_MODE=PAPER` starts the virtual PAPER runtime; `LIVE` is rejected. `PAPER_OPERATOR_TOKEN` (minimum 32 characters) is required for manual entry/exit API writes. Compose passes the same `APP_MODE` to API and worker, defaults it to `DRY_RUN`, and publishes the API on loopback. `paper.automatic_entries_enabled` and `providers.helius.enable_trade_stream` default to `false`. Enabling the stream does not establish complete coverage or enable paid PumpPortal feeds. See [implementation status](docs/IMPLEMENTATION-STATUS.md) for startup and integration limits.

## Non-negotiable invariants

1. `DRY_RUN`/`PAPER` must have **zero capability** to sign or submit transactions.
2. Failing providers / stale snapshots / unknown token state => `QUARANTINE` or `REJECT`, **never automatic BUY**.
3. Not enough liquidity for exit => never pretend to have sold in paper mode.
4. Historical decisions can only use data known by their decision timestamp/slot.
5. Every decision saves snapshot references, reason codes, config/version, timestamps, provider provenance.
6. `LIVE` is unsupported and rejected by runtime configuration.
7. Dashboard can change safe settings, but **cannot arm live trading**.

## Definition of MVP

The runtime delivers real-time token discovery and persisted creator/security `DRY_RUN` decisions, and supports a strictly virtual PAPER wallet and position monitor. Automatic PAPER entries remain disabled by default and require a `BUY_ELIGIBLE` decision plus complete trade coverage, complete behavior, supported security state, matching config version, and a fresh signal. Current Helius log coverage is deliberately unverified, so no live automatic entry or live fill is claimed. No private wallet secret, signing, transaction submission, or LIVE mode is available.
