# 08 — Real-Time Paper Trading: Fill Model & Ledger

## Implemented foundation status

The `@sentinel/paper` package contains a quote-at-arrival simulator, conservative fill adjustment, persistent order recovery, atomic double-entry settlement, positions, portfolio marks/PnL, risk gates, and an exit-rule evaluator. The worker now composes it in `APP_MODE=PAPER`, initializes a virtual wallet, recovers pending intents, and monitors open positions for stop-loss, take-profit, or max-hold exits. Quotes use the read-only Pump curve/PumpSwap loaders through Helius. No simulated trade is a real fill. Automatic entries default off and require complete observation/behavior/security evidence; the current observer cannot establish complete coverage, so it cannot currently submit an entry intent.

The existing `risk.emergency_pause` setting is retained for configuration compatibility and maps to `pauseNewEntries`: it rejects new BUY orders before quote requests and again inside atomic settlement. A valid SELL may reduce held token balance during this pause. SELL proceeds are not compared with the BUY max trade amount; SELL settlement remains bounded by held token balance, a fresh validated quote, liquidity, fees, slippage, and ledger balance checks. Emergency liquidation is not implemented.

## Manual PAPER orders

When `APP_MODE=PAPER`, the API accepts `POST /api/paper/entry` and `POST /api/paper/exit` only with `Authorization: Bearer <PAPER_OPERATOR_TOKEN>`. The token must be configured with at least 32 characters. API requests are size limited, schema validated, throttled, and require an `Idempotency-Key`. The API writes a durable request; only the worker claims it and performs virtual settlement. Manual requests use `PENDING → PROCESSING → FILLED | REJECTED | UNFILLABLE`; restart recovery reclaims a request and reuses the same deterministic order ID for an interrupted attempt. Recognized transient quote failures are retried at most three times with bounded backoff; each new attempt receives a separate order ID so a terminal unfillable order cannot suppress the retry.

Manual BUY requests may accept the stored stream coverage status when it is not `COMPLETE` only if the current decision is `QUARANTINE` solely for `LAUNCH_BEHAVIOR_INCOMPLETE`. The worker independently rechecks verified on-chain creator attribution, fresh complete creator history without suspicious indicators, supported and fresh token security, validated holder sample coverage, current risk decision, minimum independent buyers, suspicious behavior indicators, and fresh BUY and SELL quotes for the requested size. It records the original coverage state, reason, decision/evidence references, and the explicit `MANUAL_ENTRY_ACCEPTED_UNVERIFIED_STREAM_COVERAGE` caveat. It does not rewrite the risk decision or treat missing activity as zero. Manual entries remain rejected for every other decision blocker.

Manual SELL requests reference a stable position ID from `GET /api/paper/status`. The API resolves that ID to the configured wallet and stored mint/token amount. The worker rechecks holdings and uses a fresh SELL quote at simulated arrival; the existing atomic settlement permits risk-reducing SELL during entry pause. Missing or stale sell liquidity leaves the position and SOL balance unchanged.

`GET /api/paper/status` reports configured and persisted initial wallet balances, open positions, fresh per-position sell-quote marks, realized PnL, latest fills, request states, and readiness blockers. A position marked `UNPRICEABLE` or `EXIT_BLOCKED`, or with a stale quote mark, has no unrealized PnL shown. The API is published on loopback by default in Compose. Do not publish these write routes publicly without authenticated TLS.

The configured initial SOL amount is converted to lamports exactly once by `PaperTradingEngine.initializeWallet`. Existing accounts remain immutable. If their persisted opening balance differs from current configuration, the mismatch is reported and new entries are blocked; the engine does not alter historical ledger rows. Risk-reducing SELL remains available.

Position monitoring persists `OPEN`, `UNPRICEABLE`, and `EXIT_BLOCKED` status with bounded exponential retry timing in migration 009. A missing, stale, or unsupported sell quote does not settle a sell or credit SOL. Runtime startup with no Helius credential still restores the virtual wallet but cannot mark positions with market value or fill orders. The Helius trade stream is explicitly opt-in and incomplete coverage blocks automatic entries.

## Objective

Simulate trading using **mainnet state available when an order would arrive**, not an arbitrary last-traded price. Keep it conservative. A simulated success is not a guarantee of real execution.

## Clock and timeline

- `observed_slot/time`: event origin on-chain.
- `received_at`: time local worker received event.
- `decision_at`: after intelligence/risk completed.
- `intent_at`: order request created.
- `simulated_arrival_at`: intent time + configured execution latency (deterministic seeded distribution or fixed delay).
- `quote_at/slot`: state used for indicative trade output.
- `fill_at`: simulated execution time; must never precede intent/arrival/quote.

No lookahead. In replay, use recorded snapshots available at matching simulated time; **never query current mainnet for a historical trade**.

## Venue-specific quotes

1. On Pump curve, load account/global fee data and compute official compatible expected in/out and price impact for order size from same account slot. Handle protocol upgrades and multi-hop quote mint / signed virtual reserve adjustments if supported; otherwise do not fill.
2. Post-migration, read PumpSwap pool state/fees and use supported SDK quote. Migration invalidates curve cache.
3. If Jupiter supports the pair, a `GET /swap/v2/order` quote-only (no taker) may inform price; no execute endpoint in paper.
4. Every quote captures source, route/venue, as-of slot, freshness, fees included and validation status.

## Conservative paper buy algorithm

1. Gate/risk passes and available virtual SOL covers order and fees.
2. Make `OrderIntent` immutable with idempotency key and requested exact-input SOL lamports.
3. Wait simulated latency; fetch **fresh** venue state and compute exact-in quote.
4. Reject if unsupported venue, stale state, high price impact, insufficient seller exit liquidity, or slippage beyond bounds vs pre-intent reference.
5. Apply modelled adverse fill adjustment conservatively (never improve output arbitrarily), account for protocol/router/network/priority/ATA rent where applicable; **do not double-count embedded fees**.
6. Atomically append debit/credit ledger entries and `SIMULATED_FILLED` with raw amounts, cost basis and quote provenance.

## Conservative paper sell algorithm

1. Confirm virtual position size from ledger and venue capability.
2. Fetch fresh exact-input sell quote for actual held amount after simulated latency.
3. If no sell route or insufficient exit liquidity: `EXIT_UNAVAILABLE`; **position remains open** and account does not credit imaginary proceeds.
4. Account for slippage/fees and update raw token/SOL ledger and realized PnL only on simulated fill.

## Order lifecycle

`CREATED → RISK_CHECKED → QUOTE_REQUESTED → {SIMULATED_FILLED | REJECTED | EXPIRED | UNFILLABLE}`.

`DRY_RUN` **never** writes `SIMULATED_FILLED` or mutates virtual ledger.

## Ledger & PnL mathematics

Use lamports and raw token `bigint`, not floating point. Keep separate debits/credits and fee entries.

```
realized_pnl_lamports = net_sell_proceeds_lamports
                         - allocated_buy_cost_basis_lamports
unrealized_pnl = current_sell_quote_net_proceeds - remaining_cost_basis
```

If current sell quote missing, mark valuation `UNPRICEABLE`; don't show a fake positive mark. Daily loss and max drawdown must use conservative realized + reliable unrealized estimates, with severe `UNPRICEABLE` state blocking new risk.

## Advanced realism / evaluation

- Log best-case quote, conservative quote and paper filled output separately.
- Measure quote success, rejected exits, fee sensitivity, latency sensitivity, price-impact by order size.
- For quote availability, distinguish `NO_ROUTE`, `RATE_LIMIT`, `VENUE_UNSUPPORTED`, `STALE`, `NETWORK_TIMEOUT`.
- Use same recorded stream to compare FAST 2s vs VALIDATED 30s/60s/120s with independent virtual accounts and no future leakage.
- Simulated transactions do not affect market prices; production performance can diverge due to actual fill competition and transaction landing behavior.

## Validation fixtures

- Curve trade with fee-inclusive quote and fixed decimals.
- Curve migration to PumpSwap while a buy intent is pending.
- Token cannot sell after buy; no phantom PnL.
- RPC timeout, stale state, missing fields, duplicate events.
- Very small token units and overflow attempts; all accounting remains exact.
- Fee double-count test.

---
