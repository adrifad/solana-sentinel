# 11 — Dashboard and Internal API Contract

## UI pages

1. **Overview:** mode, stream health, scan count, token counts per risk status, risk budget, PnL if PAPER/LIVE.
2. **New Tokens:** live table mint, name, source, age, creator, phase, status, score, latency, reason codes.
3. **Token Detail:** authoritative mint/program state, creator analysis, linked-wallet graph with uncertainty, social evidence, market snapshot, decision trace.
4. **Creator Intelligence:** wallet profile, launch history, evidence signatures, confidence and time of assessment.
5. **Paper Portfolio:** virtual SOL, positions, cost basis, sell-quote valuation, realized/unrealized PnL and unpriceable exposure.
6. **Trades & Decisions:** all intents, quote reports, fills/no-fills, rejected decisions, fee breakdown, latency.
7. **Risk & Strategy:** config revisions and allowed hot-reload fields, pause switch, read-only locked caps.
8. **System:** provider health, reconnects, stale data, costs/quotas, DB backups, current build and configuration version.

## REST routes

```http
GET    /api/health
GET    /api/completeness
GET    /api/metrics/latency
GET    /api/metrics/daily-summary?date=YYYY-MM-DD
GET    /ready
GET    /api/tokens?limit=50
GET    /api/tokens/:mint
GET    /api/creators/:pubkey
GET    /api/paper/status
POST   /api/paper/entry
POST   /api/paper/exit
```

`GET /api/paper/status` is available only in PAPER mode and reports virtual balances, positions and fresh marks, realized PnL, fills, manual request lifecycle including `expiresAtUtc`, and readiness blockers. It separates `paperRuntimeReady`, `paperManualEntryReady`, `paperManualExitReady`, and `paperAutomaticEntryReady`; manual entry readiness requires an evidence-backed candidate and provider/auth/wallet checks, not just an initialized wallet. An open position is required for exit readiness. Readiness does not guarantee that an executable route will still exist at request time; the worker always fetches and validates a fresh quote. The two manual POST routes only enqueue durable requests; the worker owns eligibility, quote-at-arrival, and virtual settlement. Both require a bearer token from `PAPER_OPERATOR_TOKEN`, a unique `Idempotency-Key`, strict JSON bodies, and are rate limited. Missing operator token fails closed. Entry requests are bounded by configured `risk.max_trade_sol`; all other financial limits remain enforced by the worker and atomic ledger.

The optional Telegram process uses only `GET /api/health`, `GET /api/paper/status`, and `GET /api/metrics/daily-summary`. The summary endpoint validates an ISO calendar date and aggregates discovery and PAPER fill/PnL information for that date in `Asia/Jakarta`; it does not mutate trading state. The API remains host-loopback published in Compose, with bot-to-API communication on the Compose network.

Manual entry has one narrow coverage exception: structured evidence must show that incomplete stream coverage is the only substantive blocker, while verified observations independently satisfy the existing buyer and suspicious-activity policy. Informational reason codes are revalidated against their underlying evidence; an unexplained reason, unsafe creator, incomplete holder sample, missing behavior, or failed exit validation is rejected. Security, creator history, holder coverage, current quotes, exit route, exposure, wallet, drawdown, daily loss, and entry-pause checks are not bypassed. The request audit retains original reason codes, coverage state/reason, expiry, and the exception; the original risk decision remains unchanged. Manual SELL resolves a stable position ID against the configured PAPER wallet and remains available during entry pause when the fresh exit quote and held balance validate. Manual request expiry is independently configurable; automatic signal freshness is unchanged.

The API binds to loopback by default and Compose publishes `127.0.0.1:8787`. Do not expose the manual write routes publicly without authenticated TLS. No route can select LIVE mode, sign, or submit a transaction. Token detail includes role evidence, security reports, decisions, analysis jobs, and migration recovery; health includes provider health, completeness, readiness, and sanitized provider diagnostics. `/api/metrics/latency` reports persisted analysis-stage percentiles when sample counts permit. Creator detail includes reputation, historical launches, and wallet-link evidence. Config mutation and push event streaming remain unimplemented.

## Security / UX rules

- The UI may request DRY_RUN/PAPER mode change as **pending restart** only; active mode is read from server at boot, not inferred from selected option.
- UI **cannot** set LIVE, upload key material, arm signer, or change hard loss caps upward.
- Auth + CSRF protection for mutating endpoints, audit actor, rate limit. CORS deny unless configured.
- Display `SIMULATED` on all paper fills/returns. Never show simulated and real PnL mixed.
- Distinguish API `UNKNOWN` vs false/zero. Evidence provenance and timestamp visible.
- Show alert when quote is stale, stream disconnected, social evidence missing, token migrated, or valuation unpriceable.
- New-tokens table should be virtualized/limited rather than subscribing every token forever.

## Event stream

SSE event types: `token.discovered`, `token.analyzed`, `token.decision`, `order.status`, `portfolio.changed`, `provider.health`, `config.changed`.

Every event contains `eventId`, UTC timestamp, mode, relevant resource ID and config version; never contain secrets or private key material.

---
