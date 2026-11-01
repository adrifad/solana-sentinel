# Solana Sentinel — Early Launch Intelligence & Trading Bot

**Status:** Read-only discovery, creator-intelligence, token-security, and explainable `DRY_RUN` analysis foundation; no trading execution.
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

The initial checkout was a documentation-only blueprint. The current implementation provides validated `DRY_RUN` configuration, SQLite event persistence and migrations, PumpPortal launch/migration discovery, bounded Helius read adapters, creator-intelligence and token-security reports, quote-only Jupiter routing, an official Pump bonding-curve quote calculator for verified SDK state, time-indexed launch behavior contracts, explainable fail-closed decisions, and read-only APIs. Live Pump quotes, PumpSwap state decoding, PumpPortal trade subscriptions, PAPER execution, LIVE execution, and the dashboard remain unimplemented or disabled. Jupiter results without chain slot and price-impact evidence cannot pass exit validation. See [implementation status](docs/IMPLEMENTATION-STATUS.md).

## Local implementation commands

With Node.js 24 or 26 and pnpm 11 installed:

```bash
pnpm install
pnpm db:migrate
pnpm test
pnpm typecheck
pnpm lint
```

Set `PUMPPORTAL_API_KEY` in the process environment to start discovery. `HELIUS_API_KEY` enables on-chain creator history and security analysis. The worker accepts only `DRY_RUN`; it never signs or submits transactions. See [implementation status](docs/IMPLEMENTATION-STATUS.md) for startup and integration limits.

## Non-negotiable invariants

1. `DRY_RUN`/`PAPER` must have **zero capability** to sign or submit transactions.
2. Failing providers / stale snapshots / unknown token state => `QUARANTINE` or `REJECT`, **never automatic BUY**.
3. Not enough liquidity for exit => never pretend to have sold in paper mode.
4. Historical decisions can only use data known by their decision timestamp/slot.
5. Every decision saves snapshot references, reason codes, config/version, timestamps, provider provenance.
6. `LIVE` must be an isolated deployment, separately authorized and protected by hard limits.
7. Dashboard can change safe settings, but **cannot arm live trading**.

## Definition of MVP

The current milestone delivers realtime token discovery and persisted creator/security `DRY_RUN` decisions with optional read-only quote evidence. PAPER fills, SOL ledger accounting, dashboards, and LIVE execution are future milestones. The current runtime uses no wallet secret and has no transaction-signing or submission capability.
