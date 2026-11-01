# 00 — Product Requirements Document (PRD)

## 1. Vision

Detect new Solana launches early using public on-chain data, investigate creator behavior and token security, reject unsafe/test/spam tokens, and evaluate whether buying is worthwhile. Provide event-driven `DRY_RUN`, realistic `PAPER`, and separately armed `LIVE` operation. Profitability is **not guaranteed**.

## 2. Initial scope / non-goals

**P0:** Pump.fun launch events, creator/initializer attribution with confidence, token security and anti-test classification, SOL quotes, single virtual portfolio, paper orders/positions, risk gate, dashboard, replay/audit. Use mainnet data even in paper.

**P1:** PumpSwap after graduation, optional social intelligence, linked-wallet cluster analysis, additional entry/exit strategies, alerting, richer replay, stratified performance reporting.

**P2:** Real wallet support with isolated signer and guarded deployment, additional venues and route adapters, multi-wallet or multi-strategy.

**Out of scope in MVP:** guaranteed identification of scammers, privileged/insider info, actual mainnet trade submission, ultra-low-latency MEV strategies, automatic social scraping in violation of provider terms, arbitrary-token auto-buy.

## 3. User stories

- As an operator I can see new token launches within the observed realtime feed and why they are rejected.
- As an analyst I can inspect creator token history, linked funding addresses with evidence confidence and prior outcomes.
- As a paper trader I can simulate buys/sells against current on-chain state with fee/latency/slippage assumptions, no wallet signing.
- As an operator I can toggle analysis features/risk thresholds through validated config and see version of config per decision.
- As an operator I can compare 2/30/60-second entry strategies over the same recorded market events.
- As an operator I can see whether the stream is healthy and whether data/quotes were stale.
- As a future live operator I must perform a separate explicit CLI/deployment arming flow; the UI can only disarm.

## 4. Functional requirements

| ID    | Requirement                                                                       | Priority |
| ----- | --------------------------------------------------------------------------------- | -------- |
| FR-01 | Token creation and migration subscription with reconnect/resubscribe/dedup        | P0       |
| FR-02 | Creator identity classification (`creator`, `payer`, `mint authority`, `funding`) | P0       |
| FR-03 | Cached historical reputation with evidence provenance and expiration              | P0       |
| FR-04 | Token mint & extension checks incl. Token-2022                                    | P0       |
| FR-05 | Test/spam detection with `LIKELY_TEST`, `UNKNOWN`, `ORGANIC_CANDIDATE`            | P0       |
| FR-06 | Decision gate: `REJECT`, `QUARANTINE`, `WATCH`, `BUY_ELIGIBLE`                    | P0       |
| FR-07 | `DRY_RUN`: record intents but never simulate a balance-changing fill              | P0       |
| FR-08 | `PAPER`: real-time quote-based virtual ledger / entry & exit                      | P0       |
| FR-09 | SOL balance, positions, realized/unrealized PnL (exit-quote based)                | P0       |
| FR-10 | Dynamic configuration with audit and safe reload boundaries                       | P0       |
| FR-11 | Observability, provider budget/limits and emergency pause                         | P0       |
| FR-12 | Shadow strategies and timestamp-correct replay                                    | P1       |
| FR-13 | Social attribution with independent verification                                  | P1       |
| FR-14 | `LIVE` with dedicated wallet/isolated signer, explicit arming                     | P2       |

## 5. Non-functional and safety requirements

- 99% of decisions and events should have reconstructable provenance in local testing (target, measure actual completeness).
- Target processing latency **after receipt** p95 under 2 seconds for cached creator analysis under nominal load; no promised chain-to-fill latency.
- No trade when chain account state is stale, missing, contradictory, or unsupported.
- Every network call has deadline, rate limit, circuit breaker, and structured error semantics.
- Multiple workers must be idempotent. Events can be duplicated and arrive out of order.
- Zero secret content in logs, telemetry, UI, database migrations, tests.
- No live signer dependency exists in the analysis/paper deployment.

## 6. Acceptance checkpoints

1. `DRY_RUN` remains read-only even with malformed mode/dashboard requests.
2. Paper buys and sells balance to the lamport; rejected exits do not realize fake PnL.
3. Router chooses Pump curve or migrated pool appropriately, with a deterministic failure for unsupported state.
4. Historical fixtures replay same outcomes deterministically when replay clock, config and random seed are fixed.
5. Risk decisions list explicit reason codes and evidence snapshots.
6. Live cannot be started from a config toggle alone; see `09-LIVE-READINESS.md`.

## 7. Success measurement

Track source-to-detection delay, decision latency p50/p95, missing/late events, % unknown creators, rejection false positives (only assess with later outcomes), risk rule frequencies, conservative paper expectancy, net PnL, max drawdown, simulated quote success ratio, quote freshness, slippage and fee sensitivity. Do not optimize win rate alone.

---
