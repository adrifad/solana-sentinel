# Sprint 2 Intelligence, Security, and DRY_RUN Decision Plan

> **For agentic workers:** Execute this plan inline in the current session. Steps use checkbox syntax for tracking.

**Goal:** Enrich every monitored launch with persisted, time-correct creator/wallet evidence, a fail-closed token security report, and an explainable DRY_RUN risk decision.

**Architecture:** Extend the current domain/provider/storage modules without changing runtime composition. Helius history requests use standard JSON-RPC calls behind the existing timeout, pacing, daily budget, and bounded scheduler. A deterministic analysis service reads only persisted evidence, parses only supported mint formats/extensions, persists immutable security and decision snapshots, and never accesses a signer or virtual wallet.

**Tech Stack:** Strict TypeScript, Zod, Node fetch, SQLite `node:sqlite`, versioned SQL migrations, Node test runner.

---

## Current State and Constraints

- `packages/providers/src/helius.ts` validates `getAccountInfo`, `getBlockTime`, `getHealth`, and `getGenesisHash`; it has no wallet history methods.
- `packages/storage/src/index.ts` persists discovery events and mint owner/status, but no role evidence, transaction history, creator reputation, mint decoded fields, security reports, or decisions.
- `apps/worker/src/enrichment.ts` is bounded and restart recoverable, but processes mint state/time only.
- Runtime configuration is DRY_RUN-only; PumpPortal and Helius credentials are absent from `.env.example` values. Do not claim live provider validation.
- PumpPortal does not publish an event schema. Preserve claimed creator, observed transaction fee payer, instruction user/initiator, and mint authority as separate role claims; unknown roles remain null/unknown.
- Historical reputation must be computed from observations at or before a supplied slot/time. A shared exchange funding source alone creates no wallet-control edge.
- Use only read-only Helius methods (`getSignaturesForAddress`, `getTransaction`, `getTokenSupply`, `getTokenLargestAccounts`, `getAccountInfo`, `getBlockTime`). Never import transaction/signing packages.

## File Map

- Modify `packages/domain/src/index.ts`: Zod contracts for evidence, wallet transactions, creator profile, token security, risk decisions, and DRY_RUN trade intents.
- Modify `packages/providers/src/helius.ts`: response-validated paged wallet signatures, parsed transaction retrieval, token supply/largest accounts; keep one per-call budget charge and bounded page/transaction limits.
- Add `packages/intelligence/src/index.ts`: attribution reconciliation, historical launch extraction only from recognized Pump program evidence, direct funding transfer edges with cautious confidence, reason-coded incremental reputation.
- Add `packages/intelligence/package.json` and add it to worker workspace dependencies.
- Add `packages/security/src/index.ts`: SPL Mint fixed-layout decoder, Token-2022 TLV parser with explicit supported extension IDs and fail-closed unknown critical extensions, risk statuses, concentration helper.
- Add `packages/security/package.json` and worker dependency.
- Add `packages/strategy/src/index.ts`: deterministic gate producing REJECT/QUARANTINE/WATCH/BUY_ELIGIBLE, where missing mandatory state cannot produce BUY_ELIGIBLE.
- Add `packages/strategy/package.json` and worker dependency.
- Modify `packages/storage/src/index.ts`; add `packages/storage/migrations/005-intelligence-security-decisions.sql` for immutable wallet observations, role evidence, launch history, links, reputation cache, security reports, and decisions.
- Add `apps/worker/src/analysis.ts`: bounded orchestration from persisted launch to creator refresh, security report, and decision snapshot.
- Modify `apps/worker/src/main.ts`: instantiate read-only analysis with configured limits, wake it from accepted monitored launch events, drain it before closing SQLite.
- Modify `packages/config/src/index.ts` and `config/default.yaml`: page size, per-wallet history cap, lookback cap, relationship thresholds, cache TTL, and supported-security freshness bounds.
- Modify `apps/api/src/server.ts`: read-only token intelligence/security/decision detail routes.
- Add `tests/intelligence.test.ts`, `tests/security.test.ts`, and `tests/decision.test.ts`; add provider/storage/restart integration cases to existing tests.
- Update `docs/IMPLEMENTATION-STATUS.md`, `docs/03-PROVIDER-INTEGRATIONS.md`, `docs/06-DISCOVERY-FORENSICS.md`, and `docs/07-SECURITY-RISK.md` with verified behavior and explicit limits.

## Task 1: Read-only History Provider and Persisted Evidence

- [ ] Add Zod-validated Helius signature-page and transaction response contracts; reject malformed responses and enforce maximum page size.
- [ ] Add paginated `getSignaturesForAddress` and per-signature `getTransaction` with `finalized` commitment, transaction version 0 support, cancellation/deadlines, and existing request budget accounting.
- [ ] Add deterministic mocked provider tests for empty pages, cursor advancement, RPC errors/timeouts, malformed transactions, and budget exhaustion.
- [ ] Add migration 005 and repository methods to persist raw transaction summaries, observed signatures/slots/block time, role evidence, launch records, wallet-link evidence, reputation snapshots, security reports, and decisions with unique keys.
- [ ] Test migration from fresh and version-4 databases, idempotent re-ingestion, cache expiry, and process restart recovery.

## Task 2: Creator Attribution, Launch History, and Wallet Links

- [ ] Define role claims as `{role, wallet, source, signature, slot, observedAtUtc, confidence, reasonCode}`; derive fee payer from transaction's first required signer only when validated transaction account keys support it.
- [ ] Keep PumpPortal `creator` claim and `traderPublicKey` initiator distinct. Resolve a creator only from verified Pump instruction/event fields; otherwise persist `UNKNOWN` plus conflicting evidence.
- [ ] Recognize historical launch events only using a pinned official Pump IDL discriminator/account layout and successful transaction evidence. Store the IDL revision hash and source.
- [ ] Page bounded wallet history, persist every page cursor and transaction before advancing it, and recover interrupted refreshes without duplicate rows.
- [ ] Emit funding-link evidence only for an observed direct system transfer; shared exchange/program funders do not create identity links. Confidence represents observed edge evidence, never asserted ownership.
- [ ] Add tests for ambiguous roles, missing transaction metadata, incomplete pages, historical as-of cutoffs, common-funder false positives, and restart recovery.

## Task 3: Incremental Reputation

- [ ] Derive only countable facts from persisted launches and transaction evidence: observed launch count, repeat launch windows, and evidence-backed suspicious indicators.
- [ ] Keep `UNKNOWN` when history coverage is partial; expose completeness, earliest/latest observed slot, cache age, and evidence references.
- [ ] Recompute idempotently at a specified `asOfSlot` and timestamp; exclude later observations and never calculate profitability from incomplete trading history.
- [ ] Add bounded concurrency and request budgets around refresh work; cache results with configurable TTL and explicit stale status.

## Task 4: Mint Security and Holder Concentration

- [ ] Decode only exact supported SPL Token Mint layouts; validate owning program, account length, initialization state, decimals, supply, and nullable mint/freeze authorities.
- [ ] Decode Token-2022 account-type/TLV framing; maintain an explicit table of understood extensions. Unknown extensions are `UNSUPPORTED`, malformed data is `INVALID`, and missing RPC data is `UNKNOWN`.
- [ ] Treat unsupported transfer hooks, confidential balances, permanent delegate, default-frozen, non-transferable, or unknown policy-critical extensions as unsafe/quarantined according to documented policy; do not claim sellability without an execution quote provider.
- [ ] Fetch supply and a bounded largest-account sample through validated RPC methods; decode token-account owner/amount and calculate conservative observed top-holder and creator/cluster concentration using integer arithmetic.
- [ ] Report sampled concentration coverage and never imply the top-holder sample is a complete holder distribution.
- [ ] Add fixture tests for both base programs, valid/invalid TLV, unknown extensions, missing account, timeout, large integer values, and partial largest-account samples.

## Task 5: Explainable DRY_RUN Analysis Vertical Slice

- [ ] Generate an immutable creator report, token security report, and risk decision for each monitoring-eligible new token; persist report IDs, configuration hash, evidence refs, timestamps, and stage latency.
- [ ] Gate order: confirmed supported unsafe state → `REJECT`; missing/unsupported/stale required check or incomplete critical history → `QUARANTINE`; safe mandatory checks but no quote/observation strategy → `WATCH`; `BUY_ELIGIBLE` only if every mandatory check and independent strategy check passes.
- [ ] Keep the output `TradeIntent` signal-only with `mode: DRY_RUN`; no balances/positions/fills can be created.
- [ ] Add read-only API detail endpoints for creator evidence, security report, and decision history. Add restart, timeout, duplicate event, and ambiguous attribution integration tests.

## Task 6: Validation and Documentation

- [ ] Run `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check`, `pnpm docs:check`, fresh `pnpm db:migrate`, and `git diff --check`.
- [ ] Run the repository CI workflow-equivalent checks locally; report provider live checks only if credentials and live calls were actually made.
- [ ] Update implementation status with functionality, validation output, unresolved PumpPortal/Helius limits, security review, and next steps.

## Explicit Acceptance Limit

A full BUY_ELIGIBLE result is not supportable until mint layout, creator attribution, current token security, complete enough history, and an independent sell-route/exit check are present. With no quote adapter in this repository, the completed vertical slice may persist `WATCH`/`QUARANTINE`/`REJECT` only; this is the safe implemented behavior, not a reason to fabricate a trade signal.
