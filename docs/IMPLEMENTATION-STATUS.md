# Solana Sentinel Implementation Status

## Initial gap analysis

The provided checkout was a documentation blueprint, not an application. It contained only `AGENTS.md`, `README.md`, `SOLANA_SENTINEL_FULL_SPEC.md`, and a root-level `default.yaml`; the individually referenced `docs/` pages, canonical `config/default.yaml`, workspace, code, tests, migrations, and container files were absent. The compiled specification is retained unchanged and used as the implementation source.

## Delivered in this slice

- Strict TypeScript pnpm workspace and Zod/YAML validated mainnet `DRY_RUN` configuration.
- SQLite WAL migrations through version 5, durable normalized PumpPortal events, bounded sanitized payloads, idempotency, separate create/migration slots, reported creator/trader roles, and provenance timestamps.
- One PumpPortal WebSocket client with message and pending-handler bounds, heartbeat, reconnect/backoff, resubscription, and callback draining during shutdown. Handler concurrency and pending queue capacity are validated runtime configuration (`event_processing_concurrency`, `max_pending_events`). Incoming events are persisted before asynchronous enrichment/processing; overflow closes the stream and is recorded as an unrecovered gap.
- Helius JSON-RPC reader with response validation, timeout, retries, circuit breaker, per-second pacing, persistent UTC-day request budget, and safe error codes.
- A durable SQLite enrichment queue consumes only monitoring-eligible events, claims work with bounded concurrency, retries transient failures, and recovers interrupted jobs after restart. Shutdown waits for claimed requests to settle before closing SQLite.
- Provider health stores socket state, last event/message time, last processed time, processing lag, queue depth, reconnect count, and provider error code separately. A shutdown drain cannot change `STOPPED` back to `HEALTHY`.
- Mint-account status and blockchain timestamp status are independent. A timestamp lookup failure does not erase a validated mint-account result, and successful timestamp results are retained across retries.
- Reused idempotency keys with contradictory slot or token metadata are recorded as provider conflicts. Signatures are preferred as event keys, then usable slots, then a deterministic payload digest; missing metadata does not silently merge unrelated events. Stream completeness reports unreconciled gaps and never labels observed stream data as complete history.
- Read-only worker commands and API health/readiness/token routes, with readiness based on PumpPortal heartbeat freshness; no dashboard, signing, sending, wallet key, paper fills, or live arming.
- Fixture tests for config fail-closed cases, malformed/duplicate/out-of-order events, monitoring caps, Helius malformed responses and secret redaction.
- Creator intelligence foundation: Pump CreateEvent decoding against the current public IDL layout; distinct claimed creator, launch initiator (`user`), and transaction fee payer evidence; historical finalized wallet signature pagination and transaction ingestion; cached, as-of-slot creator launch history; direct funding observations and repeated co-signer evidence with confidence. Direct exchange funding evidence is retained as a weak edge and is excluded from suspected-cluster membership.
- Token security foundation: SPL Token mint-state decoding, Token-2022 TLV parsing with unknown/malformed extensions failing closed, authority checks, metadata-only test-token heuristic, supply/holder snapshot comparisons, and sampled creator/cluster concentration.
- Explainable DRY_RUN analysis: every token creation has a durable analysis job, a security report, a risk decision, reason codes, evidence references, config hash, timestamp, and latency. Jobs recover after restart and incomplete history/security work is refreshed with bounded backoff. Over-budget tokens receive a missing-data report without Helius calls. No buy intent is generated while exit validation and complete holder distribution remain unavailable.
- Read-only detail routes expose token role evidence/security/decisions and creator reputation/launches/wallet links.

## Provider contract limits

The official PumpPortal streaming reference verifies the WebSocket URL, `subscribeNewToken`, `subscribeMigration`, and one-connection guidance, but does not publish event payload schemas or define `traderPublicKey` versus `creator`. A sanitized third-party PumpPortal create-event capture is checked in at `tests/fixtures/pumpportal-created.mainnet.capture.json`, with provenance in its evidence sidecar. Its signature was independently read from finalized mainnet RPC: the transaction signer and Pump create instruction's `user` account match `traderPublicKey`. This supports interpreting that field as the launch transaction initiator for this observed legacy create event; it does not prove that it is the token's canonical creator in all launch versions. The current Pump public IDL's `CreateEvent` separates `user` and `creator`; runtime evidence decoding records them separately, and the transaction's first required signer is stored as fee payer. The capture is third-party, not an official provider contract fixture, and was not collected in a live PumpPortal session. The current IDL parser is pinned to the documented event discriminator and field order; historical IDL compatibility is not established.

No sanitized PumpPortal migration-event capture was available, and no PumpPortal credentials were configured for live validation. Migration payload shape and role semantics therefore remain unvalidated. Existing `.synthetic.json` launch/migration fixtures are explicitly synthetic contract cases, not provider evidence. Creator Intelligence is implemented for create events that can be verified from finalized transactions; provider migration semantics and complete launch-version coverage remain a blocker to treating discovery as comprehensive.

PumpPortal does not document replay/cursor support on the public streaming page. A disconnect therefore creates a persisted gap record, and reconnection marks it `UNRECOVERED`. No complete-history claim is made. Helius can query known addresses/signatures, but a full missed-launch scan requires a verified program/event decoder and paging strategy that this foundation does not yet implement.

Helius uses the documented mainnet RPC endpoint and standard Solana `getHealth`, `getGenesisHash`, `getAccountInfo`, `getBlockTime`, `getSignaturesForAddress`, `getTransaction`, `getTokenSupply`, `getTokenLargestAccounts`, and `getMultipleAccounts` methods. Historical calls use finalized transaction data and are bounded by page size, analysis concurrency, a per-request rate limit, and a persisted UTC-day request budget. `getBlockTime` is an estimated ledger timestamp, separate from local receipt time. Mint and holder snapshots use confirmed RPC state and are checked for slot skew, freshness, and amount consistency. Without Helius credentials, chain history, mint state, and holder state remain unknown rather than inferred. The Helius credit cost is not separately calculated; the enforced limit is RPC request count, and plan-dependent provider costs were not validated.

The baseline retains later-phase intelligence, risk, paper, and provider settings as validated templates, but only settings used by this foundation/discovery slice affect runtime behavior. DEX Screener, Jupiter, social intelligence, and token-trade streaming are disabled until their adapters are implemented.

SQLite currently uses Node's built-in `node:sqlite` API. Node's official docs classify this API as Release Candidate in supported Node 24/26, so this reduces native dependency/setup complexity but remains a pre-stable runtime API risk for production. Pin Node and the SQLite API behavior, or replace the adapter with a stable SQLite binding before treating the service as production-ready.

## Safe startup

1. Use Node.js 24 or 26 and pnpm 11.
2. Copy `.env.example` to `.env`, set `PUMPPORTAL_API_KEY` and optionally `HELIUS_API_KEY`; keep the PumpPortal key private because it can be associated with a funded wallet.
3. Run `pnpm install --frozen-lockfile`, `pnpm db:migrate`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm docs:check`.
4. Start read-only discovery with `pnpm dev:worker`; the process refuses to start if the feed key is absent. In a second terminal, `pnpm dev:api` binds to `127.0.0.1:8787` by default.
5. Use `pnpm tokens` and `pnpm health` for local inspection. Only GET routes are implemented.

`APP_MODE` may only be `DRY_RUN` in this build. No credentials are needed for the config, migration, or offline tests. The root `default.yaml` is retained as supplied; `config/default.yaml` is the active app config.

## Validation record

Verified locally on Node.js 26.8.1 / pnpm 11.3.0 after the intelligence/security implementation:

- `pnpm install --offline --frozen-lockfile`: passed.
- `pnpm typecheck`: passed.
- `pnpm test`: 41 passed, 0 failed. Coverage includes create-capture parsing, event conflict/idempotency fallback, bounded overflow and reconnect simulations, shutdown drain races, independent mint/timestamp outcomes, schema upgrades, interrupted analysis recovery, provider response validation/timeouts, Pump CreateEvent role separation, Token-2022 fail-closed cases, creator/reputation storage, as-of refresh behavior, and DRY_RUN decision gating.
- `pnpm lint`: passed.
- `pnpm format:check`: passed.
- `pnpm docs:check`: passed; all README local links resolve.
- `DB_PATH=/tmp/solana-sentinel-ci-<run>.sqlite pnpm db:migrate`: passed on a fresh database.
- Migration tests cover version-one/version-two upgrades, partially applied columns, create/migration slot backfill, interrupted queue recovery, idempotent reopen behavior, and migration 5 intelligence/security schema creation.

PumpPortal provider connectivity and migration payload behavior, Helius credential-backed mainnet reads, long-running reconnect behavior against the provider, GitHub Actions execution, and Docker deployment were not verified. The environment had no `PUMPPORTAL_API_KEY` or `HELIUS_API_KEY`; mainnet integrations were not tested during this milestone. The create event is an independently checked third-party capture, not a live provider session. Synthetic fixtures are not production market data.

## Remaining milestones

1. Capture and validate PumpPortal migration events and verify event-version role semantics against finalized transactions; current migration payload behavior is an explicit limitation.
2. Add a Helius-backed missed-launch reconciler only after validating program-history paging and historical Pump instruction/event variants; current stream gaps remain unrecovered.
3. Expand token security with supported token extension decoding and audited allowlists; currently unknown extensions fail closed and several known extensions are classified conservatively.
4. Add reliable all-holder/venue-specific current-state sell quotes before any `BUY_ELIGIBLE` decision or paper execution. No profitability metric is calculated from incomplete trading history.
5. Add authorized dashboard and configuration workflows after API contracts stabilize; the API remains read-only.
6. Keep PAPER and LIVE unimplemented and signing isolated until their separate safety gates are completed.
