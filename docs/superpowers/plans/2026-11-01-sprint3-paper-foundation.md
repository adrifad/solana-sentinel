# Sprint 3 PAPER Foundation Implementation Plan

> **For agentic workers:** Execute inline with testable checkpoints. Steps use checkbox syntax for tracking.

**Goal:** Add an isolated, deterministic PAPER execution foundation while keeping the application runtime DRY_RUN-only until its live trade-observation acceptance gate passes.

**Architecture:** Keep market data and quotes in `packages/providers`, execution math and order orchestration in a new signer-free `packages/paper`, and atomic durable account/order/journal state in `packages/storage`. A PaperQuoteProvider must fetch quotes after simulated latency; storage accepts a fill only once, after validating its quote and applying balance and risk constraints in a single SQLite transaction. Do not change `AppConfig.mode` or worker mode selection from DRY_RUN.

**Tech Stack:** TypeScript strict, Zod domain contracts, bigint raw amounts, SQLite migration 007, Node test runner, existing Pump SDK quote adapters.

---

### Task 1: Domain contracts and safe configuration arithmetic

- [x] Add a validated PAPER order intent and typed account/order/position/ledger/portfolio contracts with integer-string raw amounts and quote evidence references.
- [x] Add decimal SOL-to-lamports conversion that rejects precision beyond 9 places and never uses floating point.
- [x] Keep active application mode constrained to DRY_RUN; prove `APP_MODE=PAPER` remains rejected.

### Task 2: Atomic persistent paper account and journal

- [x] Add migration 007 for paper accounts, idempotent orders, append-only double-entry ledger journals, fills, positions, daily risk marks, and uniqueness constraints.
- [x] Add storage methods to create one initial-balance journal, create/recover pending orders, and atomically accept/reject fills.
- [x] Check each journal balances to zero per asset; reject negative SOL or token wallet balance, duplicate fill, limit breach, or invalid status transition.
- [x] Test database reopen, interrupted pending orders, uniqueness, and balance conservation; ledger records are immutable.

### Task 3: Quote-at-arrival simulation and risk/position services

- [x] Add `packages/paper` with no signer or transaction dependencies and injected clock, wait function, quote source, and repository.
- [x] Apply configured simulated delay before requesting a new quote; never reuse signal quote.
- [x] Simulate conservative output slippage with bigint arithmetic; include network and venue fees in journal/fill provenance.
- [x] Support idempotent BUY and partial-position SELL orders; no quote or failed sell means no fill/proceeds.
- [x] Add exposure/open-position/daily-loss/drawdown gates, sell-quote PnL marks, and time/stop/take-profit exit policy evaluation.
- [x] Keep worker/API disconnected from this package and leave automatic entries disabled until Milestone A passes.

### Task 4: Deterministic regression coverage

- [x] Test all-or-nothing swap fills, partial exits, duplicate order/fill, conservation, insufficient funds/tokens, unavailable and stale quotes, quote refresh after latency, venue migration, fee/slippage precision, daily loss/drawdown, restart recovery, and expired/future intent handling.
- [x] Assert DRY_RUN cannot activate PAPER through config and the paper package contains no signing or submission dependency.
- [x] Run strict typecheck, all tests, lint, formatting, docs checks, and fresh migration checks; remote CI remains a separate post-push check.

### Task 5: Trade-stream boundary and documentation

- [x] Preserve the normalized trade observation contract and keep unknown PumpPortal payload fields unparsed; no paid stream is enabled without a verified capture and enforceable budget.
- [ ] Implement the metered provider lifecycle after a sanitized payload capture validates its schema; the provider denied the configured linked wallet at its funding gate.
- [x] Document the provider funding/payload blocker, Milestone A status, PAPER library capabilities, mode remains disabled, and exact live-vs-fixture evidence.
- [ ] Push the implementation and report remote CI separately from local checks.

**Acceptance boundary:** PAPER foundation tests can pass while PAPER mode and automatic entries remain unavailable. Milestone A requires real normalized observations, coverage/gap tracking, a live quote and a persisted decision in one traced pipeline.
