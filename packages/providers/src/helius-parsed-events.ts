import { z } from "zod";
import { base58DecodedLength, PubkeySchema } from "@sentinel/domain";

const Signature = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/)
  .refine((signature) => base58DecodedLength(signature) === 64);
const ScanItem = z
  .object({
    signature: Signature,
    parserStatus: z.string().optional(),
    slot: z.number().int().nonnegative().safe().optional(),
    blockTime: z.number().int().nonnegative().safe().nullable().optional(),
    parsed: z
      .object({
        slot: z.number().int().nonnegative().safe(),
        blockTime: z.number().int().nonnegative().safe().nullable(),
        transactionStatus: z.string().optional(),
        summary: z
          .object({
            type: z.string().optional(),
            parsedData: z
              .object({
                type: z.string().optional(),
                protocol: z.string().optional(),
                kind: z.string().optional(),
                input_mint: PubkeySchema.optional(),
                output_mint: PubkeySchema.optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough()
          .optional(),
        instructions: z
          .array(
            z
              .object({
                programId: PubkeySchema.optional(),
                instructionName: z.string().max(128).nullable().optional(),
              })
              .passthrough(),
          )
          .max(1000)
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ScanResponse = z
  .object({
    data: z.array(ScanItem).max(100),
    paginationToken: z.string().min(1).max(512).optional(),
    scan: z.object({
      stoppedOn: z.enum(["windowEnd", "limit", "budget", "deadline"]),
      scannedTransactions: z.number().int().nonnegative().safe(),
      matchedTransactions: z.number().int().nonnegative().safe(),
      scannedThrough: z
        .object({
          slot: z.number().int().nonnegative().safe(),
          blockTime: z.number().int().nonnegative().safe().nullable(),
        })
        .nullable(),
      creditsCharged: z.number().int().nonnegative().safe(),
    }),
  })
  .passthrough();

export const HELIUS_PUMP_PROGRAM =
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const HELIUS_PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

export const HELIUS_TRADE_PROGRAMS = [
  HELIUS_PUMP_PROGRAM,
  HELIUS_PUMPSWAP_PROGRAM,
] as const;
export const HELIUS_WSOL_MINT = "So11111111111111111111111111111111111111112";

export type ParsedTradeScanRequest = {
  mint: string;
  fromUnixSeconds: number;
  toUnixSeconds: number;
  paginationToken?: string;
  maxScannedTransactions: number;
  signal?: AbortSignal;
};
export type ParsedTradeScanPage = {
  items: Array<{
    signature: string;
    slot: number;
    blockTime: number | null;
    parsedProtocol: string | null;
    parsedKind: string | null;
    parsedMint: string | null;
    expectedSide: "BUY" | "SELL" | null;
    classification: "TRADE_CANDIDATE" | "NON_TRADE" | "UNSUPPORTED";
    reasonCode: string | null;
    instructionNames: string[];
  }>;
  paginationToken: string | null;
  stoppedOn: "windowEnd" | "limit" | "budget" | "deadline";
  scannedThrough: { slot: number; blockTime: number | null } | null;
  creditsCharged: number;
  scannedTransactions: number;
};
export type ParsedScanCreditReservation = {
  reserve(maxCredits: number): string | null;
  settle(reservationDay: string, chargedCredits: number): void;
};

export class HeliusParsedEventsScanClient {
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #credits: ParsedScanCreditReservation;

  constructor(options: {
    apiKey: string;
    timeoutMs: number;
    fetchImpl?: typeof fetch;
    creditReservation: ParsedScanCreditReservation;
  }) {
    if (!options.apiKey.trim()) throw new Error("HELIUS_API_KEY is required");
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#credits = options.creditReservation;
  }

  async scanMintWindow(
    request: ParsedTradeScanRequest,
  ): Promise<ParsedTradeScanPage> {
    if (!PubkeySchema.safeParse(request.mint).success)
      throw new Error("INVALID_MINT");
    if (
      !Number.isSafeInteger(request.fromUnixSeconds) ||
      !Number.isSafeInteger(request.toUnixSeconds) ||
      request.fromUnixSeconds < 0 ||
      request.toUnixSeconds <= request.fromUnixSeconds
    )
      throw new Error("INVALID_TIME_WINDOW");
    if (
      !Number.isInteger(request.maxScannedTransactions) ||
      request.maxScannedTransactions < 1 ||
      request.maxScannedTransactions > 10_000
    )
      throw new Error("INVALID_SCAN_BUDGET");
    if (request.signal?.aborted) throw new Error("CANCELLED");

    // Helius charges 10 credits plus one per up-to-1000-transaction history page.
    const reservedCredits =
      10 + Math.ceil(request.maxScannedTransactions / 1000);
    const reservationDay = this.#credits.reserve(reservedCredits);
    if (!reservationDay) throw new Error("PARSED_SCAN_CREDIT_BUDGET_EXHAUSTED");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    const abort = () => controller.abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.#fetch(
        `https://mainnet.helius-rpc.com/v1/parsed-events/scan?api-key=${encodeURIComponent(this.#apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            address: request.mint,
            // Scan all program instructions. An instruction-name allowlist can
            // silently exclude a newly deployed protocol variant.
            match: {
              programs: HELIUS_TRADE_PROGRAMS.map((programId) => ({
                programId,
              })),
            },
            time: { gte: request.fromUnixSeconds, lt: request.toUnixSeconds },
            commitment: "finalized",
            status: "succeeded",
            sortOrder: "asc",
            returnShape: "transactions",
            limit: 100,
            rawTransaction: "none",
            budget: { maxScannedTransactions: request.maxScannedTransactions },
            ...(request.paginationToken
              ? { paginationToken: request.paginationToken }
              : {}),
          }),
        },
      );
      if (response.status === 429) throw new Error("RATE_LIMITED");
      if (response.status === 401 || response.status === 403)
        throw new Error("PARSED_SCAN_ACCESS_DENIED");
      if (!response.ok) throw new Error(`PARSED_SCAN_HTTP_${response.status}`);
      const responseBody = await response.text();
      if (responseBody.length > 8 * 1024 * 1024)
        throw new Error("PARSED_SCAN_RESPONSE_TOO_LARGE");
      let responseValue: unknown;
      try {
        responseValue = JSON.parse(responseBody);
      } catch {
        throw new Error("MALFORMED_PARSED_SCAN_RESPONSE");
      }
      const parsed = ScanResponse.safeParse(responseValue);
      if (!parsed.success) throw new Error("MALFORMED_PARSED_SCAN_RESPONSE");
      const page = parsed.data;
      if (
        page.data.some(
          (item) => item.slot === undefined && item.parsed?.slot === undefined,
        )
      )
        throw new Error("MALFORMED_PARSED_SCAN_RESPONSE");
      if (
        page.data.some(
          (item) =>
            (item.slot !== undefined &&
              item.parsed?.slot !== undefined &&
              item.slot !== item.parsed.slot) ||
            (item.blockTime !== undefined &&
              item.parsed?.blockTime !== undefined &&
              item.blockTime !== item.parsed.blockTime),
        )
      )
        throw new Error("CONFLICTING_PARSED_SCAN_TIME_METADATA");
      if (
        page.data.length > page.scan.matchedTransactions ||
        (page.scan.scannedTransactions > 0 && page.scan.scannedThrough === null)
      )
        throw new Error("MALFORMED_PARSED_SCAN_RESPONSE");
      if (page.scan.creditsCharged > reservedCredits)
        throw new Error("PARSED_SCAN_CHARGE_EXCEEDS_RESERVATION");
      this.#credits.settle(reservationDay, page.scan.creditsCharged);
      if ((page.scan.stoppedOn === "windowEnd") !== !page.paginationToken)
        throw new Error("INCONSISTENT_SCAN_COMPLETION");
      return {
        items: page.data.map((item) => {
          const protocol = item.parsed?.summary?.parsedData?.protocol ?? null;
          const kind =
            item.parsed?.summary?.parsedData?.kind?.toLowerCase() ?? null;
          const inputMint =
            item.parsed?.summary?.parsedData?.input_mint ?? null;
          const outputMint =
            item.parsed?.summary?.parsedData?.output_mint ?? null;
          const targetInstructions = (item.parsed?.instructions ?? []).filter(
            (instruction) =>
              HELIUS_TRADE_PROGRAMS.includes(
                instruction.programId as (typeof HELIUS_TRADE_PROGRAMS)[number],
              ),
          );
          const instructionNames = targetInstructions
            .map((instruction) => instruction.instructionName ?? "")
            .filter(Boolean);
          const nonTradeNames = new Set([
            "create",
            "create_v2",
            "migrate",
            "extend_account",
            "collect_creator_fee",
            "claim_cashback",
            "withdraw",
            "deposit",
          ]);
          const blockTime = item.blockTime ?? item.parsed?.blockTime ?? null;
          const inRequestedTime =
            blockTime !== null &&
            blockTime >= request.fromUnixSeconds &&
            blockTime < request.toUnixSeconds;
          const expectedSide =
            inputMint === HELIUS_WSOL_MINT && outputMint === request.mint
              ? "BUY"
              : inputMint === request.mint && outputMint === HELIUS_WSOL_MINT
                ? "SELL"
                : null;
          const protocolProgramMatches =
            (protocol === "pump_fun" &&
              targetInstructions.some(
                (instruction) => instruction.programId === HELIUS_PUMP_PROGRAM,
              )) ||
            (["pump_amm", "pumpswap"].includes(protocol ?? "") &&
              targetInstructions.some(
                (instruction) =>
                  instruction.programId === HELIUS_PUMPSWAP_PROGRAM,
              ));
          const summarySideMatches =
            (expectedSide === "BUY" && kind === "buy") ||
            (expectedSide === "SELL" && kind === "sell");
          const transactionParsedSuccessfully =
            item.parserStatus === "OK" &&
            item.parsed?.transactionStatus === "OK";
          const classification =
            inRequestedTime &&
            expectedSide !== null &&
            summarySideMatches &&
            protocolProgramMatches &&
            transactionParsedSuccessfully
              ? ("TRADE_CANDIDATE" as const)
              : inRequestedTime &&
                  transactionParsedSuccessfully &&
                  targetInstructions.length > 0 &&
                  targetInstructions.every(
                    (instruction) =>
                      instruction.instructionName &&
                      nonTradeNames.has(instruction.instructionName),
                  )
                ? ("NON_TRADE" as const)
                : ("UNSUPPORTED" as const);
          const reasonCode =
            classification === "TRADE_CANDIDATE" ||
            classification === "NON_TRADE"
              ? null
              : !inRequestedTime
                ? "SCAN_EVENT_OUTSIDE_REQUESTED_WINDOW"
                : protocol &&
                    ["pump_fun", "pump_amm", "pumpswap"].includes(protocol)
                  ? !expectedSide
                    ? "TRADE_MINT_OR_WSOL_PAIR_AMBIGUOUS"
                    : !summarySideMatches
                      ? "TRADE_SUMMARY_DIRECTION_MISMATCH"
                      : !protocolProgramMatches
                        ? "TRADE_PROTOCOL_PROGRAM_MISMATCH"
                        : "TRADE_PARSE_STATUS_UNVERIFIED"
                  : "SCAN_INSTRUCTION_UNSUPPORTED";
          return {
            signature: item.signature,
            slot: item.slot ?? item.parsed?.slot ?? -1,
            blockTime,
            parsedProtocol: protocol,
            parsedKind: kind,
            parsedMint: expectedSide ? request.mint : null,
            expectedSide,
            classification,
            reasonCode,
            instructionNames,
          };
        }),
        paginationToken: page.paginationToken ?? null,
        stoppedOn: page.scan.stoppedOn,
        scannedThrough: page.scan.scannedThrough,
        creditsCharged: page.scan.creditsCharged,
        scannedTransactions: page.scan.scannedTransactions,
      };
    } catch (error) {
      // If outcome is ambiguous (timeout/network failure), retain reservation for this day.
      if (controller.signal.aborted)
        throw new Error(request.signal?.aborted ? "CANCELLED" : "TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
    }
  }
}
