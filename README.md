# Solana Sentinel — Early Launch Intelligence & Trading Bot

**Status:** Foundation and read-only token discovery implementation; not a trading bot.  
**Language:** TypeScript, Node.js, SQLite; optional React dashboard.  
**Network:** Solana **mainnet** data for all modes; no live trading until separately armed.  
**Initial focus:** Pump.fun new-token detection, creator intelligence, anti-scam, test-token classification, and shadow trading.

> WARNING: Highly speculative, high-loss-risk token trading. A token that passes security checks can still lose 100% of its value. Never add a real wallet's private key to the scanner, dashboard, logs or repository. `DRY_RUN` is the default.

## Modes

| Mode      | Mainnet market data | Virtual order fills               | Real signing/sending                                      |
| --------- | ------------------- | --------------------------------- | --------------------------------------------------------- |
| `DRY_RUN` | Yes                 | No                                | Never                                                     |
| `PAPER`   | Yes                 | Yes, with conservative fill model | Never                                                     |
| `LIVE`    | Yes                 | No                                | Only from isolated signer process after explicit approval |

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

The initial checkout was a documentation-only blueprint. The current implementation provides validated DRY_RUN configuration, SQLite event persistence, PumpPortal launch/migration discovery, a Helius read adapter, and read-only health/token endpoints. Paper execution, intelligence/security analysis, and the dashboard remain unimplemented. See [implementation status](docs/IMPLEMENTATION-STATUS.md).

## Local implementation commands

With Node.js 24 or 26 and pnpm 11 installed:

```bash
pnpm install
pnpm db:migrate
pnpm test
pnpm typecheck
pnpm lint
```

Set `PUMPPORTAL_API_KEY` in the process environment to start discovery. `HELIUS_API_KEY` enables provider health and mint account reads. The worker accepts only `DRY_RUN`; it never signs or submits transactions. See [implementation status](docs/IMPLEMENTATION-STATUS.md) for startup and integration limits.

## Non-negotiable invariants

1. `DRY_RUN`/`PAPER` must have **zero capability** to sign or submit transactions.
2. Failing providers / stale snapshots / unknown token state => `QUARANTINE` or `REJECT`, **never automatic BUY**.
3. Not enough liquidity for exit => never pretend to have sold in paper mode.
4. Historical decisions can only use data known by their decision timestamp/slot.
5. Every decision saves snapshot references, reason codes, config/version, timestamps, provider provenance.
6. `LIVE` must be an isolated deployment, separately authorized and protected by hard limits.
7. Dashboard can change safe settings, but **cannot arm live trading**.

## Definition of MVP

A single host can run realtime token discovery, perform basic creator/security checks, record `DRY_RUN` decisions and `PAPER` fills with SOL-denominated ledger accounting, and show auditable dashboards. No wallet secret is needed. Live implementation is a separate gated milestone.
