import { createHash } from "node:crypto";
import { z } from "zod";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function isSolanaPubkey(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) return false;
    decoded = decoded * 58n + BigInt(digit);
  }
  let byteLength = 0;
  for (let remainder = decoded; remainder > 0n; remainder >>= 8n)
    byteLength += 1;
  const leadingZeroBytes = value.match(/^1+/)?.[0].length ?? 0;
  return leadingZeroBytes + byteLength === 32;
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
      .regex(/^[1-9A-HJ-NP-Za-km-z]{64,128}$/)
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
    : JSON.stringify({
        kind: input.kind,
        mint: input.mint,
        slot: input.slot ?? null,
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
