import { randomUUID } from "node:crypto";
import {
  PubkeySchema,
  QuoteRequestSchema,
  QuoteResultSchema,
  utcNow,
} from "@sentinel/domain";
import type {
  MarketSnapshot,
  QuoteRequest,
  QuoteResult,
} from "@sentinel/domain";
import { z } from "zod";
import {
  computeFeesBps,
  getBuyV3TokenAmountFromQuoteAmount,
  getSellSolAmountFromTokenAmount,
} from "@pump-fun/pump-sdk";
import type { BondingCurve, FeeConfig, Global } from "@pump-fun/pump-sdk";

export type PumpCurveQuoteState = {
  global: Global;
  feeConfig: FeeConfig;
  bondingCurve: BondingCurve;
  curveBaseTokenBalance: BondingCurve["virtualTokenReserves"];
  mintSupplyRaw: string;
  snapshot: MarketSnapshot;
};

/**
 * Exact-input Pump bonding-curve quotes using the current official Pump SDK.
 * State acquisition and provenance are supplied by a bounded RPC adapter; this
 * class never fetches data itself and therefore cannot bypass the Helius budget.
 */
export class PumpCurveQuoteEngine {
  quote(requestInput: QuoteRequest, state: PumpCurveQuoteState): QuoteResult {
    const request = QuoteRequestSchema.parse(requestInput);
    const now = Date.parse(request.requestedAtUtc);
    const snapshotAt = Date.parse(state.snapshot.observedAtUtc);
    const freshnessMs = Math.max(0, now - snapshotAt);
    const base = resultBase(request, state.snapshot, freshnessMs);
    if (state.snapshot.mint !== request.mint)
      return QuoteResultSchema.parse({
        ...base,
        validationStatus: "FAIL",
        failureReason: "MALFORMED_PROVIDER_DATA",
      });
    if (state.snapshot.venue !== "PUMP_BONDING_CURVE")
      return QuoteResultSchema.parse({
        ...base,
        venue: null,
        validationStatus: "UNKNOWN",
        failureReason: "VENUE_UNSUPPORTED",
      });
    if (snapshotAt > now || state.snapshot.confidenceBps !== 10000)
      return QuoteResultSchema.parse({
        ...base,
        validationStatus: "UNKNOWN",
        failureReason: "STATE_UNSAFE",
      });
    if (freshnessMs > request.maxAgeMs)
      return QuoteResultSchema.parse({
        ...base,
        validationStatus: "FAIL",
        failureReason: "STALE_SNAPSHOT",
      });
    if (
      state.bondingCurve.complete ||
      state.bondingCurve.virtualTokenReserves.isZero() ||
      state.bondingCurve.virtualQuoteReserves.isZero()
    )
      return QuoteResultSchema.parse({
        ...base,
        validationStatus: "UNKNOWN",
        failureReason: "VENUE_UNSUPPORTED",
      });
    const quoteMint = state.bondingCurve.quoteMint.toBase58();
    const normalizedQuoteMint =
      quoteMint === "11111111111111111111111111111111"
        ? "So11111111111111111111111111111111111111112"
        : quoteMint;
    const requestedQuoteMint =
      request.direction === "BUY" ? request.inputMint : request.outputMint;
    if (requestedQuoteMint !== normalizedQuoteMint)
      return QuoteResultSchema.parse({
        ...base,
        validationStatus: "FAIL",
        failureReason: "MALFORMED_PROVIDER_DATA",
      });

    const amount = bn(
      state.bondingCurve.virtualTokenReserves,
      request.exactInputAmountRaw,
    );
    const mintSupply = bn(
      state.bondingCurve.virtualTokenReserves,
      state.bondingCurve.isMayhemMode
        ? state.mintSupplyRaw
        : "1000000000000000",
    );
    let feeAmounts =
      request.direction === "BUY"
        ? exactInputFeeAmounts(request.exactInputAmountRaw, state, mintSupply)
        : undefined;
    let output: string;
    let idealOutput: bigint;
    if (request.direction === "BUY") {
      output = getBuyV3TokenAmountFromQuoteAmount({
        global: state.global,
        feeConfig: state.feeConfig,
        mintSupply,
        bondingCurve: state.bondingCurve,
        amount,
        curveBaseTokenBalance: state.curveBaseTokenBalance,
      }).toString();
      idealOutput =
        (BigInt(request.exactInputAmountRaw) *
          BigInt(state.bondingCurve.virtualTokenReserves.toString())) /
        BigInt(state.bondingCurve.virtualQuoteReserves.toString());
    } else {
      output = getSellSolAmountFromTokenAmount({
        global: state.global,
        feeConfig: state.feeConfig,
        mintSupply,
        bondingCurve: state.bondingCurve,
        amount,
      }).toString();
      const inputRaw = BigInt(request.exactInputAmountRaw);
      const grossQuote = (
        (inputRaw *
          BigInt(state.bondingCurve.virtualQuoteReserves.toString())) /
        (BigInt(state.bondingCurve.virtualTokenReserves.toString()) + inputRaw)
      ).toString();
      const sellFees = exactFeeAmounts(grossQuote, state, mintSupply);
      feeAmounts = {
        ...sellFees,
        unallocated: "0",
      };
      idealOutput =
        (BigInt(request.exactInputAmountRaw) *
          BigInt(state.bondingCurve.virtualQuoteReserves.toString())) /
        BigInt(state.bondingCurve.virtualTokenReserves.toString());
    }
    const actualOutput = BigInt(output);
    if (actualOutput === 0n)
      return QuoteResultSchema.parse({
        ...base,
        validationStatus: "FAIL",
        failureReason: "INSUFFICIENT_LIQUIDITY",
      });
    const priceImpactBps =
      idealOutput <= actualOutput || idealOutput === 0n
        ? 0
        : Number(((idealOutput - actualOutput) * 10000n) / idealOutput);
    return QuoteResultSchema.parse({
      ...base,
      expectedOutputAmountRaw: output,
      feeAmountRaw: (
        BigInt(feeAmounts?.protocol ?? "0") + BigInt(feeAmounts?.creator ?? "0")
      ).toString(),
      feeBreakdownRaw: feeAmounts,
      feeMint:
        request.direction === "BUY" ? request.inputMint : request.outputMint,
      feeModel: "PUMP_OFFICIAL_SDK_V3_PROTOCOL_CREATOR_FEES_DECOMPOSED",
      priceImpactBps,
      liquidityQuoteRaw: state.bondingCurve.realQuoteReserves.toString(),
      validationStatus: "PASS",
      failureReason: null,
      provenance: {
        provider: state.snapshot.source,
        stateRef: state.snapshot.stateRef,
        quoteSdk: "@pump-fun/pump-sdk@4.1.0",
        sdkFeeScheduleApplied: true,
      },
    });
  }
}

function exactInputFeeAmounts(
  exactInputRaw: string,
  state: PumpCurveQuoteState,
  mintSupply: { constructor: unknown },
) {
  const rates = curveFeeRates(state, mintSupply);
  const totalBps = rates.protocolBps + rates.creatorBps;
  const gross = BigInt(exactInputRaw);
  let net = totalBps === 0n ? gross : (gross * 10000n) / (10000n + totalBps);
  let protocol = ceilBps(net, rates.protocolBps);
  let creator = ceilBps(net, rates.creatorBps);
  const excess = net + protocol + creator - gross;
  if (excess > 0n) {
    net -= excess;
    protocol = ceilBps(net, rates.protocolBps);
    creator = ceilBps(net, rates.creatorBps);
  }
  return {
    protocol: protocol.toString(),
    creator: creator.toString(),
    liquidityProvider: "0",
    unallocated: (gross - net - protocol - creator).toString(),
  };
}

function exactFeeAmounts(
  grossQuoteRaw: string,
  state: PumpCurveQuoteState,
  mintSupply: { constructor: unknown },
) {
  const rates = curveFeeRates(state, mintSupply);
  const gross = BigInt(grossQuoteRaw);
  const protocol = ceilBps(gross, rates.protocolBps);
  const creator = ceilBps(gross, rates.creatorBps);
  return {
    protocol: protocol.toString(),
    creator: creator.toString(),
    liquidityProvider: "0",
    unallocated: "0",
  };
}

function curveFeeRates(
  state: PumpCurveQuoteState,
  mintSupplyTemplate: { constructor: unknown },
) {
  const supply = bn(
    mintSupplyTemplate,
    state.bondingCurve.isMayhemMode ? state.mintSupplyRaw : "1000000000000000",
  );
  const fees = computeFeesBps({
    global: state.global,
    feeConfig: state.feeConfig,
    mintSupply: supply,
    virtualQuoteReserves: state.bondingCurve.virtualQuoteReserves,
    virtualTokenReserves: state.bondingCurve.virtualTokenReserves,
    quoteMint: state.bondingCurve.quoteMint,
    creatorFeeBps: state.bondingCurve.creatorFeeBps,
  });
  return {
    protocolBps: BigInt(fees.protocolFeeBps.toString()),
    creatorBps:
      state.bondingCurve.creator.toBase58() ===
      "11111111111111111111111111111111"
        ? 0n
        : BigInt(fees.creatorFeeBps.toString()),
  };
}

function ceilBps(amount: bigint, bps: bigint): bigint {
  if (bps === 0n || amount === 0n) return 0n;
  return (amount * bps + 9999n) / 10000n;
}

export type JupiterQuoteOptions = {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
  maxRequestsPerSecond?: number;
  consumeRequestBudget?: () => boolean;
  now?: () => number;
  baseUrl?: string;
};

const JupiterOrderSchema = z.object({
  transaction: z.string().nullable(),
  requestId: z.string().min(1),
  inAmount: z.string().regex(/^\d+$/).optional(),
  outAmount: z.string().regex(/^\d+$/),
  router: z.string().min(1),
  mode: z.string().min(1),
  feeBps: z.number().int().nonnegative(),
  feeMint: z.string().min(1),
  priceImpactPct: z.string().max(32).optional(),
  platformFee: z
    .object({ amount: z.string().regex(/^\d+$/).optional() })
    .optional(),
});

/** Quote-only Jupiter adapter: never supplies taker and never calls execute. */
export class JupiterQuoteClient {
  readonly #options: JupiterQuoteOptions;
  #requestGate: Promise<void> = Promise.resolve();
  #lastRequestAt = 0;

  constructor(options: JupiterQuoteOptions) {
    this.#options = options;
  }

  async quote(requestInput: QuoteRequest): Promise<QuoteResult> {
    const request = QuoteRequestSchema.parse(requestInput);
    const requestedAtMs = this.#options.now?.() ?? Date.now();
    const observedAtUtc = new Date(requestedAtMs).toISOString();
    const params = new URLSearchParams({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amount: request.exactInputAmountRaw,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs);
    try {
      await this.#pace();
      if (
        this.#options.consumeRequestBudget &&
        !this.#options.consumeRequestBudget()
      )
        return jupiterFailure(
          request,
          observedAtUtc,
          "PROVIDER_BUDGET_EXHAUSTED",
        );
      const response = await (this.#options.fetchImpl ?? fetch)(
        `${this.#options.baseUrl ?? "https://api.jup.ag/swap/v2"}/order?${params.toString()}`,
        {
          headers: this.#options.apiKey
            ? { "x-api-key": this.#options.apiKey }
            : {},
          signal: controller.signal,
        },
      );
      if (response.status === 429)
        return jupiterFailure(request, observedAtUtc, "RATE_LIMITED");
      if (!response.ok)
        return jupiterFailure(request, observedAtUtc, "PROVIDER_UNAVAILABLE");
      const parsed = JupiterOrderSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.transaction !== null)
        return jupiterFailure(
          request,
          observedAtUtc,
          "MALFORMED_PROVIDER_DATA",
        );
      const order = parsed.data;
      const impact = order.priceImpactPct
        ? decimalFractionToBps(order.priceImpactPct)
        : null;
      const amount = order.inAmount ?? request.exactInputAmountRaw;
      return QuoteResultSchema.parse({
        id: `jupiter:${order.requestId}`,
        mint: request.mint,
        direction: request.direction,
        exactInputAmountRaw: amount,
        expectedOutputAmountRaw: order.outAmount,
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        venue: "JUPITER",
        source: "JUPITER_ORDER_QUOTE_ONLY",
        snapshotSlot: null,
        snapshotAtUtc: null,
        feeAmountRaw: order.platformFee?.amount ?? null,
        feeMint: PubkeySchema.safeParse(order.feeMint).success
          ? order.feeMint
          : null,
        feeModel: `JUPITER_ORDER_TOTAL_FEE_BPS_${order.feeBps}`,
        priceImpactBps: impact,
        liquidityQuoteRaw: null,
        freshnessMs: null,
        validationStatus: "UNKNOWN",
        failureReason:
          impact === null ? "PRICE_IMPACT_UNKNOWN" : "STATE_MISSING",
        evidenceRefs: [`jupiter_order:${order.requestId}`],
        provenance: {
          provider: "Jupiter Swap V2",
          router: order.router,
          mode: order.mode,
          slotUnavailable: true,
          noTakerTransactionRequested: true,
        },
        observedAtUtc,
      });
    } catch (error) {
      return jupiterFailure(
        request,
        observedAtUtc,
        error instanceof Error && error.name === "AbortError"
          ? "QUOTE_TIMEOUT"
          : "PROVIDER_UNAVAILABLE",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #pace(): Promise<void> {
    let release = (): void => undefined;
    const previous = this.#requestGate;
    this.#requestGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const rate = this.#options.maxRequestsPerSecond ?? 1;
      const intervalMs = 1000 / rate;
      const now = this.#options.now?.() ?? Date.now();
      const waitMs = Math.max(0, intervalMs - (now - this.#lastRequestAt));
      if (waitMs > 0)
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.#lastRequestAt = this.#options.now?.() ?? Date.now();
    } finally {
      release();
    }
  }
}

function resultBase(
  request: QuoteRequest,
  snapshot: MarketSnapshot,
  freshnessMs: number,
) {
  return {
    id: randomUUID(),
    mint: request.mint,
    direction: request.direction,
    exactInputAmountRaw: request.exactInputAmountRaw,
    expectedOutputAmountRaw: null,
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    venue: snapshot.venue,
    source: "PUMP_OFFICIAL_SDK",
    snapshotSlot: snapshot.slot,
    snapshotAtUtc: snapshot.observedAtUtc,
    feeAmountRaw: null,
    feeMint: null,
    feeModel: "UNKNOWN",
    priceImpactBps: null,
    liquidityQuoteRaw: snapshot.liquidityQuoteRaw,
    freshnessMs,
    validationStatus: "UNKNOWN" as const,
    failureReason: null,
    evidenceRefs: [snapshot.stateRef],
    provenance: { provider: snapshot.source },
    observedAtUtc: utcNow(),
  };
}

function jupiterFailure(
  request: QuoteRequest,
  observedAtUtc: string,
  reason: QuoteResult["failureReason"],
): QuoteResult {
  return QuoteResultSchema.parse({
    id: randomUUID(),
    mint: request.mint,
    direction: request.direction,
    exactInputAmountRaw: request.exactInputAmountRaw,
    expectedOutputAmountRaw: null,
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    venue: "JUPITER",
    source: "JUPITER_ORDER_QUOTE_ONLY",
    snapshotSlot: null,
    snapshotAtUtc: null,
    feeAmountRaw: null,
    feeMint: null,
    feeModel: "UNKNOWN",
    priceImpactBps: null,
    liquidityQuoteRaw: null,
    freshnessMs: null,
    validationStatus: "FAIL",
    failureReason: reason,
    evidenceRefs: [],
    provenance: { provider: "Jupiter Swap V2" },
    observedAtUtc,
  });
}

function bn(template: { constructor: unknown }, value: string) {
  const Constructor = template.constructor as new (
    value: string,
    base?: number,
  ) => typeof template;
  return new Constructor(value, 10);
}

function decimalFractionToBps(value: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > 18) return null;
  const scaleDigits = Math.max(fraction.length, 4);
  const scale = 10n ** BigInt(scaleDigits);
  const numerator =
    BigInt(whole) * scale + BigInt(fraction.padEnd(scaleDigits, "0"));
  const bps = (numerator * 10000n) / scale;
  return bps <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bps) : null;
}
