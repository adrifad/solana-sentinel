# Sprint 2.5: Intelligence Completion and Market Quote Engine

## Goal

Extend the existing DRY_RUN discovery and analysis pipeline with evidence-backed historical creator indicators, time-indexed launch observations, read-only venue quote contracts, and decision gating that consumes verified evidence. Preserve schema compatibility and fail closed where provider or protocol support is unavailable.

## Implementation steps

1. **Contract and configuration foundation**
   - Inspect the current data and provider contracts and verify current official PumpPortal, Pump SDK, and Jupiter documentation.
   - Add validated configurable trade observation and quote settings with safe disabled defaults.
   - Add domain schemas for observations, quote requests/results, and completeness-aware security/behavior evidence.
2. **Persistent evidence path**
   - Add an additive SQLite migration for time-indexed behavior, historical forensic indicators, and quote results.
   - Implement idempotent store methods and restart-safe retrieval for the new records.
3. **Bounded real-time behavior pipeline**
   - Extend the single PumpPortal socket with explicitly gated per-mint subscriptions, budgets, unsubscribe and reconnect behavior.
   - Parse only validated provider events; persist provenance, report gaps and classify incomplete observations as UNKNOWN.
4. **Creator forensics and classification**
   - Analyze verified historical launch and wallet transactions as of the target slot.
   - Persist suspicious-pattern evidence without asserting fraud or ownership from shared exchange funding.
   - Add behavior-informed test token classification and creator cache refresh.
5. **Read-only market quote adapters and decision wiring**
   - Integrate only documented quote-only/provider SDK behavior with validated input/output schemas.
   - Return explicit unsupported/stale/timeout outcomes instead of fallback prices.
   - Feed creator, security, behavior, and buy/sell quote evidence into risk decisions; keep BUY_ELIGIBLE blocked unless every configured mandatory condition is supported.
6. **Regression validation and documentation**
   - Add deterministic tests for contracts, budgets, ordering/gaps, forensic indicators, quote failures, precision, and restart behavior.
   - Run typecheck, tests, lint, format, docs, and migration checks; update README and implementation status with verified integration limits.

## Safety and acceptance notes

- `DRY_RUN` remains the only operating mode. No signer, transaction builder, swap submission, or paper settlement capability is introduced.
- Live mainnet validation is reported only when real credentials and captured provider data are available during this run.
- Unknown Pump event versions, unsupported venues/extensions, incomplete market observations, and incomplete holder coverage remain explicit and fail closed.
- No profitability claims or fabricated market evidence are introduced.
