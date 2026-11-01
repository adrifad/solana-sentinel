# Solana Sentinel Implementation Status

## Initial gap analysis

The provided checkout was a documentation blueprint, not an application. It contained only `AGENTS.md`, `README.md`, `SOLANA_SENTINEL_FULL_SPEC.md`, and a root-level `default.yaml`; the individually referenced `docs/` pages, canonical `config/default.yaml`, workspace, code, tests, migrations, and container files were absent. The compiled specification is retained unchanged and used as the implementation source.

## Delivered in this slice

- Strict TypeScript pnpm workspace and Zod/YAML validated mainnet `DRY_RUN` configuration.
- SQLite WAL migrations through version 3, durable normalized PumpPortal events, bounded sanitized payloads, idempotency, separate create/migration slots, reported creator/trader roles, and provenance timestamps.
- One PumpPortal WebSocket client with message and pending-handler bounds, heartbeat, reconnect/backoff, resubscription, and callback draining during shutdown. Overflow closes the stream and is recorded as an unrecovered gap.
- Helius JSON-RPC reader with response validation, timeout, retries, circuit breaker, per-second pacing, persistent UTC-day request budget, and safe error codes.
- A durable SQLite enrichment queue consumes only monitoring-eligible events, claims work with bounded concurrency, retries transient failures, and recovers interrupted jobs after restart. Shutdown waits for claimed requests to settle before closing SQLite.
- Provider health stores socket state, last event/message time, last processed time, processing lag, queue depth, reconnect count, and provider error code separately.
- Read-only worker commands and API health/readiness/token routes, with readiness based on PumpPortal heartbeat freshness; no dashboard, signing, sending, wallet key, paper fills, or live arming.
- Fixture tests for config fail-closed cases, malformed/duplicate/out-of-order events, monitoring caps, Helius malformed responses and secret redaction.

## Provider contract limits

The official PumpPortal streaming reference verifies the WebSocket URL, `subscribeNewToken`, `subscribeMigration`, one-connection guidance, and that those two feeds are free. It does not publish the event payload schema or define `traderPublicKey` versus `creator`. The adapter preserves `traderPublicKey` as `launchInitiator` and `creator` as a separate provider-reported creator claim, but the semantic mapping remains unverified. The checked-in `.synthetic.json` files exercise that distinction; they are not provider captures. No live sanitized capture or provider credentials were available, so payload validation remains incomplete.

PumpPortal does not document replay/cursor support on the public streaming page. A disconnect therefore creates a persisted gap record, and reconnection marks it `UNRECOVERED`. No complete-history claim is made. Helius can query known addresses/signatures, but a full missed-launch scan requires a verified program/event decoder and paging strategy that this foundation does not yet implement.

Helius uses the documented mainnet RPC endpoint and standard Solana `getHealth`, `getGenesisHash`, `getAccountInfo`, and `getBlockTime` methods. `getBlockTime` is an estimated ledger timestamp, separate from local receipt time. `getAccountInfo` currently returns raw owner/data/slot only; mint layout and Token-2022 extension parsing are intentionally deferred to the security milestone. Without Helius credentials, chain timestamps and mint state remain unknown rather than inferred.

The baseline retains later-phase intelligence, risk, paper, and provider settings as validated templates, but only settings used by this foundation/discovery slice affect runtime behavior. DEX Screener, Jupiter, social intelligence, and token-trade streaming are disabled until their adapters are implemented.

SQLite currently uses Node's built-in `node:sqlite` API. Node's official docs classify this API as Release Candidate in supported Node 24/26, so this reduces native dependency/setup complexity but remains a pre-stable runtime API risk for production. Pin Node and the SQLite API behavior, or replace the adapter with a stable SQLite binding before treating the service as production-ready.

## Safe startup

1. Use Node.js 24 or 26 and pnpm 11.
2. Copy `.env.example` to `.env`, set `PUMPPORTAL_API_KEY` and optionally `HELIUS_API_KEY`; keep the PumpPortal key private because it can be associated with a funded wallet.
3. Run `pnpm install`, `pnpm db:migrate`, `pnpm test`, `pnpm typecheck`, `pnpm lint`.
4. Start read-only discovery with `pnpm dev:worker`; the process refuses to start if the feed key is absent. In a second terminal, `pnpm dev:api` binds to `127.0.0.1:8787` by default.
5. Use `pnpm tokens` and `pnpm health` for local inspection. Only GET routes are implemented.

`APP_MODE` may only be `DRY_RUN` in this build. No credentials are needed for the config, migration, or offline tests. The root `default.yaml` is retained as supplied; `config/default.yaml` is the active app config.

## Validation record

Verified locally on Node.js 26.8.1 / pnpm 11.3.0:

- `pnpm typecheck`: passed.
- `pnpm test`: 21 passed, 0 failed. This includes storage/provider integration tests and deterministic failure-mode simulations.
- `pnpm lint`: passed.
- `pnpm format:check`: passed.
- `pnpm docs:check`: passed; all README local links resolve.
- `DB_PATH=/tmp/solana-sentinel-hardening-final2.sqlite pnpm db:migrate`: passed on a fresh database.
- Migration tests cover version-one/version-two upgrades, partially applied columns, create/migration slot backfill, interrupted queue recovery, and idempotent reopen behavior.

PumpPortal provider connectivity, a live payload capture, Helius mainnet reads, long-running reconnect behavior against the provider, GitHub Actions execution, and Docker deployment require external credentials/network or GitHub and were not verified. Synthetic fixtures are not production market data.

## Remaining milestones

1. Obtain a sanitized PumpPortal capture and verify discriminator/role semantics before treating event fields as provider-confirmed.
2. Implement a Helius-backed gap reconciler only after selecting and validating the relevant program history and transaction decoder; current gaps remain explicitly unrecovered.
3. Add creator intelligence, role/evidence classification, token program and Token-2022 mint decoding, test-token heuristics, and fail-closed risk reports.
4. Add venue-specific current-state quotes before any paper execution. Missing or unsupported quote must never fill.
5. Add dashboard after API contracts and user-visible states stabilize.
6. Keep LIVE isolated and unimplemented until its separate readiness gates are completed.
