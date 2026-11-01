# 13 — Operations Runbook

## MVP deployment

- Deploy one worker plus API/web if needed on 2 vCPU / 4 GB / SSD as a **starting test target**, benchmark throughput and DB size.
- Run under systemd or Docker restart policies; isolated user, restricted permissions, persistent DB volume.
- Prefer localhost API + reverse proxy TLS and strong auth. Never expose SQLite or debug ports publicly.
- Do not deploy `live-executor` with MVP. No signer secrets on analysis server.

## Health indicators

- `websocket_connected`, `last_event_at`, `reconnect_count`, `events_per_second`, `ingestion_lag_ms`.
- `helius_rpc_success_rate`, `rpc_429_count`, `analysis_queue_depth`, `quote_age_ms`, `provider_cost_estimate`.
- `unpriceable_exposure`, `paper_ledger_integrity`, `risk_kill_switch`, `disk_free`, `db_backup_age`.
- Alert on stale feed, quote provider outage, budget exceeded, storage low, abnormal errors, ledger discrepancy.

## Routine tasks

**Daily:** review token/creator rejection reasons, provider budgets and staleness, ledger integrity, backups, drift in paper performance.  
**Weekly:** replay decision fixtures, review false positives/negatives, verify new Pump/Jupiter SDK and fee changes, rotate non-persistent logs.  
**Monthly:** restore test of backup, dependency review, rate-limit/cost audit, strategy validation without overfitting.

## Incidents and safe behavior

| Event                  | Immediate action                              | Recovery                               |
| ---------------------- | --------------------------------------------- | -------------------------------------- |
| PumpPortal down        | Disable new entries, mark scanner degraded    | Reconnect/reconcile missing events     |
| Helius degraded        | Quarantine unverified launches                | Validate snapshots after recovery      |
| Quote stale            | Disable paper fills for affected venue        | Fresh snapshot + tests                 |
| Risk cap hit           | Pause entries                                 | Review after risk reset with audit     |
| DB disk full           | Stop order progression safely                 | Expand disk, restore integrity, resume |
| Suspected key leak     | Disarm live, rotate credentials, isolate host | Reprovision distinct wallet/secret     |
| Source protocol change | Quarantine affected venue                     | Update parser/SDK, run fixtures        |

## Backups

Use SQLite online backup API or a consistent WAL-aware mechanism, encrypt and store separately, retain versions, periodically restore to a test instance. Do not copy only the main `.db` file while writes are active without handling WAL consistency.

## Cost management

Only subscribe to trade events for selected candidates and open positions. Unsubscribe when token rejected or watch timeout reached. Configure daily event limits and monthly budget; expose predicted provider spend in dashboard.

---
