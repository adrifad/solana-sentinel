# Sprint 2.5B Provider and DRY_RUN Pipeline Implementation Plan

> **For agentic workers:** Required sub-skill: execute this plan inline with bounded checkpoints. Steps use checkbox syntax.

**Goal:** Add evidence-backed PumpPortal trade observation and market-state quote capabilities to the existing DRY_RUN pipeline, then validate configured providers and report any live-contract blockers.

**Architecture:** Preserve the existing provider, intelligence, storage, and worker boundaries. Normalize provider messages at the provider edge, persist observations idempotently, enforce subscription and RPC budgets before work is issued, and keep unsupported or incomplete state as UNKNOWN. No transaction signing, submission, paper fills, or fabricated prices are introduced.

**Tech Stack:** Strict TypeScript, Zod, Node.js WebSocket/fetch, SQLite migrations, existing Pump SDK dependencies, Node test runner, pnpm checks.

---

### Task 1: Establish verified contracts and baseline

**Files:**

- Inspect `AGENTS.md`, `README.md`, `docs/IMPLEMENTATION-STATUS.md`, `docs/14-IMPLEMENTATION-ROADMAP.md`, provider/security/execution docs, `config/default.yaml`, worker/provider/storage packages, migrations, and tests.
- Add tests only in the existing `tests/` layout; fixtures go under `tests/fixtures/` and contain public chain data only.

- [x] Record HEAD, worktree status, available env-key presence as booleans only, and CI-equivalent check results.
- [x] Compare PumpPortal and Helius response handling with current official provider documentation; record undocumented payload fields as unverified.
- [x] Keep `.env` ignored and never print or persist its contents.

### Task 2: Bounded PumpPortal trade lifecycle

**Files:**

- Modify `packages/config/src/index.ts` and `config/default.yaml` to accept `enable_token_trades: boolean` with safe default `false` and enforce existing subscription/event caps.
- Modify `packages/providers/src/pumpportal.ts` for strict trade normalization, dynamic subscribe/unsubscribe, UTC-day event accounting callback, expiry, reconnect resubscription, and explicit gaps.
- Modify `packages/storage/src/index.ts` and add a versioned migration for persistent trade budget/cursors only if existing tables cannot provide atomic accounting.
- Modify `apps/worker/src/main.ts` and `apps/worker/src/analysis.ts` to subscribe only eligible mints, persist deduplicated observations, compute time-valid behavior snapshots, and use them in decisions.
- Extend `tests/providers.test.ts`, `tests/storage.test.ts`, `tests/sprint25.test.ts`, and `tests/hardening.test.ts` with lifecycle, cap, expiry, duplicate, reconnect, incomplete-window, and restart cases.

- [ ] Write deterministic failing tests before implementation.
- [ ] Count every message received while trade subscriptions are active conservatively against the provider budget, including malformed trade candidates.
- [ ] Preserve active unexpired desired subscriptions through reconnect and send unsubscribe when expiry or budget exhaustion occurs.
- [ ] Never mark an observation complete across a disconnected stream interval.

### Task 3: Verified read-only market-state quotes

**Files:**

- Modify `packages/providers/src/quotes.ts` and add focused provider modules under `packages/providers/src/` for Pump curve/PumpSwap account loading.
- Reuse current SDK dependencies and Helius request-budget enforcement; add direct dependency declarations only for imported libraries.
- Modify `packages/domain/src/index.ts` only for evidence fields needed to report fee components and state freshness.
- Add deterministic account/quote vectors to `tests/fixtures/` with provenance and slot, and tests in `tests/quotes.test.ts`.

- [x] Verify account layouts, PDA derivation, fee handling, and SDK behavior against current official SDK source and recorded mainnet snapshots before parsing account bytes.
- [x] Fetch related state in bounded Helius batches and validate owner, mint pair, venue phase, and slot coherence.
- [x] Return explicit unsupported/missing/stale/unsafe failures; do not construct quotes from last trade price.
- [x] Use integer-safe quote amounts and reject insufficient PumpSwap sell liquidity; continue broadening live vectors.

### Task 4: Evidence-backed pipeline integration

**Files:**

- Modify `apps/worker/src/analysis.ts` to connect stored behavior snapshots and supported market quote engines to existing security, exit validation, and risk decision evaluation.
- Modify `packages/storage/src/index.ts` only where quote/decision evidence cannot already be persisted atomically and audibly.
- Add regression cases for unknown behavior, incomplete snapshots, stale quotes, unsupported venues, and mandatory-security failures.

- [x] Persist supporting quote IDs and behavior snapshot ID when present, plus reason codes, configuration version, and analysis timestamps in decision evidence.
- [x] Keep BUY_ELIGIBLE gated by mandatory conditions; incomplete provider evidence remains quarantined/rejected.
- [x] Verify runtime quote path is read-only and signing/submission remains outside scanner/strategy/dashboard.

### Task 5: Live validation, documentation, and release checks

**Files:**

- Add a bounded opt-in provider validation command under `scripts/` and a package script; it reports credential presence only, sanitizes capture output, and has fixed time/event caps.
- Update `README.md`, `docs/IMPLEMENTATION-STATUS.md`, provider/security/testing docs, and roadmap status with verified behavior and unresolved live gates.
- Add sanitized real fixtures only when captured from an actual mainnet session; mark synthetic contract fixtures distinctly.

- [x] Validate available creation and Helius responses; record that no migration/trade event arrived/was accessible and keep undocumented fields unverified.
- [x] Run `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check`, `pnpm docs:check`, migration checks, and CI-equivalent commands.
- [ ] Review `git diff --check`, secret scans, and `git status`; commit and push only intended changes to `main`.
- [ ] Report actual tests, provider evidence, costs/budgets, limitations, and Sprint 3 PAPER readiness without claiming unsupported acceptance gates.

**Known acceptance gap:** A real trade or migration event may not arrive inside a bounded validation session. In that case, fixture-backed tests and implementation can be complete while live contract validation and Sprint 2.5B acceptance remain open.
