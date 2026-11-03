# Zero-Trade Diagnosis Report — 2026-11-03

## Repository and runtime access

- Branch: `main`
- Inspected HEAD and `origin/main`: `cb3ab1075716f246ee52531f4343cc0e73ac76f3` before these local changes.
- Local `.env` mode: `PAPER`; Helius and PumpPortal credential variables are present. Credential values were not read into output.
- Deployment checkout `~/projects/solana-sentinel` is absent. Neither `docker compose` nor `docker-compose` is available in this environment.
- The configured `.env` database was not opened. No database backup or deployment SSH access was available, so deployed commit, container overrides, database migration level, production counts, queue depth, decision distribution, order/fill counts, daily RPC consumption, and rejection-code ranking are **NOT VERIFIED**. The counts supplied in the task are treated as operator-reported, not independently confirmed.

## Root causes confirmed from source

1. Automatic entry scans were called only inside the position-monitor `tick()`. The default position-monitor interval is 600,000 ms, versus a 3,000 ms automatic signal age. Fresh decisions could expire before an entry evaluation.
2. Complete observation coverage is a hard automatic-entry gate. The Helius `logsSubscribe` observer has no replay cursor and the implementation cannot prove exhaustive history. Stream gaps therefore remain unreconciled and behavior remains incomplete.
3. PumpPortal token trade subscriptions are hard-disabled (`enable_token_trades: false` in configuration schema); Helius log trade streaming defaults off. No real trade observations mean the required buyer evidence and complete behavior window cannot be satisfied.
4. The Helius application budget was a single daily counter of 1,000 requests, with no reserve for position exits. Retries consumed the same counter but method/purpose diagnostics were not retained.
5. Candidate admission used a count of `monitoring_eligible` tokens whose first-seen provider timestamp fell in the prior 24 hours. This was neither a count of active work nor a bounded lease and behaved differently for old timestamps.
6. DRY_RUN intents are persisted only for `BUY_ELIGIBLE`; rejected or quarantined candidates remain explainable through decisions, but are not represented as trade intents. No production database was available to query the requested reason-code histogram.

## Changes in this worktree

- `apps/worker/src/analysis.ts`, `apps/worker/src/main.ts`, `apps/worker/src/paper-runtime.ts`: persist decision first, then notify a separately guarded automatic-entry evaluator. Position monitoring no longer scans entry decisions. Startup scans persisted decisions; concurrent notifications are coalesced. The strict `BUY_ELIGIBLE`, coverage, freshness, security, quote, and portfolio risk checks are unchanged.
- `packages/storage/migrations/013-monitoring-leases.sql`, `packages/storage/src/index.ts`, `apps/worker/src/main.ts`: monitoring slots now expire after configured `monitoring_duration_seconds`. Lease status is reflected in stored token summaries and candidate admission. Discovery history is retained.
- `config/default.yaml`, `packages/config/src/index.ts`, `packages/providers/src/helius.ts`, `packages/providers/src/pump-curve-state.ts`, `packages/providers/src/pump-swap.ts`, `packages/paper/src/index.ts`: add an exit-reserved Helius internal budget (default 200 of 1,000/day), explicit request priority propagation, and account-state request subject attribution. SELL quote reads use exit priority; candidate analysis/BUY reads cannot consume the reserved capacity.
- `packages/storage/migrations/013-monitoring-leases.sql`, `packages/storage/src/index.ts`, `apps/api/src/main.ts`, `apps/api/src/server.ts`: persist per-attempt Helius method, priority, component, purpose, subject mint when known, attempt number, outcome and safe error code; expose internal request usage and method totals through readiness. This measures application RPC requests, not provider-side credits or entitlement.
- `tests/analysis-pipeline.test.ts`, `tests/paper-runtime.test.ts`, `tests/discovery.test.ts`, `tests/hardening.test.ts`, and version assertions in `tests/paper.test.ts` / `tests/sprint25.test.ts`: cover immediate decision notification, entry/monitor separation, lease expiry/replacement, and reserved exit budget.
- Documentation: `README.md`, `docs/03-PROVIDER-INTEGRATIONS.md`, `docs/08-PAPER-EXECUTION.md`, `docs/IMPLEMENTATION-STATUS.md`; implementation plan: `docs/superpowers/plans/2026-11-03-zero-trade-pipeline.md`.

## Bounded mainnet validation

`pnpm validate:providers --seconds=10` completed read-only:

- Helius health and mainnet genesis: **PASS**.
- Existing sanitized live PumpPortal creation capture: finalized transaction succeeded at slot `464002088`; decoded CreateEvent mint matched; fee payer / launch initiator / event user / creator evidence were reported by the harness.
- Confirmed mint and bonding curve account state: present and owner checks passed at context slot `464902341`.
- RPC requests used: 4 of the harness cap of 4.
- PumpPortal free create/migration socket: **PASS**, 1 creation event observed, 0 migration events in this 10-second window. Metered trade stream was **NOT REQUESTED**.

`pnpm validate:trade-events -- --mint=5XJ77H59Ws9SpEiMj2BjX7fFEcbbGzPowyJBi8ar7i62 --max-signatures=1` returned **BLOCKED / `PROVIDER_UNAVAILABLE`** before a transaction was examined. No genuine trade payload was validated or persisted by this attempt. This provider error does not establish that the on-chain mint had no trades.

## Required diagnostic values

| Metric                                         | Result                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| Tokens discovered (deployed DB)                | NOT VERIFIED; operator supplied count is not independently queried                      |
| Tokens monitoring-eligible / active leases     | NOT VERIFIED from deployed DB                                                           |
| Tokens analyzed successfully                   | NOT VERIFIED from deployed DB                                                           |
| REJECT / QUARANTINE / WATCH / BUY_ELIGIBLE     | NOT VERIFIED from deployed DB                                                           |
| DRY_RUN intents                                | Operator-reported 0; not independently verified                                         |
| PAPER order attempts / fills / positions       | Operator-reported 0 orders, 0 fills, 0 positions; not independently verified            |
| Manual requests / realized PnL                 | Operator-reported 0 requests / 0 realized PnL; not independently verified               |
| Helius requests used / remaining in deployment | NOT VERIFIED; local harness used 4/4 bounded RPC calls                                  |
| Top 10 rejection codes                         | NOT VERIFIED; production DB unavailable                                                 |
| Automatic entry enablement                     | Baseline config `false`; local `.env` selects `PAPER`, but deployed override is unknown |
| Trade-stream state                             | Not running locally; config default disabled                                            |

## Coverage and PAPER safety

- No `COMPLETE` status is inferred from a live socket, absence of disconnect, or a later RPC history query.
- There is no separate `PAPER_EXPERIMENTAL_ELIGIBLE` decision contract in this revision. Partial observations remain non-actionable for automatic entries; no QUARANTINE decision is rewritten.
- Automatic PAPER entries remain disabled by default and were not enabled. The virtual PAPER engine remains separate from blockchain signing/submission.
- A recent mainnet creation observation is not evidence of trade-stream completeness or an executable paper fill.

## Readiness and deployment

- Event-driven decision-to-entry evaluation: implemented with deterministic offline regressions; production decision-to-order behavior **NOT TESTED**.
- Helius method/purpose internal accounting and reserved exit capacity: implemented and fixture-tested; deployment usage comparison **NOT AVAILABLE**.
- Real creation/provider contract: bounded validation passed as above.
- Real trade decoder / complete observation coverage: **BLOCKED** by `PROVIDER_UNAVAILABLE` for the trade validation attempt and by the lack of a validated exhaustive reconciliation contract.
- Live quote execution and manual PAPER BUY/SELL: **NOT TESTED** in the deployed runtime.
- VPS backup, deployment, restart, and GitHub Actions for the eventual pushed commit: **NOT PERFORMED / NOT VERIFIED**. The deployment tree and Docker Compose executable were unavailable.

## Automated validation

- `pnpm install --frozen-lockfile`: PASS.
- `pnpm typecheck`: PASS.
- `pnpm test`: PASS, 102 passed / 0 failed.
- `pnpm lint`: PASS.
- `pnpm format:check`: PASS.
- `pnpm docs:check`: PASS.
- `pnpm build`: PASS.
- Fresh isolated SQLite migrations: versions 1–13 applied; `PRAGMA integrity_check` returned `ok`.
- `git diff --check`: PASS.
- GitHub Actions for these local changes: NOT RUN because changes could not be pushed in this workspace.

## Source revision and delivery

- Base revision: `cb3ab1075716f246ee52531f4343cc0e73ac76f3` (`main` matched `origin/main` before edits).
- Implementation commit: `92baeb6475da463cfabe0b389cd38c8f9023a594`, pushed to `main`.
- GitHub CI: not verified. The commit combined-status query returned no statuses, and the unauthenticated Actions API request was rate-limited. This does not prove that a workflow passed or failed.
- Deployment: not performed. The deployment checkout and Docker Compose executable were unavailable; no production database or service was touched.

## Remaining actions before automatic PAPER entries

1. Restore deployment-host access; read the deployed commit, compose config, current readiness, and DB statistics using a WAL-consistent read-only backup.
2. Resolve Helius trade-validation provider availability and validate finalized Pump/PumpSwap trade transactions. Do not enable metered PumpPortal subscriptions without separate explicit authorization and budget approval.
3. Establish and test an exhaustive historical coverage contract, or independently specify and approve an experimental PAPER policy that requires real verified partial observations and all existing hard safety/risk checks.
4. Verify quote freshness, exit capacity, and end-to-end PAPER cycle against mainnet-derived snapshots in a bounded runtime test. Keep automatic entries disabled until those gates pass.
