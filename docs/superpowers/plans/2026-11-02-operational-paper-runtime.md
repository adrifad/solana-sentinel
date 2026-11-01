# Operational PAPER Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the existing signer-free PAPER ledger and quote engine to a bounded runtime while keeping automatic entries blocked unless genuine, time-valid market evidence is available.

**Architecture:** Keep discovery and analysis in the current worker. Add a read-only Helius standard WebSocket trade observer that decodes only the pinned Pump program's documented `TradeEvent` log layout; persist verified observations with permanently conservative coverage status until reconciliation proves continuity. Compose the existing PAPER engine in the worker only for explicit `APP_MODE=PAPER`, and add durable position marks/exit retries without adding any signer or sender dependency.

**Tech Stack:** TypeScript strict, Zod, `ws`, Helius JSON-RPC/WebSocket, Pump SDK 4.1.0 IDL, SQLite migrations, Node test runner.

---

## Audit findings at `bbb5b0e329c0f3242d72764ce9ed17ed40dbac16`

- **IMPLEMENTED AND VERIFIED:** PumpPortal create/migration discovery; Helius bounded RPC; creator/security reports; Pump/PumpSwap quote loaders; atomic virtual ledger; quote-at-arrival PAPER engine; SELL safeguards; deterministic restart and accounting tests.
- **IMPLEMENTED BUT NOT INTEGRATED:** `PaperTradingEngine`, `PumpVenuePaperQuoteProvider`, wallet initialization, exit evaluator, and portfolio marks are absent from worker dependencies/composition.
- **PARTIALLY IMPLEMENTED:** Canonical `LaunchTradeObservation` storage and behavior analysis exist, but there is no production trade producer or verified coverage source. Current DRY_RUN decisions remain fail-closed for incomplete launch behavior.
- **BLOCKED BY EXTERNAL PROVIDER:** PumpPortal metered trade feed previously denied activation at the linked-wallet funding gate; its public contract documents subscribe methods and cost but not trade payload fields. Do not activate/fund it.
- **MISSING:** PAPER runtime mode, worker order orchestration, autonomous position monitor/retry state, separate readiness dimensions, detailed runtime latency metrics, candidate prioritization.
- **UNSAFE TO ENABLE AUTOMATIC ENTRIES:** No complete real trade-observation window is currently provable. Keep entry eligibility fail-closed even after PAPER mode can start.

## Implementation tasks

### Task 1: Read-only trade observation provider

**Files:** `packages/providers/src/helius-trades.ts`, `packages/providers/src/index.ts`, `packages/domain/src/index.ts`, `tests/helius-trades.test.ts`.

- [x] Implement one Helius standard WebSocket connection with `logsSubscribe` per eligible mint, expiry, cap, reconnect/resubscription, and explicit gap notifications. WebSocket processing is synchronous and frame-size bounded.
- [x] Parse only successful Pump bonding-curve `TradeEvent` logs from the pinned SDK 4.1.0 layout and verify notification signature/slot/error fields. Unknown event versions and unsupported quote mints are omitted.
- [x] Add injected socket and event-budget functions; synthetic decoder and reconnect-gap tests pass. Event-budget exhaustion/cap coverage should receive additional focused tests.

### Task 2: Persistent trade coverage and behavior

**Files:** `packages/storage/migrations/009-paper-runtime.sql`, `packages/storage/src/index.ts`, `apps/worker/src/main.ts`, `apps/worker/src/analysis.ts`, `tests/hardening.test.ts`, `tests/analysis-pipeline.test.ts`.

- [x] Persist per-mint coverage windows and provider gaps. A socket session alone is `UNVERIFIED`; no code path promotes it to `COMPLETE`.
- [x] Persist deduplicated decoded trade observations with source, signature, slot, event index, block timestamp, and receive time. Requeue analysis after the observation window ends.
- [x] Keep BUY decisions blocked when coverage or behavior is incomplete; existing look-ahead and incomplete-window tests pass.

### Task 3: PAPER configuration and worker composition

**Files:** `packages/config/src/index.ts`, `config/default.yaml`, `apps/worker/package.json`, `apps/worker/src/main.ts`, `packages/paper/src/index.ts`, `tests/config.test.ts`, `tests/paper.test.ts`.

- [x] Permit only `DRY_RUN` or `PAPER`; preserve the YAML DRY_RUN default and make `APP_MODE` an explicit validated override. `LIVE` remains rejected.
- [x] Compose the existing Helius-backed quote provider when available, virtual account, engine, and durable order recovery only in PAPER mode.
- [x] Add idempotent entry orchestration with freshness, config-version, security, behavior, and coverage gates. `COMPLETE` coverage is unavailable today so automatic entries remain blocked.
- [x] Existing engine tests plus a new runtime wallet/restart test verify virtual-only operation and no quote/no fill; full application-mode integration still needs an API-capable CI run.

### Task 4: Durable position monitoring and exits

**Files:** `packages/storage/migrations/009-paper-runtime.sql`, `packages/storage/src/index.ts`, `packages/paper/src/index.ts`, `apps/worker/src/paper-runtime.ts`, `apps/worker/src/main.ts`, `tests/paper.test.ts`.

- [x] Preserve position open time and expose active positions from storage.
- [x] Add a bounded monitor that obtains fresh sell quotes, records marks, applies stop-loss/take-profit/max-hold policy, and submits only virtual SELL intents through the same atomic engine.
- [x] Persist `UNPRICEABLE`/`EXIT_BLOCKED`, retry count and next retry time; use bounded backoff and do not change balances when quotes are absent/stale.
- [x] Existing deterministic tests cover engine restart, migration during pending execution, partial/full sells, no liquidity, and duplicate settlement. Runtime threshold-triggered exit needs a dedicated integration test.

### Task 5: Readiness, timing, documentation and validation

**Files:** `apps/api/src/server.ts`, `apps/worker/src/main.ts`, `packages/storage/src/index.ts`, `docs/05-TRADING-MODES.md`, `docs/08-PAPER-EXECUTION.md`, `docs/11-API-DASHBOARD.md`, `docs/12-TESTING-ACCEPTANCE.md`, `docs/14-IMPLEMENTATION-ROADMAP.md`, `docs/IMPLEMENTATION-STATUS.md`, `LOCAL_TEST_REPORT.md`.

- [x] Expose process/provider/data/analysis/PAPER execution readiness separately and list concrete blockers.
- [x] Persist analysis stage timing and calculate p50 plus p95/p99 when sample thresholds are reached. Order and quote timestamps remain available from PAPER records.
- [ ] Direct TypeScript, lint, format, docs, and migration checks pass; 13 non-API test files pass. API integration test cannot bind loopback in this sandbox (`listen EPERM`). No live provider validation was run and the configured DB was not opened.
- [ ] Report external trade-stream access and coverage as blocked/unverified unless live evidence proves otherwise; do not claim PAPER_READY from fixtures.
