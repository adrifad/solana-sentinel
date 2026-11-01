# 09 — Live Wallet Readiness and Safe Enablement

**Current status:** NOT IMPLEMENTED. The blueprint is ready for a future live executor; nothing in this package should transact.

## Architecture

- Deploy `apps/live-executor` as separate process/container/host with signer access.
- Analysis worker and dashboard communicate only signed/validated intent through authenticated message channel.
- Operator provides **dedicated limited-balance wallet**, never primary wallet. Prefer a secure key manager / protected signer over raw `.env` key in production.
- PumpPortal Lightning API key can trade with its linked wallet: do not grant this credential to public API; use separate data/feed account where possible.
- Strict allowlist of network (`mainnet-beta`), wallet public key, programs, DEX routes, mints if needed, max fees, transactions/time, daily notional and amount per swap.

## Explicit arming flow

1. Implementor enables live feature at build/deployment policy, not only YAML.
2. Operator passes all preflight checks: no stale RPC, chain ID verified, signer reachable, balance cap, budget cap, kill switch tested, logging healthy.
3. Operator invokes local privileged CLI `sentinel live arm --wallet <pubkey> --budget-sol <max>` (planned command, not provided), confirms irreversible risk, and receives short-lived capability approval. Never store arm token in DB/frontend.
4. Signer independently validates capability, transaction structure, mint/venue allowlists and risk snapshot TTL at **signing time**.
5. Emergency stop or auth expiry disarms immediately; all restarts come up disarmed.

## Risk control / transaction lifecycle

- Re-check current balances/positions on-chain before each live transaction; avoid relying on paper ledger.
- Simulate preflight where provider/venue supports it, but simulated success is not guarantee of landing.
- Sign only if immutable order intent and fresh quote meet hard caps.
- Send once with idempotency signature. On timeout store `UNKNOWN`, reconcile signature on-chain before retry. Avoid duplicate submission.
- Record actual transaction signature, fees, execution price and post-trade token balances.
- Handle ATA creation/rent, wrapping SOL, blockhash expiry, priority fee/cost ceiling, failed tx and congestion.
- Withdrawal/send to arbitrary address is **not** part of the live trader. Disable management operations beyond swaps to allowlisted routes.

## Promotion gate before live

- Full unit/integration/e2e security suite passing, static scan and dependency review.
- ≥ several hundred closed simulated trades (benchmark goal, not statistical proof), with verified non-negative net expectancy after conservative fees and realistic latency; significant sample by market regime.
- Repeated replay without lookahead, reconciliation of positions and no ledger drift.
- Canary live tests with very small capped exposure only after explicit operator decision.
- Operator understands rug-pull/liquidity/MEV risks and the inability of a stop-loss to guarantee exit.

## Never do

- Do not let `PATCH /settings` set `APP_MODE=LIVE`.
- Do not expose signer keys through application APIs, browser UI, metrics, errors, or logs.
- Do not share signer process environment with third-party data-stream credentials.
- Do not automatically re-arm on container restart.

---
