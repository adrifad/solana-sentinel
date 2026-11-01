# 15 — Prompt for Codex / Implementor

Copy the following into a fresh coding-agent session **after** adding these blueprint files to the repository.

---

You are the primary implementor for **Solana Sentinel**. Read `AGENTS.md`, `README.md`, all `docs/*.md`, `config/default.yaml`, and `.env.example` before editing. Inspect the repository as-is and write a short current-state gap analysis. Then implement only **Sprint 0 + Sprint 1** from `docs/14-IMPLEMENTATION-ROADMAP.md` in this session. Do not build live trading functionality yet.

Requirements:

1. Strict TypeScript pnpm workspace with clean modular packages; Node supported LTS; SQLite + migrations; Zod validation.
2. `DRY_RUN` is default. Runtime must not import/sign/send any real transaction. No wallet key required.
3. Robust PumpPortal one-WebSocket new-token/migration stream, reconnect/re-subscribe, dedup, graceful shutdown and bounded subscriptions. Validate events at input boundaries. Do not hardcode unknown response fields as facts.
4. Helius provider health + mint read layer with timeouts/retries/circuit breakers. Redact API secrets.
5. Minimal CLI/health endpoint and read-only list of detected tokens.
6. Add tests using fixtures for duplicate/out-of-order events, malformed messages, disconnects, budget and secret safety. No external API dependency in CI.
7. Implement `.env.example`, config loader, migration scripts, startup docs, and launch instructions.
8. Track performance markers: first-seen timestamp, ingestion latency and provider errors.

Engineering guidance: preserve accurate SOL lamport/raw token numeric types; all timestamps UTC; no lookahead; no invented paper fills; do not introduce extra paid services. Do not expose wallet secret or any LIVE arming in dashboard. Never silently weaken safety checks to satisfy a test. Finish by running available tests/typecheck/lint, documenting exact results and remaining work. Proceed with implementation without waiting for redundant confirmation.

After Sprint 0+1, propose next tasks for Sprint 2 (forensics + security) and Sprint 3 (realistic paper trading), without implementing them in this same change unless requested.

---

## Reviewer prompt

Review changes against `AGENTS.md` and `docs/00`–`docs/14`. Focus on fail-closed behavior, disconnected/stale feeds, idempotency, duplicate ledger writing, token program variants, mocked vs real quote semantics, secret leakage and accidental signing paths. Classify findings by severity, cite files/lines, propose tests. Do not accept unverified claims that this code is production ready or profitable.

---
