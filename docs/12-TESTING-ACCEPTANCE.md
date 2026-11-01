# 12 — Testing, Validation and Acceptance Criteria

## Unit tests

- Strict config schema: unsafe values rejected and no `LIVE` via UI override.
- Raw token amount scaling, lamports conversion and arithmetic safe at extreme values.
- Token security checks across Token Program and Token-2022 extensions; unsupported extension fails closed.
- Creator reputation confidence and CEX-funding false-positive guard.
- Test token classifier with fixtures and uncertainty handling.
- Full reason-code taxonomy and immutability.
- Quote freshness, max slippage, fees (no double count), exact-in curves, pool migration.
- Ledger balances and realized PnL exact across slippage-adjusted all-or-nothing paper fills, partial exits, rejections, and unavailable liquidity.
- PAPER-only package: quote is requested after simulated arrival latency; exact amount/mint/direction, slot, timestamp, fee mint, freshness, impact and configured slippage are rechecked before atomic fill. Missing/stale/future quote and unavailable sell route produce no fill.
- Double-entry paper journals balance per asset and ledger rows are immutable; duplicate concurrent intents settle once, pending orders can resume after restart, and partial sells allocate exact raw-unit cost basis.
- Expired and future-dated persisted intents cannot be filled after recovery; quote timestamps are validated when state loading completes, not before RPC latency elapses.
- Paper risk tests cover insufficient virtual SOL, open exposure/position caps, daily realized loss, drawdown, unpriceable marks, and fail-closed exit quotes. PAPER mode is explicit; LIVE remains rejected and automatic entries default off.

## Integration tests (mock providers + recorded responses)

- WebSocket connection, reconnection, resubscribe, duplicate/out-of-order events, event budget cap.
- Helius 429/5xx/timeout, pagination, malformed transaction payload.
- Jupiter quote-only requests omit `taker`, reject transaction-bearing responses, and honor the persistent provider budget before network access.
- Launch-window look-ahead exclusion, incomplete-window behavior, and wallet token outflow evidence that does not claim a proven sell.
- Helius standard logsSubscribe subscription lifecycle, event-budget limits, reconnect gaps, Pump SDK 4.1.0 TradeEvent synthetic decoder vectors, and persisted coverage that is never upgraded without reconciliation.
- PumpSwap SDK 2.1.0 BuyEvent/SellEvent synthetic IDL vectors, successful-program nesting, signer/token-delta correlation, canonical pool/WSOL validation, and capped read-only live validation harness argument/capture rules. Synthetic fixtures do not pass the live-trade acceptance gate.
- PAPER runtime virtual wallet initialization and restart recovery without a quote provider; no virtual fill is generated when quote state is missing.
- Repeated same-wallet buy/sell activity remains `UNKNOWN` with a possible wash-pattern reason code.
- Versioned migration persistence through version 10, including quote/behavior evidence and trade event-time, ingestion, quote mint, decoder, and validation provenance; fresh database integrity check.
- DEX Screener missing pool data not classified as scam by itself.
- Jupiter quote-only returns no route and paper does not sign or call execute.
- Subscriptions automatically unsubscribe after expiration/analysis cap.
- SQLite crash/restart resumes without duplicate ledger writes.
- Migration-first discovery persists a dedicated recovery job; verified signature/mint/success/slot updates are atomic, failed or conflicting transactions do not set `migration_slot`, and interrupted work is reclaimed after restart.
- PumpPortal token, error, control, unsupported, and malformed frames are classified separately; diagnostics are bounded, sanitized, persisted, and visible through read-only health.
- Pausing new entries rejects BUYs while valid SELL exits remain eligible, including proceeds above the BUY trade-size cap and after drawdown; held-token, quote, liquidity, and ledger checks still reject invalid exits.

## Security and mode separation tests

- `DRY_RUN`/`PAPER` dependencies contain no signer and no transaction-sending credentials.
- `APP_MODE=PAPER` with `LIVE_TRADING_ENABLED=true` still cannot send (invalid combination rejected).
- API `PATCH` tries to set LIVE / change signer / lift hard caps → 403/400 + audit event.
- Restart of live-executor always disarmed; expired arming token blocks trade.
- Loss limits, global kill switch and stale market snapshots reject new entries.
- Secret leak scan in logs, HTTP responses, exception paths, Git history.

## Realtime evaluation

- Compare observed event receipt delay, analysis p50/p95 and quote p50/p95.
- Save `observation_window` variations 2s/30s/60s/120s with isolated virtual wallets.
- Minimum test objective: several hundred closed trades across multiple dates/market regimes (not enough to guarantee profit).
- Evaluate confidence intervals, distribution of loss, failure-to-exit frequency and PnL sensitivity to latency and price impact.
- Always report gross vs net after fees; mark `UNPRICEABLE` positions separately.

## Acceptance gates by phase

| Phase            | Must demonstrate                                                                       |
| ---------------- | -------------------------------------------------------------------------------------- |
| P0 Discovery     | Continuous launches + migrations, dedup, reconnect, storage, cost caps                 |
| P1 Intelligence  | Evidence-backed creator analysis + test token classifier + chain security checks       |
| P2 Dry run       | Decision logs, reason codes, no virtual fills, no signer                               |
| P3 Paper         | Fresh curve & pool quotes, virtual balance conservation, no fake exit, realistic costs |
| P4 UI/Ops        | Audit config changes, realtime health, kill switch, backup/restore                     |
| P5 Live (future) | Isolated signer, explicit arming, on-chain reconciliation, independent security audit  |

## Continuous integration

Required: format, lint, strict typecheck, unit, integration, fixture-replay, dependency/license/secret scan, migration rollback test, build artifact. Keep offline fixture tests independent of external API uptime.

---
