# 12 — Testing, Validation and Acceptance Criteria

## Unit tests

- Strict config schema: unsafe values rejected and no `LIVE` via UI override.
- Raw token amount scaling, lamports conversion and arithmetic safe at extreme values.
- Token security checks across Token Program and Token-2022 extensions; unsupported extension fails closed.
- Creator reputation confidence and CEX-funding false-positive guard.
- Test token classifier with fixtures and uncertainty handling.
- Full reason-code taxonomy and immutability.
- Quote freshness, max slippage, fees (no double count), exact-in curves, pool migration.
- Ledger balances and realized PnL exact across partial fills, partial exits, rejections, and unavailable liquidity.

## Integration tests (mock providers + recorded responses)

- WebSocket connection, reconnection, resubscribe, duplicate/out-of-order events, event budget cap.
- Helius 429/5xx/timeout, pagination, malformed transaction payload.
- Jupiter quote-only requests omit `taker`, reject transaction-bearing responses, and honor the persistent provider budget before network access.
- Launch-window look-ahead exclusion, incomplete-window behavior, and wallet token outflow evidence that does not claim a proven sell.
- Repeated same-wallet buy/sell activity remains `UNKNOWN` with a possible wash-pattern reason code.
- Version 6 migration persistence for quote and time-indexed behavior evidence.
- DEX Screener missing pool data not classified as scam by itself.
- Jupiter quote-only returns no route and paper does not sign or call execute.
- Subscriptions automatically unsubscribe after expiration/analysis cap.
- SQLite crash/restart resumes without duplicate ledger writes.

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
