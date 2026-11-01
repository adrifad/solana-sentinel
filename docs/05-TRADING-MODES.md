# 05 — Trading Modes: DRY_RUN / PAPER / LIVE

## Current implementation boundary

The application currently validates `DRY_RUN` only. A signer-free `@sentinel/paper` library and SQLite ledger foundation are available for deterministic testing, but neither `APP_MODE=PAPER` nor worker entry execution is enabled. Do not select PAPER for operations until the live observation-to-decision Milestone A is demonstrated and the remaining execution safeguards are integrated.

## Safety matrix

| Capability                           |        DRY_RUN |          PAPER |                     LIVE |
| ------------------------------------ | -------------: | -------------: | -----------------------: |
| Listen to mainnet token/trade events |            Yes |            Yes |                      Yes |
| Creator/scam/social analysis         |            Yes |            Yes |                      Yes |
| Produce trade signal                 |            Yes |            Yes |                      Yes |
| Create order intent and audit        |            Yes |            Yes |                      Yes |
| Query mainnet quotes                 |       Optional |       Required |                 Required |
| Change virtual balances              |         **No** |            Yes |                   **No** |
| Sign Solana transactions             | **Impossible** | **Impossible** |     Isolated signer only |
| Submit Solana transactions           | **Impossible** | **Impossible** |      Guarded sender only |
| Track real positions                 |             No |             No | Yes, reconciled on-chain |

## DRY_RUN

Purpose: verify detection/decision quality, reason codes and timing. It may calculate hypothetical price but must **not** create `paper_fills`, adjust virtual capital, or report realized PnL as if traded. Signal log stores `would_buy`, `would_sell`, `would_reject` with full context. No wallet.

## PAPER (real-time market simulation)

Use **mainnet data**, virtual SOL and token balances; reconstruct executable quote at simulated placement time, apply pessimistic constraints and log fill quality. No signature/transaction submission. Virtual funds must not grow without ledger events.

- `REALTIME_PAPER`: event timestamps advance with live clock and live quotes.
- `REPLAY_PAPER`: same engine, deterministic recorded events and historical market snapshots. These are not interchangeable: never query current quote while replaying historical trades.
- Mark equity-to-market using **exit quotes** for position size, not last trade price alone.
- When sell cannot be quoted or liquidity vanishes, status `EXIT_UNAVAILABLE` and exposure remains.

## LIVE

Only after `09-LIVE-READINESS.md` signoff. Uses actual wallet-specific accounting and chain confirmations. Same shared strategy and risk code but isolated deployment, explicit arming, separate signer, and per-intent risk checks immediately before signing. Dashboard must not arm it. Missing chain confirmation -> `UNKNOWN`, reconcile signature and balance first.

## Execution interface contract

```ts
export type TradingMode = "DRY_RUN" | "PAPER" | "LIVE";
export type Side = "BUY" | "SELL";
export type OrderResult = {
  status:
    | "WOULD_TRADE"
    | "SIMULATED_FILLED"
    | "CONFIRMED"
    | "REJECTED"
    | "UNFILLABLE"
    | "EXPIRED"
    | "UNKNOWN";
  mode: TradingMode;
  orderId: string;
  amountInRaw: bigint;
  amountOutRaw?: bigint;
  txSignature?: string; // only LIVE
  reasonCodes: string[];
};
export interface Executor {
  execute(intent: TradeIntent, snapshot: MarketSnapshot): Promise<OrderResult>;
}
```

`DRY_RUN` returns only `WOULD_TRADE`/`REJECTED`. `PAPER` returns `SIMULATED_FILLED`/`REJECTED`/`UNFILLABLE`/`EXPIRED`. `LIVE` uses `CONFIRMED`/`UNKNOWN`/`REJECTED`/`EXPIRED` and stores actual tx signature. Validate this contract in tests.

## Required independent permission layers for LIVE

1. Build artifact: `apps/live-executor` package deployed separately.
2. Startup configuration: mode `LIVE` + locked `LIVE_TRADING_ENABLED=true` in live environment, never dashboard.
3. Explicit local CLI/admin approval (short-lived arming session, logged).
4. Signer allowlist and wallet balance/risk caps.
5. Kill switch at both worker and live-executor, fail-closed by default.

---
