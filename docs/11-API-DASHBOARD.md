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
GET    /ready
GET    /api/tokens?limit=50
GET    /api/tokens/:mint
GET    /api/creators/:pubkey
```

The implemented API is read-only: token detail includes role evidence, latest security report, decisions, analysis job outcomes, and migration transaction-recovery status; health includes provider health, completeness, separate provider/analysis/trade/PAPER readiness, and recent sanitized provider-frame diagnostics. `/api/metrics/latency` reports persisted analysis-stage p50 and sample count, with p95 after 20 samples and p99 after 100. Creator detail includes reputation, historical launches, and wallet-link evidence. Portfolio, orders, config mutation, authentication, and push event streaming remain unimplemented. No endpoint can change mode or arm trading.

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
