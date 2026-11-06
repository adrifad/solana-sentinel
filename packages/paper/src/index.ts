import { PaperOrderIntentSchema, QuoteResultSchema } from "@sentinel/domain";
import type { PaperOrderIntent, QuoteResult } from "@sentinel/domain";
import type { AppConfig } from "@sentinel/config";
import {
  PumpCurveQuoteEngine,
  PumpCurveStateLoader,
  PumpSwapQuoteEngine,
  PumpSwapStateLoader,
} from "@sentinel/providers";
import type { HeliusRpcClient } from "@sentinel/providers";

export const PAPER_SOL_MINT = "So11111111111111111111111111111111111111112";

export function solToLamports(value: string): string {
  const parsed = /^(\d+)(?:\.(\d{1,9}))?$/.exec(value);
  if (!parsed) throw new Error("SOL_AMOUNT_PRECISION_INVALID");
  const whole = BigInt(parsed[1]!);
  const fraction = BigInt((parsed[2] ?? "").padEnd(9, "0") || "0");
  return (whole * 1_000_000_000n + fraction).toString();
}

export function paperExecutionConfigFromAppConfig(
  config: AppConfig,
): PaperExecutionConfig {
  return {
    executionLatencyMs: config.paper.execution_latency_ms,
    maxQuoteAgeMs: config.paper.max_quote_age_ms,
    maxIntentAgeMs: config.strategy.max_signal_age_ms,
    manualEntryMaxAgeMs: config.paper.manual_entry_request_expiry_ms,
    manualExitMaxAgeMs: config.paper.manual_exit_request_expiry_ms,
    conservativeExtraSlippageBps: config.paper.conservative_extra_slippage_bps,
    modeledNetworkFeeLamports: config.paper.modeled_network_fee_lamports,
    risk: {
      maxTradeInputRaw: solToLamports(config.risk.max_trade_sol),
      maxExposureLamports: solToLamports(config.risk.max_exposure_sol),
      maxOpenPositions: config.risk.max_open_positions,
      maxDailyLossLamports: solToLamports(config.risk.max_daily_loss_sol),
      maxDrawdownBps: config.risk.max_drawdown_bps,
      maxPriceImpactBps: config.risk.max_price_impact_bps,
      maxSlippageBps: config.risk.max_slippage_bps,
      pauseNewEntries: config.risk.emergency_pause,
    },
  };
}

export function paperInitialBalanceLamports(config: AppConfig): string {
  return solToLamports(config.paper.initial_sol);
}

export type PaperQuoteRequest = {
  mint: string;
  side: "BUY" | "SELL";
  exactInputAmountRaw: string;
  requestedAtUtc: string;
  arrivalAtUtc?: string;
  maxAgeMs: number;
  priority?: "CANDIDATE" | "EXIT";
};

export interface PaperQuoteProvider {
  quoteAtArrival(request: PaperQuoteRequest): Promise<QuoteResult | null>;
}

export type PaperRiskLimits = {
  maxTradeInputRaw: string;
  maxExposureLamports: string;
  maxOpenPositions: number;
  maxDailyLossLamports: string;
  maxDrawdownBps: number;
  maxPriceImpactBps: number;
  maxSlippageBps: number;
  pauseNewEntries: boolean;
};

export type PaperExecutionConfig = {
  executionLatencyMs: number;
  maxQuoteAgeMs: number;
  maxIntentAgeMs: number;
  manualEntryMaxAgeMs?: number;
  manualExitMaxAgeMs?: number;
  conservativeExtraSlippageBps: number;
  modeledNetworkFeeLamports: string;
  risk: PaperRiskLimits;
};

type PaperOrderRecord = {
  id: string;
  walletId: string;
  idempotencyKey: string;
  mint: string;
  side: "BUY" | "SELL";
  inputAmountRaw: string;
  status:
    "PENDING" | "SIMULATED_FILLED" | "REJECTED" | "UNFILLABLE" | "EXPIRED";
  reasonCode: string | null;
  createdAtUtc: string;
  entrySource: "AUTOMATIC" | "MANUAL";
};

export type PaperAccountInitialization = {
  walletId: string;
  initialSolLamports: string;
  createdAtUtc: string;
  configuredInitialBalanceMatches: boolean;
};

export interface PaperRepository {
  initializePaperAccount(
    walletId: string,
    initialSolLamports: string,
    createdAtUtc: string,
  ): PaperAccountInitialization;
  createPaperOrder(intent: PaperOrderIntent): PaperOrderRecord;
  getPaperOrder(orderId: string): PaperOrderRecord | null;
  listPendingPaperOrderIntents(
    limit?: number,
    excludeManual?: boolean,
  ): PaperOrderIntent[];
  rejectPaperOrder(
    orderId: string,
    status: "REJECTED" | "UNFILLABLE" | "EXPIRED",
    reasonCode: string,
    completedAtUtc: string,
    arrivalAtUtc?: string | null,
  ): void;
  saveQuoteResult(quote: QuoteResult): void;
  applyPaperFill(input: {
    orderId: string;
    quote: QuoteResult;
    outputAmountRaw: string;
    venueFeeRaw: string;
    networkFeeLamports: string;
    extraSlippageBps: number;
    maxSlippageBps: number;
    maxPriceImpactBps: number;
    arrivalAtUtc: string;
    filledAtUtc: string;
    maxTradeInputRaw: string;
    maxExposureLamports: string;
    maxOpenPositions: number;
    maxDailyLossLamports: string;
    maxDrawdownBps: number;
    maxQuoteAgeMs: number;
    pauseNewEntries: boolean;
  }): { status: "SIMULATED_FILLED" | "REJECTED"; reasonCode: string | null };
  getPaperPortfolioState(walletId: string): PaperPortfolioState;
  recordPaperEquityMark(
    walletId: string,
    equityLamports: string,
    unpriceablePositions: number,
    markedAtUtc: string,
  ): { peakEquityLamports: string; drawdownBps: number };
  recordPaperPositionMark?(input: {
    walletId: string;
    mint: string;
    markedAtUtc: string;
    sellQuoteId: string;
    sellValueLamports: string;
    unrealizedPnlLamports: string;
    snapshotSlot: number;
  }): void;
  getPaperFill(orderId: string): Record<string, string | number> | null;
}

export type PaperPortfolioState = {
  solBalanceRaw: string;
  positions: Array<{
    mint: string;
    tokenAmountRaw: string;
    costBasisLamports: string;
    openedAtUtc: string;
    latestMark: {
      markedAtUtc: string;
      sellQuoteId: string;
      sellValueLamports: string;
      unrealizedPnlLamports: string;
      snapshotSlot: number;
    } | null;
  }>;
  realizedPnl: Array<{ pnlLamports: string; filledAtUtc: string }>;
  latestMark: {
    markedAtUtc: string;
    equityLamports: string;
    peakEquityLamports: string;
    drawdownBps: number;
    unpriceablePositions: number;
  } | null;
};

export type PaperClock = {
  now: () => number;
  wait: (milliseconds: number) => Promise<void>;
};

export type PaperExecutionResult = {
  order: PaperOrderRecord;
  fill: Record<string, string | number> | null;
  reasonCode: string | null;
};

export class PaperTradingEngine {
  readonly #repository: PaperRepository;
  readonly #quotes: PaperQuoteProvider;
  readonly #config: PaperExecutionConfig;
  readonly #clock: PaperClock;
  readonly #riskManager = new PaperRiskManager();

  constructor(options: {
    repository: PaperRepository;
    quotes: PaperQuoteProvider;
    config: PaperExecutionConfig;
    clock?: PaperClock;
  }) {
    this.#repository = options.repository;
    this.#quotes = options.quotes;
    this.#config = options.config;
    this.#clock = options.clock ?? {
      now: Date.now,
      wait: (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
    };
    validateExecutionConfig(this.#config);
  }

  initializeWallet(walletId: string, initialSol: string) {
    return this.#repository.initializePaperAccount(
      walletId,
      solToLamports(initialSol),
      new Date(this.#clock.now()).toISOString(),
    );
  }

  async execute(intentInput: PaperOrderIntent): Promise<PaperExecutionResult> {
    const intent = PaperOrderIntentSchema.parse(intentInput);
    const order = this.#repository.createPaperOrder(intent);
    if (order.status !== "PENDING")
      return {
        order,
        fill: this.#repository.getPaperFill(order.id),
        reasonCode: order.reasonCode,
      };
    // The legacy emergency_pause setting now pauses new exposure only.
    // Risk-reducing SELL exits remain available and are checked atomically by storage.
    if (this.#config.risk.pauseNewEntries && intent.side === "BUY") {
      this.#repository.rejectPaperOrder(
        order.id,
        "REJECTED",
        "PAPER_NEW_ENTRIES_PAUSED",
        new Date(this.#clock.now()).toISOString(),
      );
      return this.#result(order.id);
    }

    const nowAtStart = this.#clock.now();
    const effectiveIntent =
      intent.entrySource === "MANUAL" && !intent.expiresAtUtc
        ? {
            ...intent,
            expiresAtUtc: new Date(
              Date.parse(intent.createdAtUtc) +
                (intent.side === "BUY"
                  ? (this.#config.manualEntryMaxAgeMs ??
                    this.#config.maxIntentAgeMs)
                  : (this.#config.manualExitMaxAgeMs ??
                    this.#config.maxIntentAgeMs)),
            ).toISOString(),
          }
        : intent;
    if (
      isPaperIntentExpired(
        effectiveIntent,
        nowAtStart,
        this.#config.maxIntentAgeMs,
      )
    ) {
      this.#repository.rejectPaperOrder(
        order.id,
        "EXPIRED",
        "PAPER_INTENT_EXPIRED",
        new Date(nowAtStart).toISOString(),
      );
      return this.#result(order.id);
    }

    await this.#clock.wait(this.#config.executionLatencyMs);
    const arrivalAtUtc = new Date(this.#clock.now()).toISOString();
    const quoteRequestedAtUtc = new Date(this.#clock.now()).toISOString();
    let quote: QuoteResult | null;
    try {
      quote = await this.#quotes.quoteAtArrival({
        mint: intent.mint,
        side: intent.side,
        exactInputAmountRaw: intent.exactInputAmountRaw,
        requestedAtUtc: quoteRequestedAtUtc,
        arrivalAtUtc,
        maxAgeMs: this.#config.maxQuoteAgeMs,
      });
    } catch {
      quote = null;
    }
    const quoteReadyAtUtc = new Date(this.#clock.now()).toISOString();
    if (
      isPaperIntentExpired(
        effectiveIntent,
        this.#clock.now(),
        this.#config.maxIntentAgeMs,
      )
    ) {
      this.#repository.rejectPaperOrder(
        order.id,
        "EXPIRED",
        "PAPER_INTENT_EXPIRED",
        quoteReadyAtUtc,
        arrivalAtUtc,
      );
      return this.#result(order.id);
    }
    if (!quote) {
      this.#repository.rejectPaperOrder(
        order.id,
        "UNFILLABLE",
        "PAPER_QUOTE_UNAVAILABLE",
        new Date(this.#clock.now()).toISOString(),
        arrivalAtUtc,
      );
      return this.#result(order.id);
    }
    const parsedQuote = QuoteResultSchema.safeParse(quote);
    if (!parsedQuote.success) {
      this.#repository.rejectPaperOrder(
        order.id,
        "UNFILLABLE",
        "PAPER_QUOTE_MALFORMED",
        new Date(this.#clock.now()).toISOString(),
        arrivalAtUtc,
      );
      return this.#result(order.id);
    }
    const validReason = this.#riskManager.validateQuote(
      parsedQuote.data,
      intent,
      quoteReadyAtUtc,
      this.#config,
    );
    if (validReason) {
      this.#repository.saveQuoteResult(parsedQuote.data);
      this.#repository.rejectPaperOrder(
        order.id,
        "UNFILLABLE",
        validReason,
        new Date(this.#clock.now()).toISOString(),
        arrivalAtUtc,
      );
      return this.#result(order.id);
    }
    this.#repository.saveQuoteResult(parsedQuote.data);
    const quotedOutput = BigInt(parsedQuote.data.expectedOutputAmountRaw!);
    const simulatedOutput =
      (quotedOutput *
        BigInt(10000 - this.#config.conservativeExtraSlippageBps)) /
      10000n;
    const fill = this.#repository.applyPaperFill({
      orderId: order.id,
      quote: parsedQuote.data,
      outputAmountRaw: simulatedOutput.toString(),
      venueFeeRaw: parsedQuote.data.feeAmountRaw ?? "0",
      networkFeeLamports: this.#config.modeledNetworkFeeLamports,
      extraSlippageBps: this.#config.conservativeExtraSlippageBps,
      arrivalAtUtc,
      filledAtUtc: quoteReadyAtUtc,
      ...this.#config.risk,
      maxQuoteAgeMs: this.#config.maxQuoteAgeMs,
    });
    await this.refreshPortfolio(intent.walletId);
    return {
      order: this.#repository.getPaperOrder(intent.id) ?? order,
      fill: this.#repository.getPaperFill(intent.id),
      reasonCode: fill.reasonCode,
    };
  }

  async recoverPendingOrders(
    limit = 100,
    excludeManual = false,
  ): Promise<PaperExecutionResult[]> {
    const pending = this.#repository.listPendingPaperOrderIntents(
      limit,
      excludeManual,
    );
    const recovered: PaperExecutionResult[] = [];
    for (const intent of pending) recovered.push(await this.execute(intent));
    return recovered;
  }

  async refreshPortfolio(
    walletId: string,
    knownSellQuotes?: ReadonlyMap<string, QuoteResult | null>,
  ): Promise<PaperPortfolioReport> {
    const state = this.#repository.getPaperPortfolioState(walletId);
    let observedAtUtc = new Date(this.#clock.now()).toISOString();
    let positionValue = 0n;
    let costBasis = 0n;
    let unrealized = 0n;
    let unpriceablePositions = 0;
    for (const position of state.positions) {
      costBasis += BigInt(position.costBasisLamports);
      let quote = knownSellQuotes?.has(position.mint)
        ? (knownSellQuotes.get(position.mint) ?? null)
        : null;
      if (!knownSellQuotes?.has(position.mint)) {
        try {
          quote = await this.#quotes.quoteAtArrival({
            mint: position.mint,
            side: "SELL",
            exactInputAmountRaw: position.tokenAmountRaw,
            requestedAtUtc: observedAtUtc,
            maxAgeMs: this.#config.maxQuoteAgeMs,
          });
        } catch {
          quote = null;
        }
      }
      const quoteReadyAtUtc = new Date(this.#clock.now()).toISOString();
      const parsedQuote = quote ? QuoteResultSchema.safeParse(quote) : null;
      const validQuote = parsedQuote?.success ? parsedQuote.data : null;
      if (
        !validQuote ||
        validQuote.validationStatus !== "PASS" ||
        validQuote.mint !== position.mint ||
        validQuote.direction !== "SELL" ||
        validQuote.exactInputAmountRaw !== position.tokenAmountRaw ||
        validQuote.inputMint !== position.mint ||
        validQuote.outputMint !== PAPER_SOL_MINT ||
        validQuote.venue === null ||
        validQuote.feeMint !== PAPER_SOL_MINT ||
        validQuote.expectedOutputAmountRaw === null ||
        !/^\d+$/.test(validQuote.expectedOutputAmountRaw) ||
        (validQuote.feeAmountRaw !== null &&
          BigInt(validQuote.feeAmountRaw) >
            BigInt(validQuote.expectedOutputAmountRaw)) ||
        validQuote.snapshotSlot === null ||
        validQuote.snapshotAtUtc === null ||
        Date.parse(validQuote.observedAtUtc) > Date.parse(quoteReadyAtUtc) ||
        Date.parse(validQuote.snapshotAtUtc) > Date.parse(quoteReadyAtUtc) ||
        (validQuote.freshnessMs ?? Number.MAX_SAFE_INTEGER) >
          this.#config.maxQuoteAgeMs ||
        Date.parse(quoteReadyAtUtc) - Date.parse(validQuote.snapshotAtUtc) >
          this.#config.maxQuoteAgeMs ||
        validQuote.priceImpactBps === null ||
        validQuote.priceImpactBps > this.#config.risk.maxPriceImpactBps
      ) {
        unpriceablePositions += 1;
        continue;
      }
      const quotedOutput =
        (BigInt(validQuote.expectedOutputAmountRaw) *
          BigInt(10000 - this.#config.conservativeExtraSlippageBps)) /
        10000n;
      const networkFee = BigInt(this.#config.modeledNetworkFeeLamports);
      const netOutput =
        quotedOutput > networkFee ? quotedOutput - networkFee : 0n;
      this.#repository.saveQuoteResult(validQuote);
      positionValue += netOutput;
      const positionPnl = netOutput - BigInt(position.costBasisLamports);
      unrealized += positionPnl;
      if (validQuote.snapshotSlot !== null)
        this.#repository.recordPaperPositionMark?.({
          walletId,
          mint: position.mint,
          markedAtUtc: observedAtUtc,
          sellQuoteId: validQuote.id,
          sellValueLamports: netOutput.toString(),
          unrealizedPnlLamports: positionPnl.toString(),
          snapshotSlot: validQuote.snapshotSlot,
        });
    }
    observedAtUtc = new Date(this.#clock.now()).toISOString();
    const equity = BigInt(state.solBalanceRaw) + positionValue;
    const mark = this.#repository.recordPaperEquityMark(
      walletId,
      equity.toString(),
      unpriceablePositions,
      observedAtUtc,
    );
    const realized = state.realizedPnl.reduce(
      (sum, item) => sum + BigInt(item.pnlLamports),
      0n,
    );
    const today = observedAtUtc.slice(0, 10);
    const dailyRealized = state.realizedPnl
      .filter((item) => item.filledAtUtc.slice(0, 10) === today)
      .reduce((sum, item) => sum + BigInt(item.pnlLamports), 0n);
    return {
      walletId,
      solBalanceLamports: state.solBalanceRaw,
      positionValueLamports: positionValue.toString(),
      costBasisLamports: costBasis.toString(),
      realizedPnlLamports: realized.toString(),
      unrealizedPnlLamports:
        unpriceablePositions === 0 ? unrealized.toString() : null,
      dailyRealizedPnlLamports: dailyRealized.toString(),
      equityLamports: equity.toString(),
      peakEquityLamports: mark.peakEquityLamports,
      drawdownBps: mark.drawdownBps,
      unpriceablePositions,
      markedAtUtc: observedAtUtc,
    };
  }

  async #result(orderId: string): Promise<PaperExecutionResult> {
    const order = this.#repository.getPaperOrder(orderId);
    if (!order) throw new Error("PAPER_ORDER_NOT_FOUND");
    return {
      order,
      fill: this.#repository.getPaperFill(orderId),
      reasonCode: order.reasonCode,
    };
  }
}

export type PaperPortfolioReport = {
  walletId: string;
  solBalanceLamports: string;
  positionValueLamports: string;
  costBasisLamports: string;
  realizedPnlLamports: string;
  unrealizedPnlLamports: string | null;
  dailyRealizedPnlLamports: string;
  equityLamports: string;
  peakEquityLamports: string;
  drawdownBps: number;
  unpriceablePositions: number;
  markedAtUtc: string;
};

export class PaperRiskManager {
  validateQuote(
    quote: QuoteResult,
    intent: PaperOrderIntent,
    settledAtUtc: string,
    config: PaperExecutionConfig,
  ): string | null {
    return validateQuoteAtArrival(quote, intent, settledAtUtc, config);
  }

  canOpenRisk(input: {
    report: PaperPortfolioReport;
    maxDrawdownBps: number;
    maxDailyLossLamports: string;
  }): { allowed: boolean; reasonCode: string | null } {
    if (input.report.unpriceablePositions > 0)
      return { allowed: false, reasonCode: "PAPER_UNPRICEABLE_EXPOSURE" };
    if (input.report.drawdownBps >= input.maxDrawdownBps)
      return { allowed: false, reasonCode: "PAPER_DRAWDOWN_LIMIT" };
    if (
      BigInt(input.report.dailyRealizedPnlLamports) <=
      -BigInt(input.maxDailyLossLamports)
    )
      return { allowed: false, reasonCode: "PAPER_DAILY_LOSS_LIMIT" };
    return { allowed: true, reasonCode: null };
  }
}

export class PaperExitStrategy {
  evaluate(input: {
    mint: string;
    costBasisLamports: string;
    positionTokenAmountRaw: string;
    positionOpenedAtUtc: string;
    observedAtUtc: string;
    sellQuote: QuoteResult | null;
    maxQuoteAgeMs: number;
    maxPriceImpactBps: number;
    extraSlippageBps: number;
    networkFeeLamports: string;
    stopLossBps: number;
    takeProfitBps: number;
    maxHoldSeconds: number;
  }): { action: "HOLD" | "EXIT"; reasonCode: string } {
    const parsedQuote = input.sellQuote
      ? QuoteResultSchema.safeParse(input.sellQuote)
      : null;
    const quote = parsedQuote?.success ? parsedQuote.data : null;
    if (!quote || quote.validationStatus !== "PASS")
      return { action: "HOLD", reasonCode: "EXIT_QUOTE_UNAVAILABLE" };
    if (
      quote.direction !== "SELL" ||
      quote.mint !== input.mint ||
      quote.inputMint !== input.mint ||
      quote.outputMint !== PAPER_SOL_MINT ||
      quote.venue === null ||
      quote.feeMint !== PAPER_SOL_MINT ||
      !quote.expectedOutputAmountRaw ||
      !/^\d+$/.test(quote.expectedOutputAmountRaw) ||
      quote.exactInputAmountRaw !== input.positionTokenAmountRaw ||
      quote.snapshotSlot === null ||
      quote.snapshotAtUtc === null ||
      quote.freshnessMs === null ||
      Date.parse(quote.observedAtUtc) > Date.parse(input.observedAtUtc) ||
      Date.parse(quote.snapshotAtUtc) > Date.parse(input.observedAtUtc) ||
      Date.parse(input.observedAtUtc) - Date.parse(quote.snapshotAtUtc) >
        input.maxQuoteAgeMs ||
      quote.freshnessMs > input.maxQuoteAgeMs ||
      quote.priceImpactBps === null ||
      quote.priceImpactBps > input.maxPriceImpactBps ||
      input.extraSlippageBps < 0 ||
      input.extraSlippageBps > 10000 ||
      !/^\d+$/.test(input.networkFeeLamports)
    )
      return { action: "HOLD", reasonCode: "EXIT_QUOTE_UNVERIFIED" };
    const ageSeconds =
      (Date.parse(input.observedAtUtc) -
        Date.parse(input.positionOpenedAtUtc)) /
      1000;
    if (ageSeconds >= input.maxHoldSeconds)
      return { action: "EXIT", reasonCode: "MAX_HOLD_TIME_REACHED" };
    const cost = BigInt(input.costBasisLamports);
    const quotedProceeds =
      (BigInt(quote.expectedOutputAmountRaw) *
        BigInt(10000 - input.extraSlippageBps)) /
      10000n;
    const networkFee = BigInt(input.networkFeeLamports);
    const proceeds =
      quotedProceeds > networkFee ? quotedProceeds - networkFee : 0n;
    if (cost === 0n)
      return { action: "HOLD", reasonCode: "POSITION_COST_BASIS_UNKNOWN" };
    if ((proceeds - cost) * 10000n <= -cost * BigInt(input.stopLossBps))
      return { action: "EXIT", reasonCode: "STOP_LOSS_REACHED" };
    if ((proceeds - cost) * 10000n >= cost * BigInt(input.takeProfitBps))
      return { action: "EXIT", reasonCode: "TAKE_PROFIT_REACHED" };
    return { action: "HOLD", reasonCode: "EXIT_CONDITIONS_NOT_MET" };
  }
}

export class PumpVenuePaperQuoteProvider implements PaperQuoteProvider {
  readonly #curveState: PumpCurveStateLoader;
  readonly #swapState: PumpSwapStateLoader;
  readonly #curveQuotes = new PumpCurveQuoteEngine();
  readonly #swapQuotes = new PumpSwapQuoteEngine();
  readonly #marketPhase: (mint: string) => Promise<string> | string;
  readonly #now: () => number;

  constructor(options: {
    helius: HeliusRpcClient;
    marketPhase: (mint: string) => Promise<string> | string;
    now?: () => number;
  }) {
    this.#curveState = new PumpCurveStateLoader({
      helius: options.helius,
      ...(options.now ? { now: options.now } : {}),
    });
    this.#swapState = new PumpSwapStateLoader({
      helius: options.helius,
      ...(options.now ? { now: options.now } : {}),
    });
    this.#marketPhase = options.marketPhase;
    this.#now = options.now ?? Date.now;
  }

  async quoteAtArrival(
    request: PaperQuoteRequest,
  ): Promise<QuoteResult | null> {
    const requestStartedAtUtc = request.requestedAtUtc;
    const phase = await this.#marketPhase(request.mint);
    const direction = request.side;
    const inputMint = direction === "BUY" ? PAPER_SOL_MINT : request.mint;
    const outputMint = direction === "BUY" ? request.mint : PAPER_SOL_MINT;
    const makeQuoteRequest = (snapshotObservedAtUtc: string) => ({
      mint: request.mint,
      direction,
      exactInputAmountRaw: request.exactInputAmountRaw,
      inputMint,
      outputMint,
      maxAgeMs: request.maxAgeMs,
      requestedAtUtc: new Date(
        Math.max(
          Date.parse(request.requestedAtUtc),
          Date.parse(snapshotObservedAtUtc),
          this.#now(),
        ),
      ).toISOString(),
    });
    if (phase === "PUMP_CURVE") {
      const loaded = await this.#curveState.load(
        request.mint,
        request.priority ?? (request.side === "SELL" ? "EXIT" : "CANDIDATE"),
      );
      if (loaded.status !== "SUPPORTED") return null;
      return this.#stampQuote(
        this.#curveQuotes.quote(
          makeQuoteRequest(loaded.state.snapshot.observedAtUtc),
          loaded.state,
        ),
        request,
        requestStartedAtUtc,
      );
    }
    if (phase === "MIGRATED_PUMPSWAP") {
      const loaded = await this.#swapState.load(
        request.mint,
        request.priority ?? (request.side === "SELL" ? "EXIT" : "CANDIDATE"),
      );
      if (loaded.status !== "SUPPORTED") return null;
      return this.#stampQuote(
        this.#swapQuotes.quote(
          makeQuoteRequest(loaded.state.snapshot.observedAtUtc),
          loaded.state,
        ),
        request,
        requestStartedAtUtc,
      );
    }
    return null;
  }

  #stampQuote(
    quote: QuoteResult,
    request: PaperQuoteRequest,
    requestStartedAtUtc: string,
  ): QuoteResult {
    const completedAtUtc = new Date(this.#now()).toISOString();
    return QuoteResultSchema.parse({
      ...quote,
      observedAtUtc: completedAtUtc,
      arrivalAtUtc: request.arrivalAtUtc ?? requestStartedAtUtc,
      requestStartedAtUtc,
      responseCompletedAtUtc: completedAtUtc,
    });
  }
}

function validateExecutionConfig(config: PaperExecutionConfig): void {
  if (
    !Number.isSafeInteger(config.executionLatencyMs) ||
    config.executionLatencyMs < 0 ||
    !Number.isSafeInteger(config.maxQuoteAgeMs) ||
    config.maxQuoteAgeMs < 0 ||
    !Number.isSafeInteger(config.maxIntentAgeMs) ||
    config.maxIntentAgeMs < 0 ||
    (config.manualEntryMaxAgeMs !== undefined &&
      (!Number.isSafeInteger(config.manualEntryMaxAgeMs) ||
        config.manualEntryMaxAgeMs < 1000)) ||
    (config.manualExitMaxAgeMs !== undefined &&
      (!Number.isSafeInteger(config.manualExitMaxAgeMs) ||
        config.manualExitMaxAgeMs < 1000)) ||
    !Number.isSafeInteger(config.conservativeExtraSlippageBps) ||
    config.conservativeExtraSlippageBps < 0 ||
    config.conservativeExtraSlippageBps > 10000 ||
    !/^\d+$/.test(config.modeledNetworkFeeLamports) ||
    !/^\d+$/.test(config.risk.maxTradeInputRaw) ||
    !/^\d+$/.test(config.risk.maxExposureLamports) ||
    !/^\d+$/.test(config.risk.maxDailyLossLamports) ||
    config.risk.maxOpenPositions < 1 ||
    config.risk.maxPriceImpactBps < 0 ||
    config.risk.maxSlippageBps < config.conservativeExtraSlippageBps
  )
    throw new Error("PAPER_CONFIG_INVALID");
}

function validateQuoteAtArrival(
  quote: QuoteResult,
  intent: PaperOrderIntent,
  settledAtUtc: string,
  config: PaperExecutionConfig,
): string | null {
  const inputMint = intent.side === "BUY" ? PAPER_SOL_MINT : intent.mint;
  const outputMint = intent.side === "BUY" ? intent.mint : PAPER_SOL_MINT;
  if (
    quote.validationStatus !== "PASS" ||
    quote.mint !== intent.mint ||
    quote.direction !== intent.side ||
    quote.exactInputAmountRaw !== intent.exactInputAmountRaw ||
    quote.inputMint !== inputMint ||
    quote.outputMint !== outputMint ||
    !quote.expectedOutputAmountRaw ||
    BigInt(quote.expectedOutputAmountRaw) <= 0n ||
    quote.venue === null
  )
    return "PAPER_QUOTE_CONTRACT_INVALID";
  if (
    quote.snapshotSlot === null ||
    quote.snapshotSlot <= 0 ||
    quote.snapshotAtUtc === null ||
    quote.freshnessMs === null ||
    Date.parse(quote.snapshotAtUtc) > Date.parse(settledAtUtc) ||
    Date.parse(quote.observedAtUtc) > Date.parse(settledAtUtc) ||
    (quote.responseCompletedAtUtc !== undefined &&
      (Date.parse(quote.responseCompletedAtUtc) > Date.parse(settledAtUtc) ||
        Date.parse(quote.snapshotAtUtc) >
          Date.parse(quote.responseCompletedAtUtc))) ||
    (quote.arrivalAtUtc !== undefined &&
      Date.parse(quote.arrivalAtUtc) > Date.parse(settledAtUtc)) ||
    (quote.requestStartedAtUtc !== undefined &&
      (Date.parse(quote.requestStartedAtUtc) <
        Date.parse(quote.arrivalAtUtc ?? quote.requestStartedAtUtc) ||
        Date.parse(quote.requestStartedAtUtc) >
          Date.parse(quote.responseCompletedAtUtc ?? quote.observedAtUtc))) ||
    Date.parse(settledAtUtc) - Date.parse(quote.snapshotAtUtc) >
      config.maxQuoteAgeMs ||
    quote.freshnessMs > config.maxQuoteAgeMs
  )
    return "PAPER_QUOTE_STALE_OR_UNSTAMPED";
  if (
    quote.priceImpactBps === null ||
    quote.priceImpactBps > config.risk.maxPriceImpactBps
  )
    return "PAPER_PRICE_IMPACT_LIMIT";
  if (config.conservativeExtraSlippageBps > config.risk.maxSlippageBps)
    return "PAPER_SLIPPAGE_LIMIT";
  const feeMint = intent.side === "BUY" ? quote.inputMint : quote.outputMint;
  if (quote.feeAmountRaw === null || quote.feeMint !== feeMint)
    return "PAPER_FEE_MINT_UNSUPPORTED";
  if (
    BigInt(quote.feeAmountRaw) > BigInt(quote.exactInputAmountRaw) &&
    intent.side === "BUY"
  )
    return "PAPER_FEE_EXCEEDS_INPUT";
  return null;
}

function isPaperIntentExpired(
  intent: PaperOrderIntent,
  now: number,
  automaticMaxAgeMs: number,
): boolean {
  const createdAt = Date.parse(intent.createdAtUtc);
  if (!Number.isFinite(createdAt) || createdAt > now) return true;
  if (intent.entrySource === "MANUAL") {
    const expiresAt = intent.expiresAtUtc
      ? Date.parse(intent.expiresAtUtc)
      : createdAt +
        (intent.side === "BUY" ? automaticMaxAgeMs : automaticMaxAgeMs);
    return !Number.isFinite(expiresAt) || now >= expiresAt;
  }
  return now - createdAt > automaticMaxAgeMs;
}
