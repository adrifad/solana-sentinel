# 04 — Configuration Contract

See [`config/default.yaml`](../config/default.yaml) and [`.env.example`](../.env.example).

## Sources and precedence

1. Compiled safe defaults (`DRY_RUN`, `live disabled`).
2. Versioned YAML (non-secrets) loaded at boot.
3. Environment variables for secrets and deployment-level hard locks.
4. Whitelisted UI-overrides for **non-critical** analysis and strategy parameters only, stored with actor, timestamp, version.

Deployment hard locks (mode, live enablement, wallet/signer identity, chain network, hard loss/position caps) can **never** be loosened through API/UI. Runtime settings may further **tighten** risk. Restart required for mode changes. Never accept arbitrary JSON configuration keys or silent type coercion.

## Critical env controls

- `APP_MODE=DRY_RUN|PAPER` — only startup; restart after any mode change. `LIVE` is unsupported.
- `LIVE_TRADING_ENABLED=false` — must be true at process startup for an independently approved live deployment, in addition to other checks.
- `LIVE_SIGNER_ENDPOINT` — allowed only inside separately deployed live executor; omit from scanner/paper worker.
- `HELIUS_API_KEY`, `PUMPPORTAL_API_KEY`, `JUPITER_API_KEY`, `PAPER_OPERATOR_TOKEN` — secrets, redacted. `PAPER_OPERATOR_TOKEN` must have at least 32 characters and is required by manual PAPER write routes.
- `APP_CONFIG_PATH=config/default.yaml`, `DB_PATH=./data/sentinel.db`.

## Config domains

- `discovery`: source, subscriptions, concurrent analysis cap, supported token programs.
- `analysis`: creator history page/transaction limits, cache TTL, tracing depth, refresh windows, analysis concurrency and timeout, minimum independent buyers, and minimum validated holder-sample supply coverage.
- `providers.jupiter`: opt-in quote-only adapter, request timeout/rate/day budgets, and maximum quote age. `JUPITER_API_KEY` is required to activate requests; missing slot/impact evidence still fails closed.
- `providers.pumpportal`: free create/migration feeds; `enable_token_trades` remains schema-locked false until provider payload validation. Observation window is configurable to 30/60/120 seconds.
- `providers.helius`: `enable_trade_stream` defaults false; if explicitly enabled, `max_active_trade_subscriptions` and `max_trade_events_per_day` cap the read-only logs observer. Coverage remains unverified without reconciliation.
- `security`: mint authority/extension policy, unknown handling, holder sampling size, snapshot freshness and slot-skew limits.
- `strategy`: entry timing, opportunity score and scoring weights, min observations.
- `paper`: initial virtual SOL, wallet id, latency simulation, quote stale window, fee model, conservative slippage, auto-entry opt-in, stop/take thresholds, monitor cadence, and bounded exit retry delays. Exit monitoring defaults to a 15-second base cadence and adapts up to 15 minutes using open-position count, estimated/observed quote RPC cost, remaining Helius daily request budget, and time until UTC reset. Set `position_monitor_estimated_rpc_requests` conservatively; the cadence is not a guaranteed exit time.
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
# APP_MODE=PAPER selects only the virtual settlement runtime; LIVE is rejected.
```

`paper.automatic_entries_enabled` and `providers.helius.enable_trade_stream` default to false. PAPER mode does not imply automatic entries. Authenticated manual requests may enqueue virtual orders; the worker still validates every risk and evidence gate. Compose applies the same `APP_MODE` to API and worker, defaulting to `DRY_RUN`, and publishes the API on loopback.

---
