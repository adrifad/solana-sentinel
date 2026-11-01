# 03 — Provider Integrations and Fallbacks

## PumpPortal — discovery + optional trade stream

- WebSocket: `wss://pumpportal.fun/api/data?api-key=<PUMPPORTAL_API_KEY>`.
- Subscribe: `subscribeNewToken`, `subscribeMigration`, `subscribeTokenTrade`, `subscribeAccountTrade`.
- **One socket** and dynamically update subscriptions; do not open a connection per mint.
- Creation/migration streaming is listed as free; trade/account streams are metered and may require linked wallet funding. Check provider pricing and enforce monthly event budgets.
- Official provider guidance currently prices trade streams at 0.01 SOL per 10,000 received events and says the linked wallet must have at least 0.02 SOL. This runtime keeps `enable_token_trades: false`; it has no validated trade-payload adapter, metered subscription lifecycle, or raw event budget enforcement yet.
- Security note: PumpPortal **Lightning API key may control its linked wallet**. Even for read-only data, treat it as a signing-capable secret; never fund that wallet with trading capital for MVP.
- Parse and validate event signatures, blockchain slot, mint, creator, tx type and amounts. Store unknown fields in redacted raw record for forward compatibility.
- On reconnect: use jittered exponential backoff and restore subscriptions. Each interruption is persisted as an unreconciled gap; a Helius missed-launch reconciler is not yet implemented. At-most-once receipt is not guaranteed.

## Helius — on-chain source of truth / transaction history

- Implemented standard JSON-RPC reads: `getHealth`, `getGenesisHash`, `getAccountInfo`, `getBlockTime`, `getSignaturesForAddress`, `getTransaction`, `getTokenSupply`, `getTokenLargestAccounts`, and `getMultipleAccounts`. Wallet-history calls are paginated, finalized, and bounded by configured request budgets.
- Enforce allowed methods/credits, pagination, timeouts, retry budgets, and backoff on 429/5xx.
- For creator attribution, distinguish token creator claim vs deployer/transaction fee payer vs mint authority vs other wallet roles.
- Keep provenance: `{rpc_method, endpoint_label, signature, slot, fetched_at, provider_version}`.
- Prefer blockchain/decoded official program state over a third-party classification label.
- RPC request counts are budgeted, but Helius plan credit costs have not been separately modeled or verified with credentials.

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

- Pinned read-only quote calculation dependency: `@pump-fun/pump-sdk@4.1.0`. `PumpCurveQuoteEngine` uses its current v3 exact-input buy and sell math when supplied a validated, slot-stamped curve/global/fee snapshot. State acquisition is not yet wired to Helius, and completed curves are explicitly unsupported.
- `@pump-fun/pump-swap-sdk@2.1.0` is pinned for current protocol documentation alignment, but PumpSwap account/vault state decoding and quote calculation are not yet wired. Migrated tokens remain unsupported by the worker.
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

Set `max_monitored_tokens`, per-provider request rates and UTC-day caps. The metered PumpPortal token-trade feature remains hard-disabled in schema until event decoding, subscription lifecycle, and persistent event-budget enforcement are available.

---
