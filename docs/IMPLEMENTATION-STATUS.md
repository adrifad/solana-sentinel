# Solana Sentinel Implementation Status

## Initial gap analysis

The provided checkout was a documentation blueprint, not an application. It contained only `AGENTS.md`, `README.md`, `SOLANA_SENTINEL_FULL_SPEC.md`, and a root-level `default.yaml`; the individually referenced `docs/` pages, canonical `config/default.yaml`, workspace, code, tests, migrations, and container files were absent. The compiled specification is retained unchanged and used as the implementation source.

## Delivered in this slice

- Strict TypeScript pnpm workspace and Zod/YAML validated mainnet `DRY_RUN` configuration.
- SQLite WAL migration, durable normalized PumpPortal events, bounded sanitized payloads, deterministic idempotency keys, first-seen/received times, event ingestion duration, token records, provider health, and migration-safe phase updates.
- One PumpPortal WebSocket client subscribing to launch and migration streams, with bounded message size, schema checks, heartbeat, reconnect/backoff, and graceful stop.
- Helius JSON-RPC health/genesis and account-info reader with response validation, deadline, retry, circuit breaker, and safe error codes.
- Read-only worker commands and API health/readiness/token routes, with readiness based on PumpPortal heartbeat freshness; no dashboard, signing, sending, wallet key, paper fills, or live arming.
- Fixture tests for config fail-closed cases, malformed/duplicate/out-of-order events, monitoring caps, Helius malformed responses and secret redaction.

## Provider contract limits

The official PumpPortal streaming reference verifies the WebSocket URL, `subscribeNewToken`, `subscribeMigration`, one-connection guidance, and that those two feeds are free. Its public page does not establish a stable event payload schema. The adapter therefore treats every payload as untrusted, accepts only recognized `txType`/`type`/`event` discriminator values plus a mint that validates as a public key, and rejects unknown shapes. The checked-in `.synthetic.json` files exercise this adapter contract; they are not provider captures. Confirm the discriminator values against a live sanitized capture before enabling persistent operation. The credentials needed for an actual provider connection were not supplied or used here.

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

Verified on Node.js 26.8.1 / pnpm 11.3.0:

- `pnpm install --offline --ignore-scripts`: passed.
- `pnpm typecheck`: passed with no TypeScript errors.
- `pnpm test`: 14 passed, 0 failed.
- `pnpm lint`: passed.
- `pnpm format:check`: passed.
- `DB_PATH=/tmp/sentinel-smoke.sqlite pnpm db:migrate`, `pnpm health`, and `pnpm tokens`: passed; fresh database reported zero events and no provider states.
- `PUMPPORTAL_API_KEY` unset with `pnpm dev:worker`: exited nonzero with `PUMPPORTAL_API_KEY is required ... no feed was started`, as intended.

Provider connectivity, a long-running stream, container deployment, and mainnet account reads require external credentials/network and were not verified from fixtures.

## Remaining milestones

1. Verify PumpPortal discriminators/fields with a sanitized live capture and add a captured fixture.
2. Reconcile gaps after reconnect from a documented Helius history method and persist source chain timestamps where available.
3. Add creator intelligence, role/evidence classification, token program and Token-2022 mint decoding, test-token heuristics, and fail-closed risk reports.
4. Add venue-specific current-state quotes before any paper execution. Missing or unsupported quote must never fill.
5. Add dashboard after API contracts and user-visible states stabilize.
6. Keep LIVE isolated and unimplemented until its separate readiness gates are completed.
