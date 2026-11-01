# Solana Sentinel Foundation and Token Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the documentation-only blueprint into a runnable, read-only DRY_RUN service that validates config, persists PumpPortal launch and migration events idempotently, exposes health/token reads, and can query Helius safely.

**Architecture:** A pnpm workspace separates domain contracts, config, SQLite storage, provider adapters, and the worker/API process. Provider boundaries validate untrusted data with Zod; PumpPortal uses one reconnecting socket and Helius uses bounded JSON-RPC reads. SQLite migrations and stable event keys provide durable deduplication. This delivery has no signing, transaction submission, paper ledger, or live mode.

**Tech Stack:** Node.js LTS, TypeScript strict, pnpm, Zod, YAML, `ws`, built-in `node:sqlite`, Node test runner, Docker Compose.

---

## Current State

The checkout contains `AGENTS.md`, `README.md`, `SOLANA_SENTINEL_FULL_SPEC.md`, and a root-level `default.yaml`; it has no `docs/`, `config/`, package manifests, app code, tests, migrations, or Git metadata. The compiled spec is the available source for docs 00–20. Preserve the source bundle and config; create canonical project files alongside them.

## File Map

- `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `.gitignore`, `.env.example`: workspace scripts, strict compiler settings, and safe local defaults.
- `packages/domain/src/index.ts`: validated event and provider-health contracts shared across packages.
- `packages/config/src/index.ts`: YAML + environment loader, schema, deployment-safe mode checks, config hash.
- `packages/storage/src/index.ts`, `packages/storage/migrations/001-initial.sql`: SQLite WAL setup, idempotent migrations, append-only event and token repositories.
- `packages/providers/src/pumpportal.ts`: single socket, subscription replay, heartbeat, capped exponential reconnect, parser and bounded secret-redacted payload.
- `packages/providers/src/helius.ts`: timeout/retry/circuit-broken JSON-RPC health and account reads; secret-safe errors.
- `apps/worker/src/main.ts`: dependency composition, CLI, graceful stop, structured logs, safe start checks.
- `apps/api/src/server.ts`: read-only health/readiness and token endpoints.
- `tests/`: fixture-backed config, normalization, storage dedup/order, WebSocket lifecycle, Helius failure and redaction coverage.
- `docs/IMPLEMENTATION-STATUS.md`: state gap analysis, verified provider limits, exact validation results, and remaining milestones.
- `Dockerfile`, `docker-compose.yml`: non-live worker/API deployment with persistent SQLite volume.

## Task 1: Workspace and Config

- [ ] Define Node/pnpm workspace, strict TypeScript, scripts, and dependencies.
- [ ] Copy the existing sample to `config/default.yaml`; parse YAML and environment variables with Zod.
- [ ] Permit only `DRY_RUN` in this runtime; reject `PAPER`/`LIVE` clearly until executors exist.
- [ ] Keep credentials in env only; reject unknown config keys and invalid limits.

## Task 2: Domain and SQLite

- [ ] Define normalized launch/migration event and health contracts with UTC timestamps, slot, source, idempotency key, bounded raw payload, and local ingestion duration.
- [ ] Add versioned migration runner and WAL/foreign-key/busy-timeout setup using `node:sqlite`.
- [ ] Add idempotent event insertion and token upsert where migration phase cannot regress on an older creation event.
- [ ] Store first-seen separately from latest receipt and cap monitored tokens without dropping raw event records.

## Task 3: Providers

- [ ] Implement PumpPortal transport behind an injectable interface, one socket, `subscribeNewToken` and `subscribeMigration`, resubscribe on reconnect, heartbeat, bounded jittered retry, stop handling, input size limits, schema validation, payload redaction, and discovery cap accounting.
- [ ] Do not assume undocumented upstream fields. Require a valid mint; treat signature/slot/creator/time as optional validated evidence.
- [ ] Implement Helius JSON-RPC `getHealth`, `getGenesisHash`, and `getAccountInfo` with Zod response validation, timeout, bounded retry and circuit breaker. Do not log endpoint URLs or provider response bodies.
- [ ] Make provider states explicit: configured, connected/healthy, degraded, disabled, and last sanitized error code/time.

## Task 4: Service, API, and Operations

- [ ] Compose worker services deterministically; `start`, `health`, `tokens`, and `migrate` CLI commands.
- [ ] Start providers only when configured; `start` fails closed when discovery credentials/config are missing rather than claiming a live feed.
- [ ] Expose only unauthenticated read-only `/health`, `/ready`, `/api/tokens`, and `/api/tokens/:mint`; never accept mode, wallet, or execution settings over HTTP.
- [ ] Handle SIGINT/SIGTERM, close socket/server/database, and log structured redacted errors.
- [ ] Add non-root container and persistent data volume; no live executor or wallet env.

## Task 5: Verification and Handoff

- [ ] Add offline unit/integration tests for valid/invalid config, duplicate/out-of-order events, malformed/oversized messages, reconnect/resubscribe, stop, caps, Helius 429/5xx/timeout/malformed RPC, and secret redaction.
- [ ] Run install, migrations, tests, typecheck, lint, and build where available; record exact output.
- [ ] Update startup docs and current-state/limitations report. Do not claim external connectivity or production readiness without live evidence.

**Scope boundary:** Do not implement Sprint 2 forensics/security, Sprint 3 paper execution, UI, or any signing/submission path in this change.
