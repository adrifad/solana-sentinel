# 03 — Provider Integrations and Fallbacks

## PumpPortal — discovery + optional trade stream

- WebSocket: `wss://pumpportal.fun/api/data?api-key=<PUMPPORTAL_API_KEY>`.
- Subscribe: `subscribeNewToken`, `subscribeMigration`, `subscribeTokenTrade`, `subscribeAccountTrade`.
- **One socket** and dynamically update subscriptions; do not open a connection per mint.
- Creation/migration streaming is listed as free; trade/account streams are metered and may require linked wallet funding. Check provider pricing and enforce monthly event budgets.
- Security note: PumpPortal **Lightning API key may control its linked wallet**. Even for read-only data, treat it as a signing-capable secret; never fund that wallet with trading capital for MVP.
- Parse and validate event signatures, blockchain slot, mint, creator, tx type and amounts. Store unknown fields in redacted raw record for forward compatibility.
- On reconnect: use jittered exponential backoff, restore subscriptions, reconcile gaps from Helius where possible. At-most-once receipt is not guaranteed.

## Helius — on-chain source of truth / transaction history

- Use JSON-RPC and documented wallet/transaction APIs for: mint metadata, Token/Token-2022 state, parsed transactions, historic wallet actions, funding history, transactions for address, and account balance.
- Enforce allowed methods/credits, pagination, timeouts, retry budgets, and backoff on 429/5xx.
- For creator attribution, distinguish token creator claim vs deployer/transaction fee payer vs mint authority vs other wallet roles.
- Keep provenance: `{rpc_method, endpoint_label, signature, slot, fetched_at, provider_version}`.
- Prefer blockchain/decoded official program state over a third-party classification label.

## DEX Screener — supplemental market/social metadata

- Endpoint: `GET https://api.dexscreener.com/token-pairs/v1/solana/{tokenAddress}`.
- Useful for pool info, `liquidity`, `txns`, `volume`, links and DEX phase. Public API, rate limited.
- **Not authoritative at launch:** new Pump.fun tokens may not be indexed immediately; missing pair is NOT automatically a scam. Do not use DEX Screener alone for Pump curve pricing.
- Cache endpoint responses with short TTL; never use an old price to claim a live fill.

## Jupiter Swap V2 — routing and eventual live trading

- API base: `https://api.jup.ag/swap/v2`; documented `GET /order` and `POST /execute`.
- Jupiter `/order` can return quote-only without `taker`, but route absence or no buildable tx must be interpreted carefully.
- **Paper:** only quote path; no transaction signing and never call `/execute`.
- **Live:** only inside isolated live-executor; validate mint, route, min-out, fees, expiry and transaction before signing; reconcile signature on-chain.
- New Pump curve tokens may not have an immediately available Jupiter route; use official Pump SDK math / verified on-chain state rather than inventing a price.

## Pump.fun and PumpSwap official SDKs

- Use `@pump-fun/pump-sdk` and `@pump-fun/pump-swap-sdk` for supported market-state and trade/quote math when available.
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

Set `max_monitored_tokens`, `max_trades_stream_events_per_day`, per-provider rate limits, budget alert threshold, and adaptive unsubscribe policy. Track overages; stop costly subscriptions safely when reaching budget.

---
