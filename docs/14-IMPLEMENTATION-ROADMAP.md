# 14 — Implementation Roadmap / Work Breakdown

Read-only Helius mainnet health, historical transaction, and account-state calls, plus a PumpPortal live create event, were verified on 2026-11-01. No migration event arrived during the bounded free-feed session. Trade subscription was denied by the provider's linked-wallet minimum and no trade payload was captured. See `docs/IMPLEMENTATION-STATUS.md` for evidence and remaining gates.

## Sprint 0 — Foundation

- [ ] pnpm workspace, TypeScript strict, config Zod parser, SQLite WAL migrations and structured logger.
- [ ] Domain types: `MarketEvent`, `MarketSnapshot`, `TokenRiskReport`, `Decision`, `TradeIntent`, `OrderResult`.
- [ ] Unit tests and stub provider fixtures.
- [ ] Startup fail-closed checks, mode capability matrix tests.

**Done when:** non-secret env & YAML validated; DRY_RUN boots without wallet; bad config exits nonzero.

## Sprint 1 — Token discovery

- [ ] PumpPortal token creation + migration WebSocket provider.
- [ ] Single reconnecting socket; subscription tracking, dedup, event persistence.
- [ ] Helius RPC provider for base mint/program state.
- [ ] CLI/log output for token feed + health, persisted tokens list.

**Done when:** repeated reconnects cause no duplicated token records; stream budget cap works.

## Sprint 2 — Forensics and risk

- [ ] Creator attribution and historical caching.
- [ ] First-class wallet roles, wallet relationship evidence, labels/confidence.
- [ ] Token authorities/extensions classifier, security gate with reason codes.
- [ ] Test-token heuristic classifier.
- [ ] Dry-run `WATCH`/`REJECT`/`QUARANTINE`/`BUY_ELIGIBLE` logs.

**Done when:** every decision has linkable chain evidence; unknown data never becomes auto-approved.

## Sprint 3 — Paper execution

- [x] Price adapters for supported Pump curve and canonical PumpSwap using authoritative state+SDK (live quote-state vectors are limited to one recorded snapshot per venue).
- [x] Fresh exact-input buy and sell quote provider contract, fee model and quote-at-arrival simulation.
- [x] Virtual SOL wallet, immutable double-entry ledger, positions and no phantom sells in the standalone PAPER package.
- [x] Configured execution latency/slippage, persistent order recovery, risk limits, and PnL/drawdown reporting with deterministic tests.
- [x] Partial exits and time/stop/take-profit exit evaluation.
- [ ] Integrate the package into an operational PAPER worker with live normalized trade observations, end-to-end mode isolation tests, and controlled quote budgets.

**Done when:** 100 fixture scenarios pass; no paper trade changes chain balances.

**Current status:** PAPER foundation tests exist, but application mode and automatic entries remain disabled. Milestone A has not passed because live PumpPortal trade observations and continuous stream coverage are unavailable. The isolated package is not yet readiness for live PAPER operation.

## Sprint 2.5 — Intelligence and quote foundation (partial)

- [x] Persist queried-wallet token balance outflows and identify repeated patterns without claiming fraud.
- [x] Add normalized launch behavior contracts/analyzer with as-of filtering, independent buyer estimates, explicit completeness and unknown outcomes.
- [x] Add exact-in quote contracts, persistent quote records, a quote-only Jupiter adapter with request pacing/budgets, Helius-backed Pump curve and canonical PumpSwap state loaders, and official SDK quote calculations validated against recorded mainnet state snapshots.
- [x] Add explicit validated-holder-sample coverage policy while keeping exhaustive holder completeness false.
- [ ] Validate PumpPortal trade message schema and wire the metered stream manager, expiry, budget and reconnection lifecycle.
- [ ] Validate the actual PumpPortal trade payload contract and implement metered subscribe/unsubscribe lifecycle, expiry, event budgets, reconnection coverage, and persistence. The configured key's subscription attempt was denied at the linked-wallet funding gate on 2026-11-01.
- [ ] Run a complete token-to-behavior-to-buy/sell-quote pipeline with live normalized trade observations and fresh live state. Helius and PumpPortal free-feed access plus one Pump curve and one PumpSwap state were verified on 2026-11-01; migration was not observed, trade streaming was denied, and Jupiter credentials are absent.

**Status:** discovery-to-state-backed-quote components are implemented and quote vectors from recorded mainnet state pass. Acceptance is not met: the worker has no real normalized trade observations or complete launch behavior window, migration capture is missing, and no end-to-end live evidence-backed decision or `BUY_ELIGIBLE` result is claimed. Do not start PAPER until these gates pass.

## Sprint 4 — Dashboard + operations

- [ ] REST/SSE API, overview, tokens, creator detail, decisions, paper portfolio.
- [ ] Safe config controls, mode as read-only active status and pending restart; admin pause.
- [ ] Alerts/metrics, backup/restore, provider quota monitoring.
- [ ] Deploy initial VPS service; observe real data under controlled costs.

**Done when:** system operates under disconnect, rate-limit and process restart; no secret leakage.

## Sprint 5 — Statistical evaluation

- [ ] Deterministic replay and shadow parameter experiments.
- [ ] Conservative PnL/latency/fee/slippage sensitivity reports.
- [ ] False-positive classification and historical evidence quality audits.
- [ ] Freeze and version candidate strategy rules.

**Done when:** result can be independently reconstructed from event + quote + config snapshots; claims accurately represent limits.

## Sprint 6 — LIVE readiness (separate future approval)

- [ ] Separate signer and live executor deployment.
- [ ] Arming CLI, isolated secrets, preflight/reconciliation and kill switches.
- [ ] Security review and very small bounded canary; no automatic rollout.

**Done when:** `09-LIVE-READINESS.md` criteria satisfied and explicit operator authorization recorded.

---
