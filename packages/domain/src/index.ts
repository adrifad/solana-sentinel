import { createHash } from "node:crypto";
import { z } from "zod";

export const PubkeySchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
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
};

export function eventIdempotencyKey(input: {
  kind: MarketEventKind;
  mint: string;
  signature?: string;
  slot?: number;
  creator?: string;
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
        name: input.name ?? null,
        symbol: input.symbol ?? null,
      });
  return createHash("sha256").update(normalized).digest("hex");
}

export function utcNow(): string {
  return new Date().toISOString();
}
