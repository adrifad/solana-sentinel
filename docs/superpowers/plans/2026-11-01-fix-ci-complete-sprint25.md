# Fix CI and Continue Sprint 2.5 Implementation Plan

> **For agentic workers:** This plan is executed inline in the current session.

**Goal:** Fix the PumpPortal reconnect health race, then implement only provider-backed Sprint 2.5 work that can be validated safely and record unresolved live-provider gaps.

**Architecture:** Bind each socket callback to the concrete connection session that received it; only that current, open session may publish `HEALTHY`. Keep trade subscriptions on the existing single socket, behind explicit metered budget gates, and feed only validated normalized observations into storage and as-of launch analysis. Add venue quote support only from bounded, slot-stamped account state and official SDK calculations; otherwise return unknown/unsupported.

**Tech Stack:** Strict TypeScript, `ws`, Zod, SQLite migrations, Pump official SDKs, Helius JSON-RPC, Node test runner.

---

### Task 1: Reproduce and fix reconnect health race

**Files:** `packages/providers/src/pumpportal.ts`, `tests/hardening.test.ts`

- [ ] Bind queued events and callback status updates to the socket session that received them.
- [ ] Reject healthy transitions from a closed or superseded session.
- [ ] Add promise-based socket-open synchronization and preserve persisted-overflow/gap assertions.
- [ ] Run hardening tests repeatedly and the full suite.

### Task 2: Validate trade contract and subscription lifecycle

**Files:** `packages/providers/src/pumpportal.ts`, `packages/config/src/index.ts`, `config/default.yaml`, `packages/storage/migrations/007-*`, `packages/storage/src/index.ts`, worker analysis, tests and provider docs.

- [ ] Establish whether an actual sanitized trade capture and provider credentials exist.
- [ ] If available, decode only the captured schema; otherwise keep live subscription disabled and document the exact blocker.
- [ ] Preserve single socket, bounded subscription count, active duration, daily event budget, unsubscribe and reconnect state.
- [ ] Persist only validated normalized trade observations and recompute launch behavior as-of decision time.

### Task 3: Quote state acquisition and venue math

**Files:** Helius provider, quote provider, storage/config, tests, provider docs.

- [ ] Verify current official Pump curve and PumpSwap account layouts and quote functions.
- [ ] Add bounded, budgeted read-only account-state loading and slot/timestamp provenance.
- [ ] Add supported PumpSwap quotes from decoded pool/vault state with effective quote reserves and SDK fee behavior.
- [ ] Return `UNKNOWN` or `VENUE_UNSUPPORTED` when state, phase, quote mint, fees, or freshness cannot be validated.

### Task 4: Decision integration, checks and release evidence

**Files:** worker analysis, strategy/storage tests, README and `docs/IMPLEMENTATION-STATUS.md` / roadmap.

- [ ] Connect only complete behavior and fresh buy/sell evidence to DRY_RUN risk decisions.
- [ ] Run install, typecheck, tests, lint, format, docs, and fresh migration checks.
- [ ] Push the fix and verify the resulting GitHub Actions run; report remaining blockers without overstating integration evidence.
