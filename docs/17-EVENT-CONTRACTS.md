# 17 — Internal Event and Service Contracts

Treat provider payloads as **untrusted external input**; these are internal normalized contracts, not assertions about exact upstream JSON schemas. Implement Zod schemas, runtime validation, migration versions and unit tests.

```ts
type IsoUtc = string;
type Pubkey = string;
type RawAmount = string; // decimal integer serialization of bigint

type MarketEvent = {
  id: string;
  version: 1;
  provider: "pumpportal" | "helius" | "dexscreener";
  kind: "TOKEN_CREATED" | "TOKEN_TRADE" | "TOKEN_MIGRATED" | "MINT_CHANGED";
  mint: Pubkey;
  txSignature?: string;
  eventIndex?: number;
  slot?: number;
  observedAtUtc?: IsoUtc;
  receivedAtUtc: IsoUtc;
  rawPayloadRef: string;
};

type Quote = {
  id: string;
  venue: "PUMP_CURVE" | "PUMPSWAP" | "JUPITER";
  mintIn: Pubkey;
  mintOut: Pubkey;
  amountInRaw: RawAmount;
  expectedOutRaw: RawAmount;
  minOutRaw?: RawAmount;
  feeIncluded: boolean;
  feeBreakdownRaw: Record<string, RawAmount>;
  asOfSlot: number;
  obtainedAtUtc: IsoUtc;
  snapshotHash: string;
};

type RiskDecision = {
  mint: Pubkey;
  status: "REJECT" | "QUARANTINE" | "WATCH" | "BUY_ELIGIBLE";
  reasonCodes: string[];
  opportunityScore: number | null;
  configVersion: string;
  strategyVersion: string;
  evidenceRefs: string[];
  decidedAtUtc: IsoUtc;
};

type TradeIntent = {
  id: string;
  mode: "DRY_RUN" | "PAPER" | "LIVE";
  strategyId: string;
  mint: Pubkey;
  side: "BUY" | "SELL";
  exactInputAsset: Pubkey;
  exactInputRaw: RawAmount;
  expiresAtUtc: IsoUtc;
  riskDecisionId: string;
  createdAtUtc: IsoUtc;
  configVersion: string;
};
```

## Idempotency

Use stable event IDs from `(chain, provider, txSignature, eventIndex)` when available. For provider creation notifications without signatures, hash a canonical normalized launch record with slot/mint. An event may be received multiple times; side effects must be idempotent. A trade intent is unique by strategy run + event + side + position step; paper ledger writes protected by a unique intent ID.

## Error codes

`PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `MALFORMED_EVENT`, `UNSUPPORTED_VENUE`, `UNSUPPORTED_EXTENSION`, `STALE_MARKET_STATE`, `NO_QUOTE`, `EXIT_UNAVAILABLE`, `PRICE_IMPACT_EXCEEDED`, `INSUFFICIENT_VIRTUAL_FUNDS`, `RISK_REJECTED`, `ARMING_REQUIRED`, `CHAIN_CONFIRMATION_UNKNOWN`.

## Time and provenance

All events should carry `source_seen_at`, `worker_received_at`, `decision_at` where relevant; slot timestamp is not the same as receipt time. Cache entries include provenance and expiry; old evidence must never silently be treated as current token security state.

---
