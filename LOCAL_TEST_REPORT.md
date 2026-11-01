# Solana Sentinel Local Integration Test Report

**Test date:** 2026-11-01 (UTC)  
**Repository:** `adrifad/solana-sentinel`  
**Branch / commit:** `main` / `faf699855eb6e76398ea657c62ebd34796bbe165`  
**Scope:** Read-only audit and local runtime test. No application code or production database was modified. No metered trade stream, signer, transaction submission, or PAPER runtime was enabled.

## Environment and safety

| Check                             | Result | Evidence                                                                                                                                                                         |
| --------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git worktree before report        | PASS   | Clean at the tested commit.                                                                                                                                                      |
| Node / pnpm                       | PASS   | Node `v26.8.1`; pnpm `11.3.0`.                                                                                                                                                   |
| Dependencies                      | PASS   | `pnpm install --frozen-lockfile`.                                                                                                                                                |
| Configured `.env` database target | PASS   | `DB_PATH` was configured, but its target did not exist. It was not opened.                                                                                                       |
| Test database                     | PASS   | Runtime and migration used `/tmp/solana-sentinel-audit.sqlite`; migration-only check used `/tmp/solana-sentinel-local-audit.sqlite`.                                             |
| Credentials                       | PASS   | Helius and PumpPortal variables present; Jupiter variable missing. Values were never displayed.                                                                                  |
| Runtime mode                      | PASS   | Worker and API reported `DRY_RUN`; configuration rejects `APP_MODE=PAPER` and `LIVE`. `enable_token_trades` is hard-coded false by the config schema.                            |
| Signing / submission isolation    | PASS   | No `Keypair`, `signTransaction`, `sendTransaction`, `VersionedTransaction`, or Jupiter `/execute` references found in worker, API, paper, strategy, or provider runtime sources. |
| Database integrity                | PASS   | Read-only `PRAGMA integrity_check` returned `ok`; migrations 1–7 present.                                                                                                        |

## Automated checks

| Command                                         | Result                     |
| ----------------------------------------------- | -------------------------- |
| `pnpm install --frozen-lockfile`                | PASS                       |
| `pnpm typecheck`                                | PASS                       |
| `pnpm test`                                     | PASS — 68/68               |
| `pnpm lint`                                     | PASS                       |
| `pnpm format:check`                             | PASS                       |
| `pnpm docs:check`                               | PASS                       |
| `pnpm build`                                    | PASS                       |
| Fresh `pnpm db:migrate` with isolated `DB_PATH` | PASS — schema versions 1–7 |
| `git diff --check`                              | PASS                       |

## Provider validation

| Stage                                                       | Status               | Observation                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Helius health and mainnet genesis                           | PASS                 | `getHealth` and `getGenesisHash` succeeded; genesis matched mainnet using a 2-request budget.                                                                                                                                                                                                                                      |
| Existing sanitized PumpPortal create capture against Helius | PASS                 | Finalized transaction at slot `464002088`; mint matched; decoded Pump CreateEvent contained the mint and creator; provider `traderPublicKey` matched transaction fee payer for this event. This validates the captured event only.                                                                                                 |
| PumpPortal WebSocket connectivity                           | PASS                 | One socket connected and reached `HEALTHY` during worker smoke test. No metered trade methods were requested.                                                                                                                                                                                                                      |
| PumpPortal free-feed event observation                      | PASS / PARTIAL       | Worker persisted one live `TOKEN_MIGRATED` event. A separate safe-shape probe normalized one live `create` event in memory; that probe intentionally did not persist it. A separate 10-second free-feed-only window observed zero events (`NOT OBSERVED`).                                                                         |
| Migration signature / on-chain slot                         | PASS                 | Persisted migration signature resolved through Helius to a successful transaction at slot `464027585`; mint appeared in transaction accounts. Helius block time was `2026-11-01T08:38:21Z`. The PumpPortal payload and stored event had no slot, so the worker token still has `migrationSlot: null`.                              |
| Migration creator attribution                               | NOT TESTED           | The observed migration payload had no normalized creator or launch initiator. No creator ownership was inferred from the migration transaction.                                                                                                                                                                                    |
| PumpPortal trade stream                                     | BLOCKED / NOT TESTED | No metered stream was attempted in this audit. `enable_token_trades` is false. Earlier provider validation recorded denial at the linked-wallet funding gate; current PumpPortal docs require at least `0.02 SOL` on the linked wallet and charge `0.01 SOL` per 10,000 streamed messages. No trade payload contract is available. |
| Provider harness, all providers                             | BLOCKED              | `pnpm validate:providers --seconds=10` exited with safe code `REQUEST_BUDGET_EXHAUSTED` at its 4-request Helius cap (the Helius client can retry transient failures). Follow-up Helius probes were separately bounded and succeeded.                                                                                               |
| Reconnect during runtime                                    | NOT OBSERVED         | The runtime socket had zero reconnects. Automated reconnect and gap tests passed.                                                                                                                                                                                                                                                  |

The live worker initially recorded three `MALFORMED_EVENT` provider issues, then returned to `HEALTHY`. A shape-only probe showed the corresponding non-event frames had top-level `errors` or `message` fields and no `mint`; one later frame was a valid `create` event. The parser currently sends every JSON object through the market-event parser, which reports these control/error frames as malformed market events. No raw payload values were logged or saved by the probe.

## DRY_RUN worker and API

- Worker startup: **PASS**. Helius health was healthy, PumpPortal connected, and the worker logged `mode: DRY_RUN`.
- Discovery persistence: **PASS** for the observed migration. One event and one token were present after shutdown. Event signature: `2Kh15Ed5g7SRD1j41cV3zSqAfpi2p1puVQHDUuYFmH5RdwjrbPvuCwUaDJJvZYGNvYGRvsVTLJZbE5g4JiGYNZEz`.
- Duplicate handling: **NOT OBSERVED** in the live window; deterministic duplicate/idempotency tests passed.
- Creator intelligence, security report, and risk decision: **NOT TESTED** for the observed token. It was a migration-only event: `analysis_jobs=0`, security reports `0`, decisions `0`. The persisted token has creator/initiator `null`, mint state `UNKNOWN`, and phase `MIGRATED_UNKNOWN_VENUE`.
- Quote evidence: **NOT TESTED** in this worker run; the migration token was not assigned a supported venue. No quote was fabricated.
- API startup and read-only GET routes: **PASS**. `/health`, `/ready`, `/api/tokens`, and token detail responded locally. `/ready` became true while completeness still reported `PROVIDER_ISSUES` and `historyComplete=false`; this endpoint currently indicates fresh socket health, not full analysis/trading readiness. API write rejection is covered by the automated test suite.
- Graceful shutdown: **PASS**. Worker wrote `STOPPED` and `worker.stopped`; API exited cleanly.
- Restart recovery: **PASS**. Reopening the isolated database retained the one token/event and all seven migrations. `PRAGMA integrity_check` remained `ok`.
- Completeness: correctly remained unclaimed (`historyComplete=false`). No stream gap was observed in this short run.

The isolated worker configuration capped Helius at 12 requests for the UTC day, with one concurrent enrichment. Its persisted budget showed 2 requests used (health and genesis); no creator/security analysis job was generated for the migration-only event.

## Quote engine verification

All figures below are deterministic SDK calculations against checked-in Helius account-state captures, not executable fills or current-time quotes. The corresponding tests passed in `pnpm test`.

| Venue / captured state                              | Exact input and output                                                                                      | Fees / impact                                                                                                    | Result                                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Pump bonding curve, slot `464003571`                | BUY `50,000,000` lamports → `735339457766082` raw token units. SELL of that output → `13,639,617` lamports. | BUY fee `617,285` lamports; impact `5682` bps. SELL fee `172,654` lamports; impact `3681` bps.                   | SDK quote calculations PASS; both exceed the configured `300` bps risk ceiling, so they cannot authorize entry. |
| Canonical PumpSwap, slot `464004463`, slot skew `0` | BUY `50,000,000` lamports → `271345233855` raw token units. SELL of that output → `48,726,222` lamports.    | BUY fee `617,286` lamports; impact `127` bps. SELL fee `616,790` lamports; impact `128` bps.                     | SDK quote calculations PASS for the recorded state.                                                             |
| Stale, unsupported, or unavailable exit state       | Covered by deterministic tests.                                                                             | Stale Pump state fails; unsupported/migrated curve and unavailable sell liquidity do not produce passing quotes. | PASS for fail-closed behavior.                                                                                  |

No current-state quote was requested during the worker run. A successful SDK quote calculation must not be described as a real executable fill.

## PAPER foundation and targeted diagnostics

The PAPER package was tested independently; application mode remained `DRY_RUN`. The 68-test suite passed, including virtual balance/ledger conservation, concurrent idempotency, partial exits, fee/slippage accounting, restart recovery, risk marks, and missing/stale quote cases. The existing test `missing or stale sell quote leaves token position and SOL untouched` passed. Ledger rows are immutable and each journal balances per asset.

Two temporary, fixture-only diagnostics confirmed risk-control defects without changing application behavior:

1. **Profitable sell rejected by max trade size — CONFIRMED.** With `maxTradeInputRaw=1.2 SOL`, a valid sell quote of `1.5 SOL` (net simulated output `1.4925 SOL` after 50 bps modeled slippage) was rejected as `PAPER_MAX_TRADE_EXCEEDED`; the token position remained open. The comparison is in [storage](packages/storage/src/index.ts#L1462). This prevents a risk-reducing exit whenever gross SOL proceeds exceed the buy-size cap.
2. **Emergency pause rejects risk-reducing sells — CONFIRMED.** With `emergencyStop=true`, a sell intent was rejected as `PAPER_EMERGENCY_STOP` before requesting a quote; the position remained unchanged. The unconditional gate is in [paper engine](packages/paper/src/index.ts#L208) and the transactional storage guard is in [storage](packages/storage/src/index.ts#L1451).

The diagnostic quotes were synthetic test inputs used only to exercise policy branches. They are not market observations, fill evidence, or performance claims. No production behavior was changed.

## Milestone matrix

| Milestone / stage                                  | Status                              | Reason                                                                                                                                          |
| -------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A — Live token discovery                           | PARTIAL                             | One migration was persisted and one create was normalized in a separate probe; no continuous discovery window or migration recovery was tested. |
| A — Verified creator intelligence                  | NOT TESTED                          | The persisted migration had no creator/initiator evidence and generated no analysis job.                                                        |
| A — Token security                                 | NOT TESTED                          | No security report was generated for the observed migration.                                                                                    |
| A — Normalized trade observations                  | BLOCKED                             | Metered stream remains disabled; no trade payload was received or validated.                                                                    |
| A — Complete launch behavior                       | BLOCKED                             | No real trade observations or uninterrupted observation coverage.                                                                               |
| A — Fresh quote and exit validation                | NOT TESTED end-to-end               | Recorded state-backed quote tests pass, but this runtime token had unknown venue and no quote record.                                           |
| A — Persisted evidence-backed risk decision        | NOT TESTED                          | No analysis/decision was generated for the migration-only event.                                                                                |
| **Milestone A — DRY_RUN end-to-end**               | **FAIL / INCOMPLETE**               | Pipeline was not demonstrated from live discovery through trade observation, quote, and persisted decision. Do not claim end-to-end PASS.       |
| B — Isolated PAPER wallet/orders/ledger/fills      | PASS (foundation tests)             | Deterministic tests pass for initialization, atomic all-or-nothing fills, idempotency, double-entry accounting, and restart recovery.           |
| B — Partial exits and PnL                          | PASS (fixture tests)                | Partial token exits and realized PnL are covered; unrealized marks and risk limits are exercised. This is not a live-market execution test.     |
| B — Safe exits under max-trade and emergency pause | FAIL                                | Both tested policy branches can prevent risk-reducing sells.                                                                                    |
| **Milestone B — PAPER foundation**                 | **PASS with critical risk defects** | Accounting foundation passes tests, but sell-limit and emergency-pause behavior must be corrected before operational PAPER.                     |

## Prioritized fixes and readiness

1. Correct the max-trade policy for sells so a buy-size cap cannot strand a position; preserve explicit order/exposure limits and test profitable and loss-reducing exits.
2. Make emergency pause stop new risk-increasing buys while still allowing validated sell/close operations; test with available, stale, and missing exit quotes.
3. Handle PumpPortal subscription acknowledgements/control/error frames separately from market events. Do not report them as `MALFORMED_EVENT`; validate provider errors and leave health degraded only for a genuine provider fault.
4. Resolve and persist Helius slot/time provenance for migration events when their signature is valid, while keeping creator attribution unknown unless instruction evidence supports it.
5. Define readiness states separately for socket freshness and analysis/completeness; the current `/ready` can be true while history is incomplete and provider issues are recorded.
6. Obtain provider-authorized trade access and a sanitized real payload capture. Then implement metered subscription budgets, lifecycle/reconnect coverage, deduplication, and continuous observation windows before enabling behavior-based decisions.
7. Demonstrate one live token through verified creator/security analysis, trade observations, fresh venue quotes, exit validation, and a persisted DRY_RUN decision. Keep automatic PAPER entries disabled until then.

**PAPER operational readiness: NOT READY.** The isolated PAPER foundation is testable, but the two confirmed sell-control defects and the incomplete Milestone A data path are blockers. No live swap, signing, or transaction submission occurred.

---

## Sprint 3.1 follow-up — runtime hardening and migration recovery

This follow-up supersedes the baseline findings above for the defects fixed in Sprint 3.1. The original audit records the behavior observed at commit `faf699855eb6e76398ea657c62ebd34796bbe165`; it remains unchanged as historical evidence. The current source was validated from that baseline with the changes in this worktree.

### Fixes and regression coverage

- Migration events now enter durable recovery and analysis queues distinct from creation events. When the event has no slot, Helius resolves its signature and the worker verifies the requested signature, successful transaction, matching mint participation, safe chain slot, and agreement with any provider slot before atomically updating the event slot, token migration slot/phase, checkpoint, and job state.
- A bounded live worker run observed a real PumpPortal migration event with no provider slot. Helius verified its transaction at slot `464032830`; that slot and `MIGRATED_UNKNOWN_VENUE` were persisted. The migration event did not acquire a creator from its provider-reported trader wallet. Migration-first analysis persisted an explicit incomplete report and `QUARANTINE` decision because the test run's intentionally small Helius request budget ran out before security checks completed.
- Restart recovery, failed transactions, mismatching signatures/slots, unrelated mints, and duplicate migration-job handling are covered by deterministic tests. No sanitized migration fixture was committed, so the live migration payload's general role semantics remain unverified.
- PAPER BUY limits now cap new exposure only. A validated SELL may return proceeds above the BUY cap and remains constrained by held token balance, fresh quote, available liquidity, settlement idempotency, fee/slippage accounting, and atomic ledger checks. The legacy `risk.emergency_pause` setting pauses BUY entries while allowing valid risk-reducing SELLs. Emergency liquidation remains unimplemented.
- PumpPortal frames are dispatched as token events, provider errors, provider controls, unsupported frames, or malformed frames. Sanitized bounded diagnostics are persisted and surfaced in read-only health. Unknown provider messages remain errors rather than acknowledgements.
- A real-worker run exposed a BigInt JSON serialization failure in historical Pump CreateEvent summaries. Serialization now converts the timestamp to its decimal string form; a regression test covers the path.

### Follow-up validation results

| Check                                                       | Result               | Evidence                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                            | PASS                 | Lockfile installation completed.                                                                                                                                                                                                                                                                                                                                  |
| `pnpm typecheck`                                            | PASS                 | TypeScript reported no errors.                                                                                                                                                                                                                                                                                                                                    |
| `pnpm test`                                                 | PASS — 77/77         | Includes migration recovery, restart, frame classification, SELL gates, pause behavior, ledger checks, and BigInt serialization regressions.                                                                                                                                                                                                                      |
| `pnpm lint`                                                 | PASS                 | ESLint completed with no findings.                                                                                                                                                                                                                                                                                                                                |
| `pnpm format:check`                                         | PASS                 | Prettier check passed.                                                                                                                                                                                                                                                                                                                                            |
| `pnpm docs:check`                                           | PASS                 | README local references passed.                                                                                                                                                                                                                                                                                                                                   |
| `pnpm build`                                                | PASS                 | `tsc --noEmit` completed.                                                                                                                                                                                                                                                                                                                                         |
| `git diff --check`                                          | PASS                 | No whitespace errors.                                                                                                                                                                                                                                                                                                                                             |
| Fresh `pnpm db:migrate`                                     | PASS                 | Isolated `/tmp/solana-sentinel-sprint31-final-migration.sqlite`; versions 1–8, `provider_slot` present, `PRAGMA integrity_check=ok`.                                                                                                                                                                                                                              |
| GitHub Actions CI                                           | PASS                 | Run [41291425905](https://github.com/adrifad/solana-sentinel/actions/runs/41291425905) passed for implementation commit `995d1bded478497705c70348881d0aa3d25ee372`.                                                                                                                                                                                               |
| Bounded real PumpPortal/Helius validation                   | PARTIAL              | Helius mainnet health/genesis and historical transaction/account reads passed within the configured four-request provider harness. PumpPortal free feed connected and emitted create events; one short window observed zero migrations (`NOT OBSERVED`). No metered trade stream was activated by this harness.                                                   |
| Bounded real worker session                                 | PASS / PARTIAL       | Worker started in DRY_RUN, persisted live create/migration events, classified provider errors/control frames, resolved the migration at slot `464032830`, produced persistent fail-closed decisions, and shut down cleanly. Security analysis was incomplete after the deliberately low Helius budget was exhausted. SQLite integrity check passed after restart. |
| Real-time trade payload and continuous observation coverage | BLOCKED / NOT TESTED | No metered trade subscription was activated; provider entitlement/funding gate remains unresolved. No normalized live trade observations or complete behavior window were demonstrated.                                                                                                                                                                           |
| Application PAPER mode / real transactions                  | NOT ENABLED          | `APP_MODE` remains DRY_RUN-only; no signer or transaction-submission path was added or invoked.                                                                                                                                                                                                                                                                   |

The worker's migration event is real mainnet runtime evidence, but it is not a retained sanitized provider fixture and does not validate all PumpPortal migration event versions or wallet roles. The provider harness did not observe a migration in its short free-feed window; the separate worker session did. These observations are kept distinct rather than generalized.

### Updated milestone and readiness matrix

| Stage                                                            | Status                                               | Reason                                                                                                                                                    |
| ---------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration signature resolution and atomic slot/phase persistence | PASS for observed event                              | Helius matched signature, transaction success, mint participation, and slot `464032830`; repeated versions and provider role semantics remain unverified. |
| Migration-first analysis and restart recovery                    | PASS in deterministic tests; PARTIAL live            | Durable recovery and quarantine are verified. Live analysis was stopped by the bounded RPC budget before full security evidence was available.            |
| Provider error/control frame distinction                         | PASS                                                 | Unit tests and live-worker diagnostics agree.                                                                                                             |
| PAPER SELL cap and pause policy                                  | PASS in deterministic tests                          | Profitable/loss-making/partial/full SELL, pause, drawdown, oversell, and unavailable-quote cases pass. PAPER runtime remains disabled.                    |
| Live normalized trade observations and full launch behavior      | BLOCKED                                              | Metered trade access and continuous stream completeness remain unavailable.                                                                               |
| **Milestone A — DRY_RUN end-to-end**                             | **INCOMPLETE**                                       | Live migration recovery and fail-closed decision are demonstrated, but the pipeline has no live trade observations or complete behavior window.           |
| **Milestone B — PAPER foundation**                               | **PASS for isolated library tests; NOT operational** | Accounting and SELL regressions pass, but application PAPER mode stays disabled and Milestone A is incomplete.                                            |

**PAPER operational readiness: NOT READY.** Keep automatic PAPER entries disabled until authorized trade-stream access, complete observation coverage, and the full evidence-backed discovery-to-decision path have passed. No signing, swap submission, or virtual portfolio settlement was performed in this follow-up.

## Latest test rerun — 2026-11-01

- `pnpm test`: **PASS — 77/77**, 0 failures, 0 skipped.
- `node --experimental-strip-types --test tests/paper.test.ts`: **PASS — 15/15**.
- A worker startup attempt using the current `.env` returned `APP_MODE supports DRY_RUN only; paper and live execution are not implemented`. Configuration validation occurs before `SentinelStore.open()`, so this attempt did not open the configured database or start providers.
- These are automated tests and a startup-boundary check. They do not constitute real-time PAPER trading or live execution validation.
