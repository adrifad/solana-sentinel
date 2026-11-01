# 14 — Implementation Roadmap / Work Breakdown

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

- [ ] Price adapters for Pump curve and migrated PumpSwap; authoritative state+SDK.
- [ ] Fresh exact-input buy and sell quotes, quote lifecycle + fee model.
- [ ] Virtual SOL wallet, ledger and positions, no phantom sells.
- [ ] Execution latency/slippage model; edge cases.
- [ ] Strategy FAST vs VALIDATED, partial exit, time stop, confidence reporting.

**Done when:** 100 fixture scenarios pass; no paper trade changes chain balances.

## Sprint 2.5 — Intelligence and quote foundation (partial)

- [x] Persist queried-wallet token balance outflows and identify repeated patterns without claiming fraud.
- [x] Add normalized launch behavior contracts/analyzer with as-of filtering, independent buyer estimates, explicit completeness and unknown outcomes.
- [x] Add exact-in quote contracts, persistent quote records, a quote-only Jupiter adapter with request pacing/budgets, and Pump official SDK bonding-curve calculations for caller-supplied verified state.
- [x] Add explicit validated-holder-sample coverage policy while keeping exhaustive holder completeness false.
- [ ] Validate PumpPortal trade message schema and wire the metered stream manager, expiry, budget and reconnection lifecycle.
- [ ] Wire a budgeted Helius state loader for Pump bonding curves, implement PumpSwap pool/vault state quotes, and validate both against on-chain snapshots.
- [ ] Run a complete token-to-behavior-to-buy/sell-quote pipeline with fresh live provider snapshots; current environment has no Helius, PumpPortal, or Jupiter credentials.

**Status:** foundation contracts and isolated quote calculations are implemented, but acceptance is not met; no live quote or `BUY_ELIGIBLE` result is claimed. Do not start PAPER until the remaining quote/state and streaming items pass.

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
