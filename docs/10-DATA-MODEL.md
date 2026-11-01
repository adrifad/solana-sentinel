# 10 — Data Model (SQLite for MVP)

## General conventions

- Use migrations, unique constraints, WAL mode, FK enforced, bounded retention, periodic backups.
- Timestamps ISO-8601 UTC or integer epoch millis; blockchain slot stored as integer separately.
- Store amount in raw integer units as **decimal strings** in SQLite (or typed reversible binary), not IEEE float. Do conversions in `bigint`.
- Version every decision/config/strategy and keep immutable audit records.

## Initial tables

| Table                | Key fields                                                                               | Notes                     |
| -------------------- | ---------------------------------------------------------------------------------------- | ------------------------- |
| `market_events`      | `id`, `source`, `signature`, `event_idx`, `mint`, `slot`, `received_at`, `payload_ref`   | Append-only, dedup key    |
| `tokens`             | `mint PK`, `program_id`, `created_slot`, `creator_id`, `market_phase`, `metadata`        | Distinguish phase         |
| `wallets`            | `pubkey PK`, `first_seen`, `last_seen`, `roles`                                          | Public keys only          |
| `wallet_links`       | `src`, `dst`, `type`, `confidence`, `evidence`, `observed_at`                            | Evidence-backed graph     |
| `creator_launches`   | `creator_pubkey`, `mint`, `created_at`, `outcome_status`, `outcome_asof`                 | Avoid hindsight           |
| `creator_reputation` | `creator_pubkey`, `computed_at`, `asof_slot`, `scores`, `flags`, `evidence`              | Cache with TTL            |
| `security_reports`   | `id`, `mint`, `asof_slot`, `checks`, `hard_block`, `quality`                             | Snapshot                  |
| `social_reports`     | `id`, `mint`, `source`, `verification_status`, `evidence`                                | Optional                  |
| `decisions`          | `id`, `mint`, `mode`, `status`, `reason_codes`, `config_version`, `snapshot_refs`        | Immutable                 |
| `orders`             | `id`, `intent_id`, `mode`, `side`, `amount_raw`, `status`, `quote_id`, `idempotency_key` | Full lifecycle            |
| `quotes`             | `id`, `venue`, `phase`, `slot`, `amount_in`, `amount_out`, `fee_breakdown`, `quote_at`   | No stale reuse            |
| `virtual_wallets`    | `id`, `strategy_id`, `initial_sol_raw`, `created_at`                                     | Paper only                |
| `ledger_entries`     | `id`, `wallet_id`, `order_id`, `asset_mint`, `delta_raw`, `type`                         | Append-only               |
| `positions`          | `wallet_id`, `mint`, `quantity_raw`, `cost_basis_raw`, `status`                          | Derived, reconcile        |
| `live_transactions`  | `order_id`, `signature`, `chain_status`, `actual_fee_raw`, `reconciled_at`               | Live only                 |
| `strategy_runs`      | `id`, `name`, `mode`, `config_hash`, `build_sha`                                         | Shadow/replay attribution |
| `config_revisions`   | `hash`, `actor`, `changed_at`, `validated_json`, `reason`                                | No secrets                |
| `service_health`     | `service`, `at`, `status`, `lag_ms`, `error_code`                                        | Operational               |

## Constraints and queries

- `market_events` unique `(source, signature, event_idx)` when signature exists; deterministic fallback for non-signature launch events.
- `orders.idempotency_key` unique across mode and strategy run.
- `ledger_entries` cannot be updated or deleted through API; corrections are compensating entries.
- Use atomic order fill + ledger write in one SQLite transaction.
- Index `(mint, slot)`, `(creator_pubkey, created_at)`, `(mode, status, created_at)`, `(wallet_id, asset_mint)`.
- Wallet links store `confidence` + `evidence`, no unsupported ownership assertions.

## Domain invariants

- No paper ledger mutation for DRY_RUN or LIVE.
- Paper buy debit and token credit plus applicable fees always balance.
- Ledger cannot create negative available cash without explicit margin design (not in MVP).
- Realized PnL only from completed sells with persisted quote/fill provenance.
- `UNPRICEABLE` positions remain part of risk exposure rather than disappearing from totals.

## Retention plan

Keep minimal normalized market events and decisions long enough for replay; rotate raw provider payload after configurable retention once references are verified. Back up DB with consistent SQLite backup mechanism, encrypt off host, test restoration monthly.

## Implemented migrations 5 and 6 tables

Migration `005-intelligence-security-decisions.sql` adds the persisted analysis queue, sanitized historical wallet transactions, wallet-role evidence, creator launches, evidence-backed wallet links, history refresh cursors, current and as-of creator reputation, token security reports, risk decisions, and DRY_RUN-only trade intents. Provider observations retain signatures, slots, timestamps, provenance, confidence, and reason codes where applicable. The current implementation does not create paper positions or live orders.

Migration `006-market-intelligence.sql` adds queried-wallet token outflow evidence, normalized time-indexed launch trade observations, launch behavior snapshots with explicit completeness/gap status, quote results with venue/source/snapshot fields, and a persistent Jupiter UTC-day request budget. Raw trade observations are not currently populated from PumpPortal because its trade event payload has not been validated in a sanitized capture.

Migration `007-paper-ledger.sql` adds isolated paper accounts, idempotent paper orders, atomic fills, double-entry journals, raw-amount positions, realized PnL, and portfolio equity/drawdown marks. Ledger updates and deletes are rejected by SQLite triggers. The schema exists for the standalone `@sentinel/paper` library; the application mode remains `DRY_RUN`, and the worker/API do not have a paper settlement path.

---
