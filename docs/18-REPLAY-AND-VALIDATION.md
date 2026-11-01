# 18 — Replay, Shadow Trading and Strategy Evaluation

## Distinguish experiment types

- `DRY_RUN`: current mainnet events → analyze and log potential decisions; no virtual fills.
- `REALTIME_PAPER`: current mainnet events and state → conservative hypothetical order execution.
- `REPLAY_PAPER`: timestamped historical events + historical state snapshots → deterministic simulated execution.
- `SHADOW_RUN`: multiple strategy variants consume same feed and keep separate isolated ledgers and decisions.

## Historical correctness

Each historical observation needs availability timestamp (when the bot could have known it), not just the chain timestamp. Creator historical outcomes must be cut off at replay decision time. Never use a social post created later or eventual rug label in an earlier decision. If historic quote state is missing, label scenario untestable rather than filling using today's price.

## Core experiments

1. Entry delays `FAST` (analysis-complete) vs 30/60/120-second observation.
2. Creator reputation cache hit vs unknown creator quarantine.
3. Social optional enabled vs off (given same decision-time evidence).
4. Cost/latency sensitivity and token size sensitivity.
5. Risk threshold variants and false-positive rates.

## Metrics

- Net expectancy per trade (SOL), profit factor, median PnL, max drawdown, realized vs marked returns, worst-case unresolved positions.
- Quote availability/freshness, fill rate, abandoned candidates, percent trades unpriceable/exits impossible.
- Anti-scam recall/precision from delayed outcomes with transparent label criteria and confidence intervals.
- Strategy performance segmented by market regime, time of day, creator cache freshness and token phase.

## Avoid overfitting

Split training/development and forward holdout by date and creator; do not select winner on same launches used to tune thresholds. Report parameter search size and account for multiple testing. Shadow variants must not share virtual balances.

## Example report format

```markdown
# Paper run: 2026-11-01 to 2026-11-08

Mode: REALTIME_PAPER
Build SHA: abc123
Config SHA: ...
Completed trades: ...
Open, unpriceable positions: ...
Net realized SOL: ...
Conservative net marked SOL: ...
Max drawdown: ...
Quote failure rate: ...
Estimated execution latency p50/p95: ...
Important limitations: no real transaction landing, no market impact from our hypothetical orders.
```

---
