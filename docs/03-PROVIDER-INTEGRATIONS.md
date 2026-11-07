# 03 — Provider Integrations and Fallbacks

## PumpPortal — discovery + optional trade stream

- WebSocket: `wss://pumpportal.fun/api/data?api-key=<PUMPPORTAL_API_KEY>`.
- Subscribe: `subscribeNewToken`, `subscribeMigration`, `subscribeTokenTrade`, `subscribeAccountTrade`.
- **One socket** and dynamically update subscriptions; do not open a connection per mint.
- Creation/migration streaming is listed as free; trade/account streams are metered and may require linked wallet funding. Check provider pricing and enforce monthly event budgets.
- Official provider guidance currently prices trade streams at 0.01 SOL per 10,000 received events and says the linked wallet must have at least 0.02 SOL. A live `subscribeTokenTrade` request was denied because the configured linked wallet did not meet that minimum. This runtime keeps `enable_token_trades: false`; it has no validated trade-payload adapter, metered subscription lifecycle, or raw event budget enforcement yet.
- The official reference documents `subscribeTokenTrade` / `unsubscribeTokenTrade` and the charge model, but does not specify trade-message fields or a payload version contract. PumpPortal metered subscriptions remain disabled. The optional Helius standard `logsSubscribe` observer is behind `providers.helius.enable_trade_stream: false`; it decodes pinned Pump SDK 4.1.0 `TradeEvent` and PumpSwap SDK 2.1.0 `BuyEvent`/`SellEvent` layouts only inside successful matching program invocations. It then correlates finalized signature, slot, mint, signer, exact token balance delta, event time, and canonical PumpSwap pool state. These decoders have synthetic contract tests only. The bounded `validate:trade-events` harness can examine at most 20 recent signatures and capture only verified public normalized evidence. Its 2026-11-01 run was blocked by `PROVIDER_UNAVAILABLE` before examining any signature. Coverage remains `UNVERIFIED`; no historical reconciliation is implemented.
- Security note: PumpPortal **Lightning API key may control its linked wallet**. Even for read-only data, treat it as a signing-capable secret; never fund that wallet with trading capital for MVP.
- Parse and validate event signatures, blockchain slot, mint, creator, tx type and amounts. Store unknown fields in redacted raw record for forward compatibility.
- On reconnect: use jittered exponential backoff and restore subscriptions. Each interruption is persisted as an unreconciled gap; bounded recent-signature validation is diagnostic only and is not an integrated reconciler. `getSignaturesForAddress(mint)` plus bounded `getTransaction` reads cannot currently establish exhaustive venue coverage, so gaps remain unrecovered and status stays `UNVERIFIED`. At-most-once receipt is not guaranteed.

## Helius — on-chain source of truth / transaction history

- Implemented standard JSON-RPC reads: `getHealth`, `getGenesisHash`, `getAccountInfo`, `getBlockTime`, `getSignaturesForAddress`, `getTransaction`, `getTokenSupply`, `getTokenLargestAccounts`, and `getMultipleAccounts`. Wallet-history calls are paginated, finalized, and bounded by configured request budgets.
- Enforce allowed methods/credits, pagination, timeouts, retry budgets, and backoff on 429/5xx.
- For creator attribution, distinguish token creator claim vs deployer/transaction fee payer vs mint authority vs other wallet roles.
- Keep provenance: `{rpc_method, endpoint_label, signature, slot, fetched_at, provider_version}`.
- Prefer blockchain/decoded official program state over a third-party classification label.
- RPC requests use an internal daily cap. `exit_reserved_requests_per_utc_day` reserves capacity from candidate/background calls for exit and risk-critical monitoring; this application request budget is not a measure of Helius credits or provider-side entitlement.
- Per-attempt diagnostics retain RPC method, priority, component, purpose, subject mint when known, attempt, outcome, and safe provider error code. Readiness exposes internal daily usage and per-method totals. Healthy RPC does not imply trade-stream access or observation completeness.

### Parsed Events Scan reconciliation

The optional historical reconciler calls Helius `POST /v1/parsed-events/scan` for each monitored mint and matches all instructions from the Pump.fun and PumpSwap programs. It intentionally omits instruction-name filters so a newer instruction variant cannot be silently excluded. Results are candidate transactions only: finalized `getTransaction` data still passes the existing signature, slot, program-log, signer, token-balance and amount checks before any trade observation is stored.

The worker resumes `paginationToken` from SQLite. Empty `data` is not completion evidence. The job waits until `window_expires_at_utc + parsed_events_scan_finality_buffer_seconds` before querying with `commitment: finalized`; that buffer is persisted on the job. Coverage becomes `COMPLETE` only after Helius reports `stoppedOn: windowEnd` with no cursor and every matched transaction is verified or explicitly classified as a recognized non-trade. Unsupported instructions, failed verification, provider errors, budget exhaustion, or unresolved work keep coverage partial or unverified. Page-limit results remain partial and resume from their persisted cursor. Scan credits have their own persistent UTC-day budget, separate from JSON-RPC request counts. The feature defaults off and its credit cap defaults to zero; enabling it can consume Parsed Events credits.

Pump/PumpSwap scan summaries are only candidates. The parser requires successful transaction parse status, matching protocol/program, a supported WSOL/token pair, and a direction consistent with the pair (BUY: WSOL to requested mint; SELL: requested mint to WSOL). The verified `getTransaction` decoder must then agree on signature, slot, block time, mint, and BUY/SELL direction before persistence. Unsupported quote pairs and ambiguous summaries stay unsupported. A finalized scan that completes or changes coverage, and each newly inserted verified observation, adds a deduplicated durable analysis requeue trigger. Evidence that arrives while analysis is running schedules one follow-up pass. Launch behavior uses its chain-time window and current decision time, but is not capped by the original launch slot, so later in-window trades are included. Prior decisions remain immutable and are not retroactively rewritten.

The configurable finality buffer is a conservative delay before scanning, not a provider watermark. Scan boundaries use the matching whole-second block-time interval, and any edge candidates outside the persisted observation timestamps are excluded before transaction verification. Completion still depends on the documented finalized scan response, exhausted pagination, and resolution of all matched transactions. Older `COMPLETE` records without persisted finality metadata are downgraded to `PARTIAL` by migration 018 and must be rescanned before they can be complete again.

See the official [Parsed Events Scan API](https://www.helius.dev/docs/api-reference/parsed-events/scan). Live entitlement, account-specific credit pricing, and decoder compatibility against live trade transactions remain unverified unless a bounded mainnet run is recorded separately.

## DEX Screener — supplemental market/social metadata

- Endpoint: `GET https://api.dexscreener.com/token-pairs/v1/solana/{tokenAddress}`.
- Useful for pool info, `liquidity`, `txns`, `volume`, links and DEX phase. Public API, rate limited.
- **Not authoritative at launch:** new Pump.fun tokens may not be indexed immediately; missing pair is NOT automatically a scam. Do not use DEX Screener alone for Pump curve pricing.
- Cache endpoint responses with short TTL; never use an old price to claim a live fill.

## Jupiter Swap V2 — read-only quote and eventual live trading

- API base: `https://api.jup.ag/swap/v2`; documented `GET /order` and `POST /execute`.
- The implemented adapter calls only `GET /order` without `taker`, validates the documented quote fields, rejects any response carrying a transaction, and never calls `/execute`. It is opt-in with `providers.jupiter.enabled`, `JUPITER_API_KEY`, request pacing, timeout, and a persistent UTC-day request cap.
- The current `/order` contract does not provide a verified Solana snapshot slot in the contract used here; quote results preserve that as unknown. Missing impact data, state slot, or freshness prevents exit validation from passing. Jupiter quotes are therefore evidence, not a BUY authorization.
- **Paper:** only quote path; no transaction signing and never call `/execute`.
- **Live:** only inside isolated live-executor; validate mint, route, min-out, fees, expiry and transaction before signing; reconcile signature on-chain.
- New Pump curve tokens may not have an immediately available Jupiter route; use official Pump SDK math / verified on-chain state rather than inventing a price.

## Pump.fun and PumpSwap official SDKs

- Pinned read-only quote calculation dependency: `@pump-fun/pump-sdk@4.1.0`. `PumpCurveStateLoader` uses bounded Helius account batches and validates mint, curve, global/fee configuration, token program, and associated fee accounts before the quote engine calls current exact-input buy/sell SDK math. Completed/migrated curves are explicitly unsupported.
- `@pump-fun/pump-swap-sdk@2.1.0` supports the canonical WSOL PumpSwap pool. `PumpSwapStateLoader` validates pool/global/fee/mint/vault ownership and slot coherence; the quote engine calls current SDK exact-input math and checks real sell-side quote liquidity. Custom quote mints or pool layouts remain unsupported. Live state captures verify account decoding and SDK calculations for those snapshots, not transaction execution.
- Pin versions only after checking official latest docs/IDL against supported programs; do not copy old constant-product formulas blindly. Pump protocol introduced v3 trades and v2 PumpSwap, multi-hop and negative virtual reserve handling in 2026.
- Treat migration as a state transition and invalidate old quote snapshots. Quote output includes fee assumptions and provenance; avoid double-charging fees.

## Provider fallback matrix

| Primary failure               | Safe behavior                                                               |
| ----------------------------- | --------------------------------------------------------------------------- |
| PumpPortal socket down        | Pause discovery/entry; expose degraded health; reconcile gaps               |
| Helius on-chain state missing | `QUARANTINE`; no BUY                                                        |
| DEX Screener unavailable      | Skip supplemental metadata, continue on verified chain state where possible |
| Curve/pool quote unavailable  | Reject/expire order; no paper fill                                          |
| Jupiter `/order` unavailable  | Do not use old quote or execute                                             |
| Discord/X/website unavailable | Social status `UNVERIFIED`, never invent endorsement                        |

## Provider cost controls

Live validation on 2026-11-01 confirmed the configured PumpPortal key can connect to free create/migration feeds and produced a sanitized create capture verified against finalized Helius transaction and account evidence. The official reference documents subscribe/unsubscribe methods and the charge model, but does not define trade message fields. A bounded PumpPortal trade subscription attempt was rejected because the linked wallet did not meet the documented 0.02 SOL minimum. No real trade payload was received or normalized in that validation. One Pump curve state and one canonical PumpSwap state were captured through Helius and decoded with pinned official SDKs; quote vectors are recorded in the implementation status. The optional Helius log observer is new in the current runtime but has only synthetic test coverage.

Set `max_monitored_tokens`, `monitoring_duration_seconds`, per-provider request rates, daily caps, and the Helius exit reserve. Monitoring capacity uses expiring SQLite leases rather than a rolling 24-hour count, so expired candidates release a slot without dropping discovery history. `providers.helius.enable_trade_stream` is an explicit opt-in with active-subscription, event, pending-verification, concurrency, and daily request limits; enabling it consumes provider quota and still cannot establish complete history. `providers.pumpportal.enable_token_trades` remains hard-disabled until its undocumented payload contract is validated. The read-only harness is `pnpm validate:trade-events -- --mint=<MINT> --max-signatures=5`; it makes at most eight RPC requests, uses finalized reads, and does not open or mutate the application database. Optional evidence output is restricted to `tests/fixtures/captures/*.json` and only written after verified trade observations.

---
