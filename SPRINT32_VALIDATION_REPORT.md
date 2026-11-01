# Sprint 3.2 Validation Report

**Validation date:** 2026-11-01 (Asia/Jakarta)  
**Base branch/commit:** `main` / `0ca58f290b696982a203f134159b13c222725948`  
**Working tree:** local implementation changes are not yet committed or pushed as of this report.

## Summary

This change adds conservative Pump and PumpSwap trade-event decoding and transaction correlation, persists trade-evidence provenance, provides a capped read-only Helius validation harness, separates Helius RPC and trade-stream readiness, and preserves fail-closed observation coverage. No trade signing or transaction submission exists in the DRY_RUN/PAPER runtime. Automatic PAPER entries and metered PumpPortal trades remain disabled.

## Changes

- Pump SDK 4.1.0 `TradeEvent` decoder now uses the IDL-defined 34-byte Shareholder vector stride and rejects unsupported trailing layouts.
- Added PumpSwap SDK 2.1.0 `BuyEvent` and `SellEvent` log decoder. Events are accepted only from successful PumpSwap program invocations; pool, mint, quote asset, signer, and token delta are checked against transaction/account evidence.
- Added finalized Helius transaction validation for signature, slot, success, mint participation, signer role, exact token amount delta, block/event timestamp consistency, and venue-specific identity.
- Added migration 010 for chain event-time provenance, local ingestion time, quote mint, decoder version, validation status, and confidence. Existing rows migrate as `UNVERIFIED`.
- Added bounded verification queue with explicit duplicate/full/stopped outcomes. Duplicate pending notifications no longer create false stream-gap records; overflow still records a gap. Shutdown drains the queue before SQLite closes.
- Added `validate:trade-events`, capped at 20 recent signatures and 8 RPC attempts for the default five-signature run. It never opens the application database and only writes a capture after a verified observation.
- API token detail now includes behavior snapshots and latest trade coverage. Readiness separately reports discovery readiness, PAPER runtime initialization, and PAPER automatic-entry readiness; Helius RPC health is distinct from Helius trade-stream health.
- Updated provider, testing, implementation-status, and README documentation.

## Live evidence

- Existing sanitized PumpPortal create fixture: observed live websocket message, independently matched to finalized transaction evidence in its sidecar. It is creation evidence, not trade evidence.
- Bounded Helius trade validation was run for mint `EoyXSdCtEQg42vjwPeqpoadYvdEp1qTaoB685wVwpump`, taken from that public capture, with `--max-signatures=5`.
- Result: **BLOCKED**, `PROVIDER_UNAVAILABLE`, 3 local request attempts consumed from the 8-request cap, 0 signatures examined, and no transaction/event fixture written. Provider-billed credits could not be observed or verified.
- No live Pump or PumpSwap trade payload was captured, and the decoders have not been validated against a genuine mainnet trade log in this environment.
- No PumpPortal metered subscription was enabled. No wallet was funded. No claim is made that a current quote generated an executable fill.

## Coverage and reconciliation

The Helius stream uses standard `logsSubscribe` and records disconnects, queue overflow, subscription failures, and unverified windows. The capped signature-query harness is a diagnostic tool, not a coverage reconciler. Current code does not establish that mint-address history enumerates every Pump/PumpSwap trade across all relevant program versions or provider retention boundaries. Consequently, `COMPLETE` is not written, gaps are not silently cleared, and reconnect/restart windows remain `UNVERIFIED` or `GAP_DETECTED`. Retrospective evidence is timestamped at ingestion and excluded from decisions whose decision time predates that evidence.

## Automated verification

- `tsc --noEmit`: PASS.
- ESLint: PASS.
- Prettier check: PASS.
- Documentation link check: PASS after adding this report.
- 14/14 test files passed, excluding `tests/api.test.ts`. The API integration test requires binding a loopback TCP port and is blocked in this restricted environment with `listen EPERM`; it was not disabled or changed to hide that restriction.
- Fresh SQLite migrations 1–10: PASS. `PRAGMA integrity_check`: `ok`. The configured `.env` database was not opened or modified.
- Full package-manager command suite: not verified; a previous `pnpm` invocation could not open its local SQLite store. The checks above used repository-installed binaries directly.
- Commit/push: BLOCKED. `git add` could not create `.git/index.lock` because the mounted `.git` directory is read-only; the GitHub Git Blobs API also returned `403 Resource not accessible by integration`. No commit was created.
- GitHub Actions: NOT VERIFIED because no commit could be pushed.

## PAPER results

The deterministic paper tests cover virtual wallet persistence/restart, quote-at-arrival, BUY/SELL settlement, partial exits, double-entry/accounting invariants, fee/slippage validation, idempotency, risk limits, exits, and missing/stale quotes. Existing `paper-runtime.test.ts` also demonstrates a synthetic fixture-backed virtual BUY followed by monitoring and a profitable virtual SELL. These are offline simulation results, not mainnet observations, not evidence of trade coverage, and not profitability claims. Worker automatic entry remains blocked by the absence of a `COMPLETE` coverage state.

## Acceptance gates

| Gate                                  | Status                      | Evidence / blocker                                                                                         |
| ------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A — Live Trade Intelligence           | **BLOCKED**                 | Helius returned `PROVIDER_UNAVAILABLE`; 0 signatures examined and no genuine Pump/PumpSwap trade captured. |
| B — Observation Completeness          | **BLOCKED**                 | No validated exhaustive historical reconciliation contract; stream and restart gaps remain unverified.     |
| C — PAPER Runtime                     | **PASS (offline fixtures)** | Deterministic paper accounting and worker position-monitor tests pass; no live quote/fill claim.           |
| D — Operational PAPER Forward Testing | **BLOCKED**                 | Gates A and B are open; automatic PAPER entry is disabled and the entry preconditions fail closed.         |

## Readiness and remaining work

**Verdict: `PAPER_PARTIALLY_READY`.** PAPER virtual settlement and position lifecycle are fixture-tested. It is not ready for autonomous forward testing.

1. Re-run the bounded harness where Helius network access is available and capture at least one finalized Pump curve trade and one canonical PumpSwap trade, with sanitized transaction log evidence.
2. Validate Pump/PumpSwap transaction enumeration and history boundaries before implementing any `COMPLETE` coverage transition. If provider guarantees or address-index coverage cannot be proven, retain `UNVERIFIED` and keep automatic entries disabled.
3. Add durable reconciliation checkpoints/jobs only after the query completeness contract is validated; enforce page/signature budgets and persist unresolved boundary reasons.
4. Make position monitoring aware of remaining RPC quota and estimated open-position demand; block new entries when exit-monitoring capacity is insufficient. Current default polling interval is 10 minutes and is not a stop-loss execution guarantee.
5. Expose active subscriptions, processing throughput, per-position quote requests, and latency sample counts/percentiles in operational health.
6. Run the API loopback test and full `pnpm` CI-equivalent commands in an environment that permits loopback binding and package-manager SQLite state, then verify remote GitHub Actions.
