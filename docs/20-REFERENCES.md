# 20 — Official References and Change Watchlist

Sources checked against official documentation during preparation of this blueprint (31 October 2026). API versions and prices may change; integration tests must detect drift.

## Core sources

- PumpPortal real-time streaming: https://pumpportal.fun/data-api/bonk-fun-data-api/
  - Documented `subscribeNewToken`, `subscribeMigration`, `subscribeTokenTrade`, `subscribeAccountTrade`; one WebSocket recommendation; trade stream metering.
- PumpPortal fee schedule: https://pumpportal.fun/fees/
  - Current data-stream price and linked-wallet balance requirement; re-check before enabling paid streams.
- PumpPortal setup/security: https://pumpportal.fun/trading-api/setup/
  - Lightning wallet and API key can grant trade access to linked funds; treat as secret.
- Helius docs: https://www.helius.dev/docs
  - Solana RPC, transaction history and data streaming.
- DEX Screener API reference: https://docs.dexscreener.com/api/reference
  - Public token-pairs endpoint, rate limits and response structure.
- Jupiter order and execute: https://developers.jup.ag/docs/swap/order-and-execute
  - `GET /swap/v2/order`, `POST /swap/v2/execute`, quote-only without taker; API key headers.
- Pump official protocol docs & SDK changelog: https://github.com/pump-fun/pump-public-docs
  - Curve and PumpSwap updates, signed reserves, v3/v2 trades, multiple quote mint types.
- Solana SPL token core: https://solana.com/docs/tokens
  - Mint/freeze authority, token programs.
- Solana permanent delegate: https://solana.com/docs/tokens/extensions/permanent-delegate
- Solana transfer hook: https://solana.com/docs/tokens/extensions/transfer-hook

## Before implementation or SDK upgrades

Verify exact event payload fields, new token types, current Pump SDK/IDL, route policy, priority fee semantics, provider quota/fees, Solana commitment and transaction confirmation behavior. Record version/pinning decisions with updated dates and fixture tests.
