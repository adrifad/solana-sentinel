# 04 — Configuration Contract

See [`config/default.yaml`](../config/default.yaml) and [`.env.example`](../.env.example).

## Sources and precedence

1. Compiled safe defaults (`DRY_RUN`, `live disabled`).
2. Versioned YAML (non-secrets) loaded at boot.
3. Environment variables for secrets and deployment-level hard locks.
4. Whitelisted UI-overrides for **non-critical** analysis and strategy parameters only, stored with actor, timestamp, version.

Deployment hard locks (mode, live enablement, wallet/signer identity, chain network, hard loss/position caps) can **never** be loosened through API/UI. Runtime settings may further **tighten** risk. Restart required for mode changes. Never accept arbitrary JSON configuration keys or silent type coercion.

## Critical env controls

- `APP_MODE=DRY_RUN|PAPER|LIVE` — only startup; restart after any mode change.
- `LIVE_TRADING_ENABLED=false` — must be true at process startup for an independently approved live deployment, in addition to other checks.
- `LIVE_SIGNER_ENDPOINT` — allowed only inside separately deployed live executor; omit from scanner/paper worker.
- `HELIUS_API_KEY`, `PUMPPORTAL_API_KEY`, `JUPITER_API_KEY` — secrets, redacted.
- `APP_CONFIG_PATH=config/default.yaml`, `DB_PATH=./data/sentinel.db`.

## Config domains

- `discovery`: source, subscriptions, concurrent analysis cap, supported token programs.
- `analysis`: creator history page/transaction limits, cache TTL, tracing depth, refresh windows, analysis concurrency and timeout.
- `security`: mint authority/extension policy, unknown handling, holder sampling size, snapshot freshness and slot-skew limits.
- `strategy`: entry timing, opportunity score and scoring weights, min observations.
- `paper`: initial SOL, latency simulation, quote stale window, fee model, conservative slippage.
- `risk`: per-order max SOL, max exposure, position count, daily loss, max drawdown, maximum quote price impact.
- `observability`: health thresholds, budgets, event logging retention.

## Validation rules

- All percentages in config are **basis points** (100 bps = 1%). UI converts to percentage for display.
- Max loss and drawdown limits >0 and <100%, order sizing positive, exposure >= per-trade limit.
- Quote `max_age_ms` cannot be negative. Unknown/stale is disallowed for fills.
- Strategy weights total 100; `MIN_SCORE` within 0–100; overrides subject to schema and bounds.
- For `LIVE`, validate startup-only `live` manifest (`wallet allowlist`, SOL budget, chain ID, allowlisted venues) and explicit authorization. See 09.

## Configuration changes

1. Operator submits UI edit → validate patch against whitelisted schema.
2. Persist immutable config revision and actor / reason.
3. Apply only at documented safe boundary (next token decision), never mid-order.
4. Every decision saves `config_version`, `strategy_version`, `build_sha`.
5. Emergency pause may always be activated immediately, regardless of mode.

## Example mode selection (implemented app)

```bash
APP_MODE=DRY_RUN pnpm dev:worker
# PAPER and LIVE are rejected by this runtime.
```

The current runtime accepts `DRY_RUN` only. The API is read-only and cannot arm or change execution mode.

---
