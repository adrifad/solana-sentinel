# 16 — Architecture Decision Records (ADR)

## ADR-001 — Mainnet read-only for simulation

**Decision:** In all modes, market and historical analysis use Solana mainnet. `PAPER` does not use devnet tokens or fake exchange prices.  
**Reason:** New token conditions on devnet do not reflect mainnet launch dynamics.  
**Tradeoff:** Provider credits/stream fees and data gaps; still not equal to a real fill.

## ADR-002 — Three modes with separate capabilities

**Decision:** `DRY_RUN` has signal-only executor; `PAPER` has virtual ledger; `LIVE` is separate signer deployment.  
**Reason:** Prevent mode-toggle accident and secret exposure.  
**Tradeoff:** More deployment complexity at live stage.

## ADR-003 — SQLite first

**Decision:** SQLite WAL + migrations for MVP, with repository interfaces suitable for Postgres later.  
**Reason:** low operational burden.  
**Tradeoff:** single-writer / growth limitations; benchmark before migration.

## ADR-004 — Rule engine on hot path

**Decision:** Deterministic validation/strategy under tight timeouts; LLM only optional background social intelligence.  
**Reason:** predictable latency and auditable decisions.  
**Tradeoff:** heuristics require ongoing calibration.

## ADR-005 — No synthetic fills when quote unavailable

**Decision:** Failed/stale/unsupported quote means no paper fill, and impossible exit remains open/unpriceable.  
**Reason:** avoid overstated results on illiquid launches.  
**Tradeoff:** lower simulated trade count but more honest estimates.

## ADR-006 — One initial venue focus

**Decision:** Pump.fun/PumpSwap first; DEX Screener secondary and Jupiter quote fallback only when supported.  
**Reason:** phase-specific semantics important for accuracy.  
**Tradeoff:** do not scan all Solana DEX launches initially.

## ADR-007 — Evidence, not labels

**Decision:** Creator wallet link and prior abuse outcomes require evidence/confidence and timestamps.  
**Reason:** common funding sources and token failures are not always deliberate scams.  
**Tradeoff:** some creators remain UNKNOWN.

## ADR-008 — External provider protocol drift

**Decision:** versioned adapters + fixture tests + periodic official-doc review; unsupported new features fail closed.  
**Reason:** Pump/Jupiter protocol evolves rapidly.  
**Tradeoff:** maintenance effort.

---
