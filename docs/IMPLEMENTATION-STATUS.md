# Solana Sentinel Implementation Status

## Initial gap analysis

The provided checkout was a documentation blueprint, not an application. It contained only `AGENTS.md`, `README.md`, `SOLANA_SENTINEL_FULL_SPEC.md`, and a root-level `default.yaml`; the individually referenced `docs/` pages, canonical `config/default.yaml`, workspace, code, tests, migrations, and container files were absent. The compiled specification is retained unchanged and used as the implementation source.

## Delivered in this slice

- Strict TypeScript pnpm workspace and Zod/YAML validated mainnet `DRY_RUN` configuration.
- SQLite WAL migrations through version 3, durable normalized PumpPortal events, bounded sanitized payloads, idempotency, separate create/migration slots, reported creator/trader roles, and provenance timestamps.
- One PumpPortal WebSocket client with message and pending-handler bounds, heartbeat, reconnect/backoff, resubscription, and callback draining during shutdown. Handler concurrency and pending queue capacity are validated runtime configuration (`event_processing_concurrency`, `max_pending_events`). Incoming events are persisted before asynchronous enrichment/processing; overflow closes the stream and is recorded as an unrecovered gap.
- Helius JSON-RPC reader with response validation, timeout, retries, circuit breaker, per-second pacing, persistent UTC-day request budget, and safe error codes.
- A durable SQLite enrichment queue consumes only monitoring-eligible events, claims work with bounded concurrency, retries transient failures, and recovers interrupted jobs after restart. Shutdown waits for claimed requests to settle before closing SQLite.
- Provider health stores socket state, last event/message time, last processed time, processing lag, queue depth, reconnect count, and provider error code separately. A shutdown drain cannot change `STOPPED` back to `HEALTHY`.
- Mint-account status and blockchain timestamp status are independent. A timestamp lookup failure does not erase a validated mint-account result, and successful timestamp results are retained across retries.
- Reused idempotency keys with contradictory slot or token metadata are recorded as provider conflicts. Signatures are preferred as event keys, then usable slots, then a deterministic payload digest; missing metadata does not silently merge unrelated events. Stream completeness reports unreconciled gaps and never labels observed stream data as complete history.
- Read-only worker commands and API health/readiness/token routes, with readiness based on PumpPortal heartbeat freshness; no dashboard, signing, sending, wallet key, paper fills, or live arming.
- Fixture tests for config fail-closed cases, malformed/duplicate/out-of-order events, monitoring caps, Helius malformed responses and secret redaction.

## Provider contract limits

The official PumpPortal streaming reference verifies the WebSocket URL, `subscribeNewToken`, `subscribeMigration`, and one-connection guidance, but does not publish event payload schemas or define `traderPublicKey` versus `creator`. A sanitized third-party PumpPortal create-event capture is checked in at `tests/fixtures/pumpportal-created.mainnet.capture.json`, with provenance in its evidence sidecar. Its signature was independently read from finalized mainnet RPC: the transaction signer and Pump create instruction's `user` account match `traderPublicKey`. This supports interpreting that field as the launch transaction initiator for this observed legacy create event; it does not prove that it is the token's canonical creator in all launch versions. Pump's public instruction documentation distinguishes the transaction `user` from a separate `creator` value, so the adapter retains both roles separately. The capture is third-party, not an official provider contract fixture, and was not collected in a live PumpPortal session.

No sanitized PumpPortal migration-event capture was available, and no PumpPortal credentials were configured for live validation. Migration payload shape and role semantics therefore remain unvalidated. Existing `.synthetic.json` launch/migration fixtures are explicitly synthetic contract cases, not provider evidence. Creator Intelligence must wait until migration contracts are validated; no creator reputation or historical launch ingestion is implemented in this slice.

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

Verified locally on Node.js 26.8.1 / pnpm 11.3.0 after the hardening pass:

- `pnpm typecheck`: passed.
- `pnpm test`: 26 passed, 0 failed. This includes create-capture parsing, event conflict/idempotency fallback, bounded overflow and reconnect simulations, shutdown drain races, independent mint/timestamp outcomes, storage migrations, and completeness reporting.
- `pnpm lint`: passed.
- `pnpm format:check`: passed.
- `pnpm docs:check`: passed; all README local links resolve.
- `DB_PATH=/tmp/solana-sentinel-hardening-final2.sqlite pnpm db:migrate`: passed on a fresh database.
- Migration tests cover version-one/version-two upgrades, partially applied columns, create/migration slot backfill, interrupted queue recovery, idempotent reopen behavior, and migration 4 schema creation.

PumpPortal provider connectivity and migration payload behavior, Helius credential-backed mainnet reads, long-running reconnect behavior against the provider, GitHub Actions execution, and Docker deployment were not verified. The create event is an independently checked third-party capture, not a live provider session. Synthetic fixtures are not production market data.

## Remaining milestones

1. Obtain sanitized live PumpPortal launch and migration captures and verify discriminator/role semantics across launch versions before treating event fields as provider-confirmed.
2. Implement a Helius-backed gap reconciler only after selecting and validating the relevant program history and transaction decoder; current gaps remain explicitly unrecovered.
3. After launch and migration data contracts are validated, add creator identity/evidence, historical launch and wallet activity ingestion, and incrementally updated reputation. Do not calculate profitability from incomplete trade history. Token program and Token-2022 mint decoding, test-token heuristics, and fail-closed risk reports remain later work.
4. Add venue-specific current-state quotes before any paper execution. Missing or unsupported quote must never fill.
5. Add dashboard after API contracts and user-visible states stabilize.
6. Keep LIVE isolated and unimplemented until its separate readiness gates are completed.
