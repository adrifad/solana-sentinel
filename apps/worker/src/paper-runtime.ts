import { createHash } from "node:crypto";
import { utcNow } from "@sentinel/domain";
import type { QuoteResult } from "@sentinel/domain";
import type { AppConfig } from "@sentinel/config";
import {
  PaperExitStrategy,
  PaperRiskManager,
  PaperTradingEngine,
  PumpVenuePaperQuoteProvider,
  paperExecutionConfigFromAppConfig,
  paperInitialBalanceLamports,
  solToLamports,
} from "@sentinel/paper";
import type { PaperQuoteProvider } from "@sentinel/paper";
import type { HeliusRpcClient } from "@sentinel/providers";
import type { SentinelStore } from "@sentinel/storage";
import { log } from "./logger.ts";

/** Runtime adapter for virtual settlement only. This package has no signer or send path. */
export class PaperRuntime {
  readonly #store: SentinelStore;
  readonly #config: AppConfig;
  readonly #walletId: string;
  readonly #configVersion: string;
  readonly #engine: PaperTradingEngine;
  readonly #quotes: PaperQuoteProvider;
  readonly #exit = new PaperExitStrategy();
  readonly #risk = new PaperRiskManager();
  #timer: ReturnType<typeof setInterval> | undefined;
  #busy = false;
  #stopping = false;

  constructor(input: {
    store: SentinelStore;
    config: AppConfig;
    configVersion: string;
    helius?: HeliusRpcClient;
    quotes?: PaperQuoteProvider;
  }) {
    this.#store = input.store;
    this.#config = input.config;
    this.#walletId = input.config.paper.wallet_id;
    this.#configVersion = input.configVersion;
    this.#quotes =
      input.quotes ??
      (input.helius
        ? new PumpVenuePaperQuoteProvider({
            helius: input.helius,
            marketPhase: (mint: string) =>
              this.#store.getToken(mint)?.marketPhase ?? "UNKNOWN",
          })
        : { quoteAtArrival: async () => null });
    this.#engine = new PaperTradingEngine({
      repository: this.#store,
      quotes: this.#quotes,
      config: paperExecutionConfigFromAppConfig(input.config),
    });
  }

  async start(): Promise<void> {
    this.#engine.initializeWallet(
      this.#walletId,
      paperInitialBalanceLamports(this.#config),
    );
    const recovered = await this.#engine.recoverPendingOrders();
    this.#syncRecoveredOrders(recovered);
    log("info", "paper.orders.recovered", { count: recovered.length });
    const activePositions = new Set(
      this.#store
        .getPaperPortfolioState(this.#walletId)
        .positions.map((position) => position.mint),
    );
    for (const monitor of this.#store.listPaperPositionMonitorStates(
      this.#walletId,
    )) {
      if (monitor.status !== "EXIT_PENDING") continue;
      if (!activePositions.has(monitor.mint)) {
        this.#saveMonitor(monitor.mint, "CLOSED", null, 0, null);
      } else {
        const retry = monitor.retryCount + 1;
        this.#saveMonitor(
          monitor.mint,
          "EXIT_BLOCKED",
          "EXIT_RECOVERY_POSITION_REMAINS",
          retry,
          this.#nextRetry(retry),
        );
      }
    }
    await this.tick();
    this.#timer = setInterval(
      () => void this.tick(),
      this.#config.paper.position_monitor_interval_ms,
    );
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    while (this.#busy) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  async tick(): Promise<void> {
    if (this.#busy || this.#stopping) return;
    this.#busy = true;
    try {
      if (this.#store.listPendingPaperOrderIntents(1).length > 0)
        this.#syncRecoveredOrders(await this.#engine.recoverPendingOrders());
      await this.#monitorPositions();
      if (this.#config.paper.automatic_entries_enabled)
        await this.#considerEntries();
    } catch (error) {
      log("error", "paper.runtime.tick_failed", {
        errorCode: error instanceof Error ? error.name : "UNKNOWN_ERROR",
      });
    } finally {
      this.#busy = false;
    }
  }

  readiness(): {
    automaticEntriesEnabled: boolean;
    openPositions: number;
    unpriceablePositions: number;
    blockers: string[];
  } {
    const portfolio = this.#store.getPaperPortfolioState(this.#walletId);
    const blockers = this.#config.paper.automatic_entries_enabled
      ? []
      : ["AUTOMATIC_ENTRIES_DISABLED"];
    if (portfolio.latestMark?.unpriceablePositions)
      blockers.push("PAPER_POSITION_UNPRICEABLE");
    return {
      automaticEntriesEnabled: this.#config.paper.automatic_entries_enabled,
      openPositions: portfolio.positions.length,
      unpriceablePositions: portfolio.latestMark?.unpriceablePositions ?? 0,
      blockers,
    };
  }

  async #monitorPositions(): Promise<void> {
    const state = this.#store.getPaperPortfolioState(this.#walletId);
    const now = Date.now();
    const observedQuotes = new Map<string, QuoteResult | null>();
    for (const position of state.positions) {
      const prior = this.#store.getPaperPositionMonitorState(
        this.#walletId,
        position.mint,
      );
      if (prior?.nextRetryAtUtc && Date.parse(prior.nextRetryAtUtc) > now) {
        observedQuotes.set(position.mint, null);
        continue;
      }
      const requestedAtUtc = utcNow();
      let quote = null;
      try {
        quote = await this.#quotes.quoteAtArrival({
          mint: position.mint,
          side: "SELL",
          exactInputAmountRaw: position.tokenAmountRaw,
          requestedAtUtc,
          maxAgeMs: this.#config.paper.max_quote_age_ms,
        });
      } catch {
        quote = null;
      }
      observedQuotes.set(position.mint, quote);
      const observedAtUtc = utcNow();
      if (!quote) {
        const retry = (prior?.retryCount ?? 0) + 1;
        this.#saveMonitor(
          position.mint,
          "UNPRICEABLE",
          "EXIT_QUOTE_UNAVAILABLE",
          retry,
          this.#nextRetry(retry),
        );
        continue;
      }
      const action = this.#exit.evaluate({
        mint: position.mint,
        costBasisLamports: position.costBasisLamports,
        positionTokenAmountRaw: position.tokenAmountRaw,
        positionOpenedAtUtc: position.openedAtUtc,
        observedAtUtc,
        sellQuote: quote,
        maxQuoteAgeMs: this.#config.paper.max_quote_age_ms,
        maxPriceImpactBps: this.#config.risk.max_price_impact_bps,
        extraSlippageBps: this.#config.paper.conservative_extra_slippage_bps,
        networkFeeLamports: this.#config.paper.modeled_network_fee_lamports,
        stopLossBps: this.#config.paper.stop_loss_bps,
        takeProfitBps: this.#config.paper.take_profit_bps,
        maxHoldSeconds: this.#config.strategy.max_hold_seconds,
      });
      if (action.action === "HOLD") {
        const unpriceable = action.reasonCode === "EXIT_QUOTE_UNVERIFIED";
        const retry = unpriceable ? (prior?.retryCount ?? 0) + 1 : 0;
        this.#saveMonitor(
          position.mint,
          unpriceable ? "EXIT_BLOCKED" : "OPEN",
          action.reasonCode,
          retry,
          unpriceable ? this.#nextRetry(retry) : null,
        );
        continue;
      }
      const attempt = (prior?.retryCount ?? 0) + 1;
      const createdAtUtc = utcNow();
      const intentKey = `paper-exit:${this.#walletId}:${position.mint}:${attempt}:${action.reasonCode}`;
      const intentId = hash(intentKey);
      this.#saveMonitor(
        position.mint,
        "EXIT_PENDING",
        action.reasonCode,
        attempt,
        null,
      );
      const result = await this.#engine.execute({
        id: intentId,
        idempotencyKey: intentKey,
        walletId: this.#walletId,
        mode: "PAPER",
        mint: position.mint,
        side: "SELL",
        exactInputAmountRaw: position.tokenAmountRaw,
        decisionId: `paper-exit:${position.mint}`,
        reasonCodes: [action.reasonCode],
        createdAtUtc,
        signalQuoteId: quote.id,
      });
      if (result.order.status === "SIMULATED_FILLED") {
        observedQuotes.delete(position.mint);
        this.#saveMonitor(position.mint, "CLOSED", null, 0, null);
        log("info", "paper.exit.filled", {
          mint: position.mint,
          reasonCode: action.reasonCode,
          orderId: result.order.id,
        });
      } else {
        const retry = attempt;
        this.#saveMonitor(
          position.mint,
          "EXIT_BLOCKED",
          result.reasonCode ?? "PAPER_EXIT_NOT_FILLED",
          retry,
          this.#nextRetry(retry),
        );
      }
    }
    await this.#engine.refreshPortfolio(this.#walletId, observedQuotes);
  }

  async #considerEntries(): Promise<void> {
    const portfolio = await this.#engine.refreshPortfolio(this.#walletId);
    const canEnter = this.#risk.canOpenRisk({
      report: portfolio,
      maxDrawdownBps: this.#config.risk.max_drawdown_bps,
      maxDailyLossLamports: paperExecutionConfigFromAppConfig(this.#config).risk
        .maxDailyLossLamports,
    });
    if (!canEnter.allowed) return;
    for (const token of this.#store.listTokens(200)) {
      const decision = this.#store.listRiskDecisions(token.mint, 1)[0];
      if (
        !decision ||
        decision.status !== "BUY_ELIGIBLE" ||
        decision.configVersion !== this.#configVersion
      )
        continue;
      const coverage = this.#store.getLatestTradeObservationCoverage(
        token.mint,
      );
      const behavior = this.#store.listLaunchBehaviorSnapshots(
        token.mint,
        1,
      )[0];
      const security = this.#store.getLatestTokenRiskReport(token.mint);
      if (
        coverage?.status !== "COMPLETE" ||
        behavior?.complete !== true ||
        behavior.mint !== token.mint ||
        Date.parse(behavior.observedAtUtc) >
          Date.parse(decision.decidedAtUtc) ||
        !decision.evidenceRefs.includes(`launch_behavior:${behavior.id}`) ||
        security?.status !== "SUPPORTED" ||
        security.id !== decision.securityReportId ||
        Date.parse(coverage.windowExpiresAtUtc) >
          Date.parse(decision.decidedAtUtc)
      )
        continue;
      if (
        Date.now() - Date.parse(decision.decidedAtUtc) >
        this.#config.strategy.max_signal_age_ms
      )
        continue;
      const amount = solToLamports(this.#config.paper.order_size_sol);
      if (
        BigInt(amount) >
        BigInt(
          paperExecutionConfigFromAppConfig(this.#config).risk.maxTradeInputRaw,
        )
      )
        continue;
      const key = `paper-entry:${decision.id}`;
      const result = await this.#engine.execute({
        id: hash(key),
        idempotencyKey: key,
        walletId: this.#walletId,
        mode: "PAPER",
        mint: token.mint,
        side: "BUY",
        exactInputAmountRaw: amount,
        decisionId: decision.id,
        reasonCodes: decision.reasonCodes,
        createdAtUtc: decision.decidedAtUtc,
        signalQuoteId: null,
      });
      log("info", "paper.entry.completed", {
        mint: token.mint,
        status: result.order.status,
        reasonCode: result.reasonCode,
      });
    }
  }

  #syncRecoveredOrders(
    results: Awaited<ReturnType<PaperTradingEngine["recoverPendingOrders"]>>,
  ): void {
    for (const result of results) {
      if (result.order.side !== "SELL") continue;
      const stillOpen = this.#store
        .getPaperPortfolioState(this.#walletId)
        .positions.some((position) => position.mint === result.order.mint);
      if (!stillOpen && result.order.status === "SIMULATED_FILLED") {
        this.#saveMonitor(result.order.mint, "CLOSED", null, 0, null);
        continue;
      }
      if (result.order.status === "PENDING") continue;
      const prior = this.#store.getPaperPositionMonitorState(
        this.#walletId,
        result.order.mint,
      );
      const retry = (prior?.retryCount ?? 0) + 1;
      this.#saveMonitor(
        result.order.mint,
        stillOpen ? "EXIT_BLOCKED" : "CLOSED",
        stillOpen ? (result.reasonCode ?? "EXIT_RECOVERY_NOT_FILLED") : null,
        stillOpen ? retry : 0,
        stillOpen ? this.#nextRetry(retry) : null,
      );
    }
  }

  #saveMonitor(
    mint: string,
    status: "OPEN" | "UNPRICEABLE" | "EXIT_BLOCKED" | "EXIT_PENDING" | "CLOSED",
    reasonCode: string | null,
    retryCount: number,
    nextRetryAtUtc: string | null,
  ): void {
    this.#store.recordPaperPositionMonitorState({
      walletId: this.#walletId,
      mint,
      status,
      reasonCode,
      retryCount,
      nextRetryAtUtc,
      updatedAtUtc: utcNow(),
    });
  }

  #nextRetry(attempt: number): string {
    const delay = Math.min(
      this.#config.paper.exit_retry_max_ms,
      this.#config.paper.exit_retry_base_ms * 2 ** Math.min(attempt - 1, 12),
    );
    return new Date(Date.now() + delay).toISOString();
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
