# Sprint 3.1 Runtime Hardening and Migration Recovery

## Objective

Fix the verified migration-discovery, PAPER SELL, emergency-pause, and PumpPortal frame-classification defects. Keep PAPER runtime disabled and preserve the DRY_RUN-only boundary for the worker.

## Work plan

1. Add an additive SQLite migration and store methods for durable migration resolution/analysis jobs, atomic verified slot updates, sanitized provider-frame diagnostics, and API-visible job outcomes.
2. Extend worker enrichment and analysis to resolve migration transactions by signature, verify signature/mint/success/slot, retain unknown creator identity, persist fail-closed reports and QUARANTINE decisions, and recover jobs after restart.
3. Add PumpPortal frame dispatch for token events, provider errors, control frames, unsupported frames, and malformed frames; persist bounded sanitized diagnostics without logging secrets.
4. Change PAPER risk gates so the configured emergency pause blocks BUY entries while valid SELL exits remain eligible; apply BUY size limits only to BUY and retain held-balance, quote, settlement, and ledger checks atomically.
5. Add deterministic regression tests, expose migration/analysis status in token detail, update runtime/readiness documentation and `LOCAL_TEST_REPORT.md`, then run CI-equivalent checks and bounded local validation using temporary databases only.

## Validation

Run focused tests for migration-first discovery and restart recovery, transaction mismatch/failure, provider frame classes, SELL size and pause behavior, unavailable exits, oversell prevention, and ledger conservation. Then run `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check`, `pnpm docs:check`, build, and migration checks. Use live provider validation only with bounded requests and sanitized output; never print credentials or touch the `.env` database.
