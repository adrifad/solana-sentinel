# 07 — Security Gate, Opportunity Score and Risk Engine

## Decision levels

- `REJECT`: confirmed hard-block condition.
- `QUARANTINE`: insufficient/contradictory/stale evidence or unsupported token features.
- `WATCH`: pass mandatory checks but no actionable entry opportunity yet.
- `BUY_ELIGIBLE`: mandatory checks pass **and** an independent strategy/risk decision allows entry.

## Mandatory token checks

- Validate token program type, mint supply/decimals, mint authority and freeze authority.
- For Token-2022, inspect permanent delegate, transfer hook (including program allowlist and sellability), transfer fees, non-transferable, default account state and other relevant extensions.
- Classify mint/pool/curve phase correctly; verify venue program and accounts.
- Measure creator + suspected cluster exposure; confidence-weighted, do not overclaim wallet ownership.
- Estimate effective **sell** output and price impact for intended size; handle quote unavailable as `QUARANTINE` or `UNFILLABLE`.
- Flag creator prior malicious outcomes with verifiable signatures; suspected patterns usually add risk rather than automatic confirmed-scam labels.
- Reject token if cannot establish safe transfer/sell route with current supported token program and venue.
- Inspect whether current token resembles testing/spam launch; unknown classification should not be treated as organic.

## Hard gate defaults

| Reason code                           | Policy            | Note                                                    |
| ------------------------------------- | ----------------- | ------------------------------------------------------- |
| `MINT_AUTHORITY_UNSAFE`               | REJECT            | Unless a reviewed, explicitly allowed authority pattern |
| `FREEZE_AUTHORITY_UNSAFE`             | REJECT            | Similar exception policy                                |
| `PERMANENT_DELEGATE_UNTRUSTED`        | REJECT            | Can authorize transfers or burns                        |
| `TRANSFER_HOOK_UNSUPPORTED`           | QUARANTINE/REJECT | Could restrict transfers                                |
| `TRANSFER_RESTRICTION`                | REJECT            | Cannot transfer/sell                                    |
| `CREATOR_CONFIRMED_ABUSE`             | REJECT            | Evidence standard required                              |
| `EXIT_QUOTE_UNAVAILABLE`              | QUARANTINE        | Do not fill paper buy without exit coverage             |
| `DATA_STALE` / `PROVIDER_TIMEOUT`     | QUARANTINE        | Fail closed                                             |
| `LIKELY_TEST_TOKEN`                   | QUARANTINE        | Optional exclusion by strategy                          |
| `LOW_LIQUIDITY` / `HIGH_PRICE_IMPACT` | REJECT entry      | Position-size dependent                                 |
| `LOSS_LIMIT_REACHED` / `KILL_SWITCH`  | REJECT entry      | Global hard stop                                        |

Token program semantics vary: a standard Pump.fun token and a custom Token-2022 mint must not be graded with identical assumptions.

## Implemented DRY_RUN gate

The current worker persists `SUPPORTED`, `UNSUPPORTED`, `MISSING`, or `UNSAFE` mint/security reports and `REJECT`, `QUARANTINE`, `WATCH`, or `BUY_ELIGIBLE` decisions with evidence references, config hash, timestamps, and analysis latency. The SPL base mint layout and a conservative Token-2022 TLV parser are implemented. Unknown/malformed extensions fail closed; active mint/freeze authorities are classified unsafe. Holder concentration is sampled and explicitly incomplete. Test-token metadata patterns are persisted with a separate heuristic confidence.

Holder completeness remains `false`; the scanner never treats a sample as exhaustive. Reports separately expose the count, validated status, and share of total supply covered by the validated largest-account sample. The explicit `analysis.min_holder_sample_coverage_bps` default is 9000 (90% of supply); a sample only satisfies this policy when every selected holder account is decoded and matches its indexed amount. This is a conservative policy threshold, not an empirically calibrated safety guarantee.

The current worker still cannot produce `BUY_ELIGIBLE`: Jupiter quote-only results have no verified chain snapshot slot and no guaranteed price-impact field, Pump curve state acquisition is not wired, and PumpSwap quotes are unsupported. Exit validation remains `UNKNOWN` or fails closed. No order is submitted and no virtual portfolio is changed. A successful mint decode or a high sample-coverage value by itself does not imply the full security gate passed.

## Opportunity score (only after hard gate)

Example initial score: `creator_history 30`, `token_security 25`, `launch_behavior 20`, `exit_liquidity 15`, `social_confidence 10`, total 100. If social disabled, re-normalize weights **only**; never turn missing critical security data into zero-risk.

`score >= 80` is a starting experimental threshold, not calibrated statistical evidence. Version model and thresholds; run shadow experiments before optimizing.

## Risk policy (illustrative conservative defaults)

- Max notional per trade: 0.05 SOL.
- Max total exposure: 0.20 SOL.
- Max open positions: 3.
- Max daily loss: 0.10 SOL or configurable fraction of starting equity, whichever is stricter.
- Max portfolio drawdown: 500 bps (5%).
- Max buy/sell price impact: 300 bps (3%) and slippage tolerance 200 bps (2%), subject to venue constraints.
- Reject order if market event older than configured TTL, market state changed before fill, fee estimate unavailable, or quote too old.
- Emergency stop blocks new buys and optionally triggers _separately controlled_ risk-managed liquidation; liquidation may be impossible.

**These defaults are placeholders to adjust through experiments, not financial recommendations.**

## Entry/exit policies

Entry selection `FAST` only for cached creator evidence plus full mandatory current-token check; `VALIDATED` observes trade behavior 30/60/120s. Exit may use time-based, trailing guard, risk cut, or suspected malicious activity detection, all after evaluating sell feasibility. Stop loss is not guaranteed to execute if trading is frozen or liquidity vanishes.

## Audit report example

```json
{
  "mint": "<token-mint>",
  "decision": "QUARANTINE",
  "reasonCodes": ["CREATOR_HISTORY_UNKNOWN", "DATA_STALE"],
  "criticalChecksPassed": false,
  "opportunityScore": null,
  "configVersion": "sha256:...",
  "observedSlot": 123456789,
  "decisionAtUtc": "2026-10-31T12:00:00Z"
}
```

---
