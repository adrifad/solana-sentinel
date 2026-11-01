import { createHash } from "node:crypto";
import { z } from "zod";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58DecodedLength(value: string): number | null {
  if (!value) return 0;
  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) return null;
    decoded = decoded * 58n + BigInt(digit);
  }
  let byteLength = 0;
  for (let remainder = decoded; remainder > 0n; remainder >>= 8n)
    byteLength += 1;
  const leadingZeroBytes = value.match(/^1+/)?.[0].length ?? 0;
  return leadingZeroBytes + byteLength;
}

export function isSolanaPubkey(value: string): boolean {
  return (
    value.length >= 32 &&
    value.length <= 44 &&
    base58DecodedLength(value) === 32
  );
}

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    value /= 58n;
    encoded = BASE58[remainder] + encoded;
  }
  let leadingZeroBytes = 0;
  while (leadingZeroBytes < bytes.length && bytes[leadingZeroBytes] === 0)
    leadingZeroBytes += 1;
  return "1".repeat(leadingZeroBytes) + encoded;
}

export const PubkeySchema = z.string().refine(isSolanaPubkey, {
  message: "Expected a base58-encoded 32-byte Solana public key",
});
export const IsoUtcSchema = z.string().datetime({ offset: true });
export const MarketEventSchema = z
  .object({
    id: z.string().min(1),
    version: z.literal(1),
    provider: z.literal("pumpportal"),
    kind: z.enum(["TOKEN_CREATED", "TOKEN_MIGRATED"]),
    mint: PubkeySchema,
    txSignature: z
      .string()
      .regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/)
      .refine((value) => base58DecodedLength(value) === 64)
      .optional(),
    slot: z.number().int().nonnegative().safe().optional(),
    observedAtUtc: IsoUtcSchema.optional(),
    receivedAtUtc: IsoUtcSchema,
    firstSeenAtUtc: IsoUtcSchema,
    idempotencyKey: z.string().min(1),
    rawPayloadRef: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sanitizedPayload: z.string().max(4096),
    ingestionLatencyMs: z.number().nonnegative(),
    creator: PubkeySchema.optional(),
    launchInitiator: PubkeySchema.optional(),
    name: z.string().max(128).optional(),
    symbol: z.string().max(32).optional(),
    uri: z.string().max(2048).optional(),
  })
  .strict();

export type MarketEvent = z.infer<typeof MarketEventSchema>;
export type MarketEventKind = MarketEvent["kind"];

export const WalletRoleSchema = z.enum([
  "CLAIMED_CREATOR",
  "LAUNCH_INITIATOR",
  "FEE_PAYER",
  "MINT_AUTHORITY",
  "FREEZE_AUTHORITY",
  "FUNDING_SOURCE",
]);
export type WalletRole = z.infer<typeof WalletRoleSchema>;
export const EvidenceSourceSchema = z.enum([
  "PUMPPORTAL_CLAIM",
  "SOLANA_RPC",
  "PUMP_IDL_CREATE_EVENT",
  "HELIUS_HISTORY",
]);
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const WalletRoleEvidenceSchema = z.object({
  id: z.string().min(1),
  mint: PubkeySchema,
  wallet: PubkeySchema,
  role: WalletRoleSchema,
  source: EvidenceSourceSchema,
  signature: z.string().min(1).nullable(),
  slot: z.number().int().nonnegative().safe().nullable(),
  observedAtUtc: IsoUtcSchema,
  confidenceBps: z.number().int().min(0).max(10000),
  reasonCode: z.string().regex(/^[A-Z0-9_]+$/),
});
export type WalletRoleEvidence = z.infer<typeof WalletRoleEvidenceSchema>;

export const CreatorReputationSchema = z.object({
  wallet: PubkeySchema,
  status: z.enum(["KNOWN", "SUSPICIOUS", "UNKNOWN"]),
  launchesObserved: z.number().int().nonnegative(),
  suspiciousIndicators: z.array(z.string().regex(/^[A-Z0-9_]+$/)),
  confidenceBps: z.number().int().min(0).max(10000),
  historyComplete: z.boolean(),
  asOfSlot: z.number().int().nonnegative().safe().nullable(),
  computedAtUtc: IsoUtcSchema,
  freshUntilUtc: IsoUtcSchema,
  evidenceRefs: z.array(z.string().min(1)),
});
export type CreatorReputation = z.infer<typeof CreatorReputationSchema>;

export const TokenRiskReportSchema = z.object({
  id: z.string().min(1),
  mint: PubkeySchema,
  status: z.enum(["SUPPORTED", "UNSUPPORTED", "MISSING", "UNSAFE"]),
  programId: PubkeySchema.nullable(),
  mintAuthority: PubkeySchema.nullable(),
  freezeAuthority: PubkeySchema.nullable(),
  supplyRaw: z.string().regex(/^\d+$/).nullable(),
  decimals: z.number().int().min(0).max(255).nullable(),
  extensions: z.array(
    z.object({
      typeId: z.number().int().nonnegative(),
      name: z.string(),
      classification: z.enum(["SUPPORTED", "RISK", "UNSUPPORTED"]),
    }),
  ),
  topHolderConcentrationBps: z.number().int().min(0).max(10000).nullable(),
  creatorConcentrationRaw: z.string().regex(/^\d+$/).nullable(),
  clusterConcentrationRaw: z.string().regex(/^\d+$/).nullable(),
  holderSampleCount: z.number().int().nonnegative(),
  holderSampleComplete: z.literal(false),
  holderSampleCoverageBps: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .nullable()
    .optional(),
  holderSampleValidated: z.boolean().optional(),
  testTokenClassification: z.enum(["LIKELY_TEST", "UNKNOWN"]),
  testTokenConfidenceBps: z.number().int().min(0).max(10000),
  reasonCodes: z.array(z.string().regex(/^[A-Z0-9_]+$/)),
  source: z.literal("HELIUS_RPC"),
  asOfSlot: z.number().int().nonnegative().safe().nullable(),
  observedAtUtc: IsoUtcSchema,
  confidenceBps: z.number().int().min(0).max(10000),
  evidenceRefs: z.array(z.string().min(1)),
});
export type TokenRiskReport = z.infer<typeof TokenRiskReportSchema>;

export const VenueTypeSchema = z.enum([
  "PUMP_BONDING_CURVE",
  "PUMPSWAP",
  "JUPITER",
]);
export type VenueType = z.infer<typeof VenueTypeSchema>;
export const QuoteDirectionSchema = z.enum(["BUY", "SELL"]);
export const QuoteFailureReasonSchema = z.enum([
  "VENUE_UNSUPPORTED",
  "STATE_MISSING",
  "STATE_UNSAFE",
  "QUOTE_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "PROVIDER_BUDGET_EXHAUSTED",
  "NO_ROUTE",
  "INSUFFICIENT_LIQUIDITY",
  "STALE_SNAPSHOT",
  "PRICE_IMPACT_UNKNOWN",
  "MALFORMED_PROVIDER_DATA",
]);
export type QuoteFailureReason = z.infer<typeof QuoteFailureReasonSchema>;

export const MarketSnapshotSchema = z.object({
  mint: PubkeySchema,
  venue: VenueTypeSchema,
  slot: z.number().int().nonnegative().safe(),
  observedAtUtc: IsoUtcSchema,
  source: z.string().min(1),
  stateRef: z.string().min(1),
  baseReserveRaw: z.string().regex(/^\d+$/).nullable(),
  quoteReserveRaw: z.string().regex(/^\d+$/).nullable(),
  liquidityQuoteRaw: z.string().regex(/^\d+$/).nullable(),
  confidenceBps: z.number().int().min(0).max(10000),
});
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

export const QuoteRequestSchema = z
  .object({
    mint: PubkeySchema,
    direction: QuoteDirectionSchema,
    exactInputAmountRaw: z.string().regex(/^[1-9]\d*$/),
    inputMint: PubkeySchema,
    outputMint: PubkeySchema,
    expectedVenue: VenueTypeSchema.optional(),
    maxAgeMs: z.number().int().nonnegative(),
    requestedAtUtc: IsoUtcSchema,
  })
  .refine(
    (request) =>
      request.direction === "BUY"
        ? request.outputMint === request.mint
        : request.inputMint === request.mint,
    "Quote side must use the requested token mint",
  );
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

export const QuoteResultSchema = z.object({
  id: z.string().min(1),
  mint: PubkeySchema,
  direction: QuoteDirectionSchema,
  exactInputAmountRaw: z.string().regex(/^\d+$/),
  expectedOutputAmountRaw: z.string().regex(/^\d+$/).nullable(),
  inputMint: PubkeySchema,
  outputMint: PubkeySchema,
  venue: VenueTypeSchema.nullable(),
  source: z.string().min(1),
  snapshotSlot: z.number().int().nonnegative().safe().nullable(),
  snapshotAtUtc: IsoUtcSchema.nullable(),
  feeAmountRaw: z.string().regex(/^\d+$/).nullable(),
  feeBreakdownRaw: z
    .object({
      protocol: z.string().regex(/^\d+$/),
      creator: z.string().regex(/^\d+$/),
      liquidityProvider: z.string().regex(/^\d+$/),
      unallocated: z.string().regex(/^\d+$/),
    })
    .optional(),
  feeMint: PubkeySchema.nullable(),
  feeModel: z.string().min(1),
  priceImpactBps: z.number().int().nonnegative().nullable(),
  liquidityQuoteRaw: z.string().regex(/^\d+$/).nullable(),
  freshnessMs: z.number().int().nonnegative().nullable(),
  validationStatus: z.enum(["PASS", "FAIL", "UNKNOWN"]),
  failureReason: QuoteFailureReasonSchema.nullable(),
  evidenceRefs: z.array(z.string().min(1)),
  provenance: z.record(z.string(), z.unknown()),
  observedAtUtc: IsoUtcSchema,
});
export type QuoteResult = z.infer<typeof QuoteResultSchema>;

export const ExitValidationResultSchema = z.object({
  status: z.enum(["PASS", "FAIL", "UNKNOWN"]),
  buyQuoteId: z.string().min(1).nullable(),
  sellQuoteId: z.string().min(1).nullable(),
  requiredSellAmountRaw: z.string().regex(/^\d+$/).nullable(),
  expectedExitAmountRaw: z.string().regex(/^\d+$/).nullable(),
  reasonCodes: z.array(z.string().regex(/^[A-Z0-9_]+$/)),
  evidenceRefs: z.array(z.string().min(1)),
});
export type ExitValidationResult = z.infer<typeof ExitValidationResultSchema>;

export const LaunchBehaviorSnapshotSchema = z.object({
  id: z.string().min(1),
  mint: PubkeySchema,
  windowSeconds: z.union([z.literal(30), z.literal(60), z.literal(120)]),
  windowStartedAtUtc: IsoUtcSchema,
  observedAtUtc: IsoUtcSchema,
  throughSlot: z.number().int().nonnegative().safe().nullable(),
  buyCount: z.number().int().nonnegative(),
  sellCount: z.number().int().nonnegative(),
  venueMetrics: z.object({
    PUMP_BONDING_CURVE: z.object({
      buyCount: z.number().int().nonnegative(),
      sellCount: z.number().int().nonnegative(),
      buyVolumeRaw: z.string().regex(/^\d+$/),
      sellVolumeRaw: z.string().regex(/^\d+$/),
    }),
    PUMPSWAP: z.object({
      buyCount: z.number().int().nonnegative(),
      sellCount: z.number().int().nonnegative(),
      buyVolumeRaw: z.string().regex(/^\d+$/),
      sellVolumeRaw: z.string().regex(/^\d+$/),
    }),
  }),
  uniqueBuyers: z.number().int().nonnegative(),
  independentBuyerEstimate: z.number().int().nonnegative(),
  creatorAssociatedBuys: z.number().int().nonnegative(),
  repeatedWalletTransactions: z.number().int().nonnegative(),
  largestWalletVolumeBps: z.number().int().min(0).max(10000).nullable(),
  volumeBuyRaw: z.string().regex(/^\d+$/),
  volumeSellRaw: z.string().regex(/^\d+$/),
  marketPhase: z.enum(["PUMP_CURVE", "MIGRATED_PUMPSWAP", "UNKNOWN"]),
  classification: z.enum(["LIKELY_TEST", "ORGANIC_CANDIDATE", "UNKNOWN"]),
  reasonCodes: z.array(z.string().regex(/^[A-Z0-9_]+$/)),
  confidenceBps: z.number().int().min(0).max(10000),
  complete: z.boolean(),
  gapReason: z
    .string()
    .regex(/^[A-Z0-9_]+$/)
    .nullable(),
  evidenceRefs: z.array(z.string().min(1)),
});
export type LaunchBehaviorSnapshot = z.infer<
  typeof LaunchBehaviorSnapshotSchema
>;

export const LaunchTradeObservationSchema = z.object({
  id: z.string().min(1),
  eventIndex: z.number().int().nonnegative().default(0),
  mint: PubkeySchema,
  signature: z.string().min(1),
  slot: z.number().int().nonnegative().safe().nullable(),
  blockTimeUtc: IsoUtcSchema.nullable(),
  eventTimeUtc: IsoUtcSchema.nullable().default(null),
  eventTimeSource: z
    .enum([
      "PUMP_TRADE_EVENT_TIMESTAMP",
      "PUMPSWAP_TRADE_EVENT_TIMESTAMP",
      "UNKNOWN",
    ])
    .default("UNKNOWN"),
  receivedAtUtc: IsoUtcSchema,
  ingestedAtUtc: IsoUtcSchema.default("1970-01-01T00:00:00.000Z"),
  side: z.enum(["BUY", "SELL"]),
  traderWallet: PubkeySchema.nullable(),
  tokenAmountRaw: z.string().regex(/^\d+$/).nullable(),
  quoteAmountRaw: z.string().regex(/^\d+$/).nullable(),
  quoteMint: PubkeySchema.nullable().default(null),
  venue: z.enum(["PUMP_BONDING_CURVE", "PUMPSWAP", "UNKNOWN"]),
  source: z.string().min(1),
  decoderVersion: z.string().min(1).default("UNKNOWN"),
  validationStatus: z.enum(["VERIFIED", "UNVERIFIED"]).default("UNVERIFIED"),
  validationConfidenceBps: z.number().int().min(0).max(10000).default(0),
  payloadRef: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
export type LaunchTradeObservation = z.infer<
  typeof LaunchTradeObservationSchema
>;

export const RiskDecisionSchema = z.object({
  id: z.string().min(1),
  mint: PubkeySchema,
  status: z.enum(["REJECT", "QUARANTINE", "WATCH", "BUY_ELIGIBLE"]),
  reasonCodes: z.array(z.string().regex(/^[A-Z0-9_]+$/)),
  configVersion: z.string().regex(/^[a-f0-9]{64}$/),
  evidenceRefs: z.array(z.string().min(1)),
  securityReportId: z.string().min(1),
  decidedAtUtc: IsoUtcSchema,
  latencyMs: z.number().nonnegative(),
});
export type RiskDecision = z.infer<typeof RiskDecisionSchema>;

export const TradeIntentSchema = z.object({
  id: z.string().min(1),
  mode: z.enum(["DRY_RUN", "PAPER"]),
  mint: PubkeySchema,
  side: z.enum(["BUY", "SELL"]),
  decisionId: z.string().min(1),
  reasonCodes: z.array(z.string().regex(/^[A-Z0-9_]+$/)),
  createdAtUtc: IsoUtcSchema,
});
export type TradeIntent = z.infer<typeof TradeIntentSchema>;

export const PaperOrderIntentSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
  walletId: z.string().min(1),
  mode: z.literal("PAPER"),
  mint: PubkeySchema,
  side: z.enum(["BUY", "SELL"]),
  exactInputAmountRaw: z
    .string()
    .regex(/^\d+$/)
    .refine((v) => BigInt(v) > 0n),
  decisionId: z.string().min(1),
  reasonCodes: z.array(z.string().regex(/^[A-Z0-9_]+$/)),
  createdAtUtc: IsoUtcSchema,
  signalQuoteId: z.string().min(1).nullable(),
  entrySource: z.enum(["AUTOMATIC", "MANUAL"]).optional(),
});
export type PaperOrderIntent = z.infer<typeof PaperOrderIntentSchema>;

export function paperPositionId(walletId: string, mint: string): string {
  return `paper-position:${encodeURIComponent(walletId)}:${mint}`;
}

export type ProviderState =
  "DISABLED" | "STARTING" | "HEALTHY" | "DEGRADED" | "STOPPED";
export type ProviderHealth = {
  provider: "pumpportal" | "helius" | "helius_trade_stream";
  state: ProviderState;
  checkedAtUtc: string | null;
  lastEventAtUtc: string | null;
  reconnectCount: number;
  errorCode: string | null;
  connectionState?: "CONNECTED" | "DISCONNECTED" | "STARTING" | "STOPPED";
  lastMessageAtUtc?: string | null;
  lastProcessedAtUtc?: string | null;
  processingLagMs?: number | null;
  queueDepth?: number;
};

export function eventIdempotencyKey(input: {
  kind: MarketEventKind;
  mint: string;
  signature?: string;
  slot?: number;
  payloadDigest?: string;
  creator?: string;
  launchInitiator?: string;
  name?: string;
  symbol?: string;
}): string {
  const normalized = input.signature
    ? JSON.stringify({
        kind: input.kind,
        mint: input.mint,
        signature: input.signature,
      })
    : input.slot !== undefined
      ? JSON.stringify({ kind: input.kind, mint: input.mint, slot: input.slot })
      : JSON.stringify({
          kind: input.kind,
          mint: input.mint,
          payloadDigest: input.payloadDigest ?? null,
          creator: input.creator ?? null,
          launchInitiator: input.launchInitiator ?? null,
          name: input.name ?? null,
          symbol: input.symbol ?? null,
        });
  return createHash("sha256").update(normalized).digest("hex");
}

export function utcNow(): string {
  return new Date().toISOString();
}
