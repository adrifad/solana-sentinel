# Zero-Trade Pipeline Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove verified runtime bottlenecks that prevent timely PAPER decision evaluation while preserving fail-closed evidence gates and the no-LIVE boundary.

**Architecture:** Keep durable risk decisions as the source of truth, trigger PAPER entry evaluation immediately after analysis persists a decision, and run entry scheduling independently from exit monitoring. Preserve the existing complete-coverage gate; partial coverage remains blocked until independently verified behavior and an explicitly separate experimental policy can be supported without changing decision semantics. Add bounded diagnostics for observed provider budget usage and report unavailable deployment/live evidence honestly.

**Tech Stack:** TypeScript strict, Node.js, SQLite migrations, `node:test`, existing Helius/PumpPortal abstractions.

---

### Task 1: Record reproducible baseline and environment boundary

**Files:**

- Read: `apps/worker/src/paper-runtime.ts`, `apps/worker/src/analysis.ts`, `packages/storage/src/index.ts`, `packages/providers/src/helius.ts`, `config/default.yaml`
- Test: existing repository suite and isolated SQLite migration checks

- [ ] Confirm `main` SHA, clean tree, local runtime environment, and whether the deployment checkout exists; never open the configured production database for tests.
- [ ] Record confirmed source defects and distinguish them from unavailable runtime observations.

### Task 2: Decouple automatic entries from position monitoring

**Files:**

- Modify: `apps/worker/src/paper-runtime.ts`
- Modify: `apps/worker/src/analysis.ts`
- Modify: `apps/worker/src/main.ts`
- Test: `tests/paper-runtime.test.ts`, `tests/analysis-pipeline.test.ts`

- [ ] Add a decision-persisted callback to analysis options and invoke it after durable decision persistence.
- [ ] Add a separately guarded entry wake-up path in `PaperRuntime`; retain the periodic monitor exclusively for positions.
- [ ] On restart, scan persisted current-config decisions so a crash between decision persistence and notification does not lose evaluation.
- [ ] Keep automatic entry disabled by default and retain current decision, coverage, signal-age, quote, and risk checks.
- [ ] Test prompt evaluation without waiting for the position monitor interval and verify duplicate wake-ups remain idempotent.

### Task 3: Diagnose and expose Helius request budget

**Files:**

- Modify: `packages/storage/src/index.ts`
- Modify: `packages/providers/src/helius.ts`
- Modify: `apps/api/src/server.ts`
- Test: provider/storage/API diagnostic tests

- [ ] Preserve the existing daily cap; add method-level request outcome accounting and expose used/remaining internal budget.
- [ ] Attribute request method, mint where safely available, result/error class, attempt, and UTC day. Do not claim Helius credit equivalence.
- [ ] Ensure RPC retry behavior remains bounded and clearly distinguish internal-budget exhaustion from HTTP 429/provider failure.

### Task 4: Replace discovery-order monitoring selection

**Files:**

- Add: next additive SQLite migration
- Modify: `packages/storage/src/index.ts`, `apps/worker/src/main.ts`, `config/default.yaml`, `packages/config/src/index.ts`
- Test: `tests/discovery.test.ts`, `tests/intelligence-storage.test.ts`

- [ ] Preserve all discovery events; represent active monitoring as expiring durable leases rather than a permanent first-N flag.
- [ ] Rank candidates deterministically using only evidence available at selection time, expire leases, and admit replacements fairly.
- [ ] Confirm lease expiration cannot make a missing quote or incomplete analysis actionable.

### Task 5: Bounded operational verification and documentation

**Files:**

- Modify: `docs/IMPLEMENTATION-STATUS.md`, `README.md`, provider/runtime docs
- Add: `ZERO_TRADE_DIAGNOSTIC_REPORT.md`

- [ ] Run automated checks, fresh migrations, and `PRAGMA integrity_check` only on temporary databases.
- [ ] Run provider probes only with configured credentials and strict request caps; never enable metered PumpPortal streams.
- [ ] Deploy only if an authorized deployment checkout/host is reachable; otherwise record deployment as blocked without modifying production state.
- [ ] Retain automatic PAPER entry disabled unless an independently validated evidence policy and explicit operator action satisfy their acceptance gates.

### Known gate kept closed

The current system cannot assert `COMPLETE` trade coverage because its Helius log subscription has no replay cursor and no validated exhaustive reconciliation contract. Do not turn coverage complete, waive missing verified observations, or promote `QUARANTINE` to `BUY_ELIGIBLE` to increase trade count. Experimental PAPER entry remains blocked until a separate decision contract and independently verified partial-observation policy are implemented and approved.
