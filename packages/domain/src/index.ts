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
  mode: z.literal("DRY_RUN"),
  mint: PubkeySchema,
  side: z.enum(["BUY", "SELL"]),
  decisionId: z.string().min(1),
  reasonCodes: z.array(z.string().regex(/^[A-Z0-9_]+$/)),
  createdAtUtc: IsoUtcSchema,
});
export type TradeIntent = z.infer<typeof TradeIntentSchema>;

export type ProviderState =
  "DISABLED" | "STARTING" | "HEALTHY" | "DEGRADED" | "STOPPED";
export type ProviderHealth = {
  provider: "pumpportal" | "helius";
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
