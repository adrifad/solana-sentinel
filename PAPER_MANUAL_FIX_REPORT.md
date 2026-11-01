# Manual PAPER Trading Fix Report

Date: 2026-11-01 (UTC)

## Result

**Verdict: `BLOCKED:LIVE_MAINNET_MANUAL_QUOTE_AND_VPS_SMOKE_UNVERIFIED`**

The manual PAPER path now passes deterministic local integration tests, including virtual BUY, position creation, risk-reducing SELL, and ledger/PnL settlement. This does not prove live quote execution or deployed runtime behavior. No VPS was deployed or restarted, and no mainnet manual order was submitted.

## Root causes and fixes

- **Coverage eligibility counted reason codes instead of evaluating them.** A valid coverage-only `QUARANTINE` decision could include informational holder and quote pass codes and was rejected. The worker now verifies the coverage record and behavior evidence reference, recomputes verified buyer evidence and behavior risk, rechecks security/creator/holder evidence, and matches recognized informational reason codes to those checks. Unknown or substantive reasons remain rejecting. Regression cases confirm unsafe creator history, incomplete holder data, and failed exit validation still reject. The saved risk decision is not rewritten.
- **Manual quote validation required observation before request start.** Quote requests can return a valid market snapshot after simulated arrival. `PaperRiskManager` is now the shared validation path and validates at quote response/settlement time, checking snapshot slot/time, freshness at settlement, amount, direction, venue, fees, impact, and timestamp ordering. Pump venue quote results carry arrival, request-start, and response-completion timestamps. BUY and exit SELL quotes must use the same supported venue.
- **Manual requests inherited automatic signal age.** Entry and exit requests now carry independent persisted expiry. Worker and engine reject expired work before analysis and after quote retrieval; automatic signal age remains unchanged. Manual SELL is not blocked by the automatic BUY signal age. Restart recovery preserves the expiry on pending intents.
- **Readiness collapsed manual and automatic entry gates.** The API now exposes separate runtime, manual-entry, manual-exit, and automatic-entry readiness, with candidate, authentication, wallet, provider, and open-position blockers. Manual readiness does not require complete stream coverage but still requires verified behavior and security evidence.

## Code and migration

- Added additive migration `012-manual-paper-request-expiry.sql` with `manual_paper_requests.expires_at_utc`.
- Added `paper.manual_entry_request_expiry_ms` (default 5,000 ms) and `paper.manual_exit_request_expiry_ms` (default 300,000 ms), validated by Zod.
- Existing wallet initialization remains idempotent and unchanged; opening-balance mismatches remain reported without ledger edits.
- No signer, transaction submission, paid stream activation, or LIVE mode was introduced. No deployment database was opened.

## Automated validation

- `pnpm install --frozen-lockfile`: PASS
- `pnpm typecheck`: PASS
- `pnpm test`: PASS, 99 passed / 0 failed
- `pnpm lint`: PASS
- `pnpm format:check`: PASS
- `pnpm docs:check`: PASS
- `pnpm build`: PASS
- Fresh migration to schema version 12 on `/tmp/solana-sentinel-sprint33-manual.sqlite`: PASS
- `PRAGMA integrity_check`: `ok`
- Targeted manual latency tests at 200/500/1,000 ms: PASS
- Bounded expiry tests at 1/3/5/10 seconds: PASS; no fill or balance mutation after expiry
- Manual BUY → SELL fixture cycle and unavailable SELL quote behavior: PASS
- Wallet conversion and mismatch/restart behavior: existing tests pass, including 10 SOL = 10,000,000,000 lamports

Fixture-backed fills and quote timing tests are synthetic simulations. They are not evidence of mainnet execution, live provider entitlement, or profitability.

## Runtime and provider evidence

- The test suite verified bearer authentication, PAPER-only writes, idempotency, queue recovery, quote refusal, virtual balance conservation, and no signer/submission path.
- The repository’s prior provider-validation record documents a PumpPortal trade-subscription entitlement denial. This task did not repeat a live provider session; no new real trade event or mainnet manual quote was captured.
- No VPS/Compose smoke test was performed. The current session has no verified VPS deployment connection, and production SQLite state was not accessed.
- Automatic entries remain disabled by default. Manual requests still require fresh supported venue quotes and all security, creator, behavior, and financial gates.

## Remaining work before READY

1. Run the deployment using a dedicated/backed-up database and confirm API/worker mode agreement and wallet balance without changing persistent ledger history.
2. With authorized provider access, submit a manual request for a candidate that independently passes every mandatory gate; record either a verified refusal or a virtual fill using fresh live Helius-backed state.
3. If a position opens, validate a manual SELL and restart recovery on the deployment, checking wallet, ledger, holdings, and realized PnL.
4. Verify GitHub Actions for the pushed commit. Live provider trade-stream coverage remains a separate blocker for automatic entries.

## Delivery

- Implementation commit: `04cf2935d123cf90532832aa997e9d5a018fa907` (`main`)
- GitHub Actions CI run [41324819000](https://github.com/adrifad/solana-sentinel/actions/runs/41324819000) was observed as `in_progress` for the implementation commit. Follow-up status polling could not complete because `api.github.com` DNS resolution failed. CI completion is therefore not verified.
- Mainnet trade/quote validation in this change: NOT PERFORMED
- VPS smoke test: NOT PERFORMED
