# AGENTS.md — Instructions for coding agents

You are implementing **Solana Sentinel**. First read `README.md`, `docs/00`–`docs/05`, `docs/07`–`docs/12`, and `config/default.yaml`. Then inspect the existing code before making changes. Ask no redundant questions when specs provide answers.

## Priorities

1. Safety of execution boundaries; prevent unintended real swaps.
2. Correct and auditable on-chain data.
3. Honest simulation (no imaginary fills, no lookahead bias).
4. Reliability under rate limits, disconnects, retries and provider changes.
5. Clear API contracts and unit/integration tests.
6. Performance after correctness, without extra LLM calls on hot path.

## Mandatory implementation standards

- TypeScript strict, Zod validation at every provider boundary, lint/format, deterministic service composition and dependency injection.
- Use `bigint` or decimal-safe fixed precision for raw token amounts and SOL lamports; never floating point for settlement math.
- Store blockchain slot and timestamp, local received timestamp, idempotency key and source for every market event.
- Persist raw payload references for debugging (sanitized, bounded). Never log API keys or keypairs.
- Local timezone for UI may be Asia/Jakarta; persist timestamps in UTC.
- Reuse the same `RiskDecision` and `OrderIntent` contracts across modes.
- Use one PumpPortal WebSocket connection, manage subscription caps, backoff and re-subscribe on reconnect.
- Handle Pump bonding-curve phase, graduation, and PumpSwap phase distinctly. Check current official SDK docs before pinning versions.
- Do not infer shared control merely from a common exchange funding address.
- Social verification is advisory, not a hard safety override.
- Implement run-time audit events and tests before enabling live flows.

## Hard prohibitions

- Do NOT add signer/provider transaction submission imports to `packages/scanner`, `packages/strategy`, `packages/paper`, or dashboard.
- Do NOT allow frontend HTTP endpoints to flip an unarmed installation into `LIVE`.
- Do NOT use private keys from PumpPortal Lightning wallet in paper mode; treat its API key as sensitive because it can control a funded linked wallet.
- Do NOT count unmatched or rejected paper orders as filled.
- Do NOT hide risk warnings with a high opportunity score.
- Do NOT silently fallback to fake market price if quote is missing.

## Suggested packages

`apps/worker`, `apps/api`, `apps/web`, `apps/live-executor` (deploy separately), `packages/domain`, `packages/providers`, `packages/intelligence`, `packages/strategy`, `packages/paper`, `packages/storage`, `packages/config`, `packages/observability`.

## Agent workflow

1. Map requirements to code and state assumptions.
2. Implement a small, testable vertical slice.
3. Add fixtures, unit tests, integration tests, failure-mode tests, and docs updates.
4. Run strict typecheck, tests, lint, migrations; report outputs and unimplemented items.
5. Provide a change log and security review; never claim a test passed if it was not run.

For phased tasks and acceptance criteria use `docs/14-IMPLEMENTATION-ROADMAP.md` and `docs/15-AGENT-IMPLEMENTATION-PROMPT.md`.
