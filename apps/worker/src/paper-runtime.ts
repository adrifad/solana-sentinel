import { createHash } from "node:crypto";
import { paperPositionId, utcNow } from "@sentinel/domain";
import type { QuoteResult } from "@sentinel/domain";
import type { AppConfig } from "@sentinel/config";
import {
  PaperExitStrategy,
  PaperRiskManager,
  PaperTradingEngine,
  PumpVenuePaperQuoteProvider,
  paperExecutionConfigFromAppConfig,
  solToLamports,
} from "@sentinel/paper";
import type { PaperQuoteProvider } from "@sentinel/paper";
import type { HeliusRpcClient } from "@sentinel/providers";
import type { SentinelStore } from "@sentinel/storage";
import type { ManualPaperRequest } from "@sentinel/storage";
import { analyzeLaunchBehavior } from "@sentinel/intelligence";
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
  #timer: ReturnType<typeof setTimeout> | undefined;
  #manualTimer: ReturnType<typeof setInterval> | undefined;
  #healthTimer: ReturnType<typeof setInterval> | undefined;
  #busy = false;
  #entryBusy = false;
  #entryWakeQueue = new Set<string>();
  #entryFullScanPending = false;
  #entryActiveMint: string | null = null;
  #estimatedExitQuoteRequests = 0;
  #manualBusy = false;
  #stopping = false;
  #initialBalanceMatches = true;
  #runtimeHealth: "HEALTHY" | "DEGRADED" = "HEALTHY";
  #runtimeError: string | null = null;

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

  async start(): Promise<{
    recoveredOrderCount: number;
    openPositionCount: number;
  }> {
    const wallet = this.#engine.initializeWallet(
      this.#walletId,
      this.#config.paper.initial_sol,
    );
    this.#initialBalanceMatches = wallet.configuredInitialBalanceMatches;
    if (!this.#initialBalanceMatches)
      log("error", "paper.wallet.initial_balance_mismatch", {
        walletId: this.#walletId,
        configuredInitialSol: this.#config.paper.initial_sol,
        persistedInitialLamports: wallet.initialSolLamports,
        errorCode: "PAPER_INITIAL_BALANCE_CONFIG_MISMATCH",
      });
    this.#store.recoverInterruptedManualPaperRequests(utcNow());
    const recovered = await this.#engine.recoverPendingOrders(100, true);
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
    await this.wakeEntries("STARTUP_RECOVERY");
    this.#reportRuntime("HEALTHY", null);
    this.#schedulePositionMonitor(this.#nextPositionMonitorDelayMs());
    this.#manualTimer = setInterval(
      () => void this.#processManualRequest(),
      250,
    );
    this.#healthTimer = setInterval(
      () => this.#reportRuntime(this.#runtimeHealth, this.#runtimeError),
      10_000,
    );
    return {
      recoveredOrderCount: recovered.length,
      openPositionCount: this.#store.getPaperPortfolioState(this.#walletId)
        .positions.length,
    };
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#manualTimer) clearInterval(this.#manualTimer);
    if (this.#healthTimer) clearInterval(this.#healthTimer);
    while (this.#busy || this.#manualBusy || this.#entryBusy)
      await new Promise((resolve) => setTimeout(resolve, 10));
    this.#reportRuntime("STOPPED", null);
  }

  async tick(): Promise<void> {
    if (this.#busy || this.#stopping) return;
    this.#busy = true;
    try {
      if (this.#store.listPendingPaperOrderIntents(1, true).length > 0)
        this.#syncRecoveredOrders(
          await this.#engine.recoverPendingOrders(100, true),
        );
      await this.#monitorPositions();
      this.#reportRuntime("HEALTHY", null);
    } catch (error) {
      this.#reportRuntime(
        "DEGRADED",
        error instanceof Error ? error.name : "PAPER_RUNTIME_TICK_FAILED",
      );
      log("error", "paper.runtime.tick_failed", {
        errorCode: error instanceof Error ? error.name : "UNKNOWN_ERROR",
      });
    } finally {
      this.#busy = false;
    }
  }

  /** Notify the independent entry scheduler after a decision is durably saved. */
  async wakeEntries(
    trigger = "DECISION_PERSISTED",
    candidateMint?: string,
  ): Promise<void> {
    if (this.#stopping) return;
    if (!this.#config.paper.automatic_entries_enabled) {
      this.#recordEntryCandidatesAsSkipped(
        "AUTOMATIC_ENTRIES_DISABLED",
        trigger,
        candidateMint,
      );
      return;
    }
    if (this.#entryBusy) {
      if (candidateMint) {
        if (candidateMint !== this.#entryActiveMint)
          this.#entryWakeQueue.add(candidateMint);
      } else {
        this.#entryFullScanPending = true;
      }
      return;
    }
    this.#entryBusy = true;
    try {
      if (candidateMint) this.#entryWakeQueue.add(candidateMint);
      else this.#entryFullScanPending = true;
      while (
        !this.#stopping &&
        (this.#entryFullScanPending || this.#entryWakeQueue.size > 0)
      ) {
        if (this.#entryFullScanPending) {
          this.#entryFullScanPending = false;
          await this.#considerEntries();
          continue;
        }
        const [mint] = this.#entryWakeQueue;
        if (!mint) continue;
        this.#entryWakeQueue.delete(mint);
        this.#entryActiveMint = mint;
        try {
          await this.#considerEntries(mint);
        } finally {
          this.#entryActiveMint = null;
        }
      }
    } catch (error) {
      try {
        this.#recordEntriesSkipped(
          this.#store.listTokens(200),
          "ENTRY_SCHEDULER_ERROR",
          {
            trigger,
            errorCode: error instanceof Error ? error.name : "UNKNOWN_ERROR",
          },
        );
      } catch {
        // Preserve worker progress if diagnostics cannot be persisted.
      }
      log("error", "paper.entry_scheduler.failed", {
        trigger,
        errorCode: error instanceof Error ? error.name : "UNKNOWN_ERROR",
      });
    } finally {
      this.#entryBusy = false;
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
    if (!this.#initialBalanceMatches)
      blockers.push("PAPER_INITIAL_BALANCE_CONFIG_MISMATCH");
    return {
      automaticEntriesEnabled: this.#config.paper.automatic_entries_enabled,
      openPositions: portfolio.positions.length,
      unpriceablePositions: portfolio.latestMark?.unpriceablePositions ?? 0,
      blockers,
    };
  }

  #reportRuntime(
    state: "HEALTHY" | "DEGRADED" | "STOPPED",
    errorCode: string | null,
  ): void {
    if (state !== "STOPPED") {
      this.#runtimeHealth = state;
      this.#runtimeError = errorCode;
    }
    this.#store.setProviderHealth({
      provider: "paper_runtime",
      state,
      checkedAtUtc: utcNow(),
      lastEventAtUtc: null,
      reconnectCount: 0,
      errorCode,
      queueDepth:
        Number(this.#busy) + Number(this.#manualBusy) + Number(this.#entryBusy),
    });
  }

  async #monitorPositions(): Promise<void> {
    const state = this.#store.getPaperPortfolioState(this.#walletId);
    const requestsBefore = this.#getExitRequestCount();
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
    const requestsAfter = this.#getExitRequestCount();
    const observedRequests = Math.max(0, requestsAfter - requestsBefore);
    if (state.positions.length > 0 && observedRequests > 0)
      this.#estimatedExitQuoteRequests = Math.max(
        this.#estimatedExitQuoteRequests,
        Math.ceil(observedRequests / state.positions.length),
      );
  }

  #getExitRequestCount(): number {
    return this.#store.getHeliusRequestBudget(
      this.#config.providers.helius.max_requests_per_utc_day,
      this.#config.providers.helius.exit_reserved_requests_per_utc_day,
    ).exitRequestsUsed;
  }

  #entryMonitorBudgetBlocker(): {
    reasonCode: string;
    evidence: Record<string, unknown>;
  } | null {
    const portfolio = this.#store.getPaperPortfolioState(this.#walletId);
    const currentBudget = this.#store.getHeliusRequestBudget(
      this.#config.providers.helius.max_requests_per_utc_day,
      this.#config.providers.helius.exit_reserved_requests_per_utc_day,
    );
    const requestsPerPosition = Math.max(
      this.#config.paper.position_monitor_estimated_rpc_requests,
      this.#estimatedExitQuoteRequests,
    );
    const projectedPositions = portfolio.positions.length + 1;
    const requiredDailyRequests = Math.ceil(
      (projectedPositions * requestsPerPosition * 86_400_000) /
        this.#config.paper.position_monitor_max_interval_ms,
    );
    const evidence = {
      openPositions: portfolio.positions.length,
      projectedPositions,
      estimatedRpcRequestsPerPosition: requestsPerPosition,
      requiredDailyExitRequests: requiredDailyRequests,
      reservedExitRequestsPerDay: currentBudget.reservedForExits,
      remainingHeliusRequests: currentBudget.remaining,
      maximumMonitorIntervalMs:
        this.#config.paper.position_monitor_max_interval_ms,
    };
    if (requiredDailyRequests > currentBudget.reservedForExits)
      return { reasonCode: "EXIT_MONITOR_BUDGET_INSUFFICIENT", evidence };
    if (currentBudget.remaining < requestsPerPosition * projectedPositions)
      return { reasonCode: "EXIT_MONITOR_BUDGET_EXHAUSTED", evidence };
    return null;
  }

  #nextPositionMonitorDelayMs(): number {
    const base = this.#config.paper.position_monitor_interval_ms;
    const max = this.#config.paper.position_monitor_max_interval_ms;
    const openPositions = this.#store.getPaperPortfolioState(this.#walletId)
      .positions.length;
    if (openPositions === 0) return base;
    const budget = this.#store.getHeliusRequestBudget(
      this.#config.providers.helius.max_requests_per_utc_day,
      this.#config.providers.helius.exit_reserved_requests_per_utc_day,
    );
    const now = new Date();
    const nextUtcDay = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    );
    const untilBudgetResetMs = Math.max(1000, nextUtcDay - now.getTime());
    const requestsPerPosition = Math.max(
      this.#config.paper.position_monitor_estimated_rpc_requests,
      this.#estimatedExitQuoteRequests,
    );
    return computeAdaptivePositionMonitorDelayMs({
      baseIntervalMs: base,
      maxIntervalMs: max,
      openPositions,
      estimatedRpcRequestsPerPosition: requestsPerPosition,
      remainingRpcRequests: budget.remaining,
      untilBudgetResetMs,
    });
  }

  #schedulePositionMonitor(delayMs: number): void {
    if (this.#stopping) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.tick().finally(() => {
        if (!this.#stopping)
          this.#schedulePositionMonitor(this.#nextPositionMonitorDelayMs());
      });
    }, delayMs);
  }

  async #considerEntries(candidateMint?: string): Promise<void> {
    const tokens = candidateMint
      ? [this.#store.getToken(candidateMint)].filter(
          (token): token is NonNullable<typeof token> => token !== null,
        )
      : this.#store.listTokens(200).filter((token) => token.monitoringEligible);
    if (!this.#initialBalanceMatches) {
      this.#recordEntriesSkipped(
        tokens,
        "PAPER_INITIAL_BALANCE_CONFIG_MISMATCH",
      );
      return;
    }
    const portfolio = await this.#engine.refreshPortfolio(this.#walletId);
    const canEnter = this.#risk.canOpenRisk({
      report: portfolio,
      maxDrawdownBps: this.#config.risk.max_drawdown_bps,
      maxDailyLossLamports: paperExecutionConfigFromAppConfig(this.#config).risk
        .maxDailyLossLamports,
    });
    if (!canEnter.allowed) {
      this.#recordEntriesSkipped(
        tokens,
        canEnter.reasonCode ?? "PAPER_RISK_GATE_BLOCKED",
      );
      return;
    }
    for (const token of tokens) {
      if (!token.monitoringEligible) {
        this.#recordEntryEvaluation(
          token.mint,
          this.#store.listRiskDecisions(token.mint, 1)[0] ?? null,
          "SKIPPED",
          "MONITORING_LEASE_INACTIVE",
        );
        continue;
      }
      const decision = this.#store.listRiskDecisions(token.mint, 1)[0];
      if (!decision) {
        this.#recordEntryEvaluation(
          token.mint,
          null,
          "SKIPPED",
          "RISK_DECISION_NOT_FOUND",
        );
        continue;
      }
      if (decision.status !== "BUY_ELIGIBLE") {
        this.#recordEntryEvaluation(
          token.mint,
          decision,
          "SKIPPED",
          `DECISION_${decision.status}`,
          { decisionReasonCodes: decision.reasonCodes },
        );
        continue;
      }
      if (decision.configVersion !== this.#configVersion) {
        this.#recordEntryEvaluation(
          token.mint,
          decision,
          "SKIPPED",
          "DECISION_CONFIG_VERSION_MISMATCH",
          { currentConfigVersion: this.#configVersion },
        );
        continue;
      }
      const coverage = this.#store.getLatestTradeObservationCoverage(
        token.mint,
      );
      const behavior = this.#store.listLaunchBehaviorSnapshots(
        token.mint,
        1,
      )[0];
      const security = this.#store.getLatestTokenRiskReport(token.mint);
      if (coverage?.status !== "COMPLETE") {
        this.#recordEntryEvaluation(
          token.mint,
          decision,
          "SKIPPED",
          `TRADE_COVERAGE_${coverage?.status ?? "UNVERIFIED"}`,
          { coverageReasonCode: coverage?.reasonCode ?? "NO_COVERAGE_RECORD" },
        );
        continue;
      }
      if (
        behavior?.complete !== true ||
        behavior.mint !== token.mint ||
        Date.parse(behavior.observedAtUtc) >
          Date.parse(decision.decidedAtUtc) ||
        !decision.evidenceRefs.includes(`launch_behavior:${behavior.id}`)
      ) {
        this.#recordEntryEvaluation(
          token.mint,
          decision,
          "SKIPPED",
          "LAUNCH_BEHAVIOR_NOT_VALID_FOR_DECISION",
          {
            behaviorId: behavior?.id ?? null,
            behaviorComplete: behavior?.complete ?? false,
            behaviorObservedAtUtc: behavior?.observedAtUtc ?? null,
          },
        );
        continue;
      }
      if (
        security?.status !== "SUPPORTED" ||
        security.id !== decision.securityReportId
      ) {
        this.#recordEntryEvaluation(
          token.mint,
          decision,
          "SKIPPED",
          "SECURITY_REPORT_NOT_CURRENT_OR_SUPPORTED",
          { securityReportId: security?.id ?? null },
        );
        continue;
      }
      if (
        Date.parse(coverage.windowExpiresAtUtc) >
        Date.parse(decision.decidedAtUtc)
      ) {
        this.#recordEntryEvaluation(
          token.mint,
          decision,
          "SKIPPED",
          "BEHAVIOR_WINDOW_NOT_CLOSED_AT_DECISION",
          { windowExpiresAtUtc: coverage.windowExpiresAtUtc },
        );
        continue;
      }
      if (
        Date.now() - Date.parse(decision.decidedAtUtc) >
        this.#config.strategy.max_signal_age_ms
      ) {
        this.#recordEntryEvaluation(
          token.mint,
          decision,
          "SKIPPED",
          "RISK_DECISION_EXPIRED",
          { maxSignalAgeMs: this.#config.strategy.max_signal_age_ms },
        );
        continue;
      }
      const amount = solToLamports(this.#config.paper.order_size_sol);
      if (
        BigInt(amount) >
        BigInt(
          paperExecutionConfigFromAppConfig(this.#config).risk.maxTradeInputRaw,
        )
      ) {
        this.#recordEntryEvaluation(
          token.mint,
          decision,
          "SKIPPED",
          "PAPER_MAX_TRADE_EXCEEDED",
          { configuredOrderSizeSol: this.#config.paper.order_size_sol },
        );
        continue;
      }
      const monitorBudgetBlocker = this.#entryMonitorBudgetBlocker();
      if (monitorBudgetBlocker) {
        this.#recordEntryEvaluation(
          token.mint,
          decision,
          "SKIPPED",
          monitorBudgetBlocker.reasonCode,
          monitorBudgetBlocker.evidence,
        );
        continue;
      }
      const key = `paper-entry:${decision.id}`;
      const orderId = hash(key);
      this.#store.recordPaperEntryEvaluation({
        mint: token.mint,
        decisionId: decision.id,
        decisionStatus: decision.status,
        status: "EVALUATING",
        reasonCode: null,
        reasonCodes: decision.reasonCodes,
        evaluatedAtUtc: utcNow(),
        executionOrderId: orderId,
        orderStatus: "PENDING",
        orderAttempted: true,
        evidence: { trigger: "AUTOMATIC_ENTRY_EVALUATION" },
      });
      const result = await this.#engine.execute({
        id: orderId,
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
      const evaluationStatus =
        result.order.status === "SIMULATED_FILLED"
          ? "FILLED"
          : result.order.status === "UNFILLABLE"
            ? "UNFILLABLE"
            : result.order.status === "PENDING"
              ? "ORDER_SUBMITTED"
              : "REJECTED";
      this.#store.recordPaperEntryEvaluation({
        mint: token.mint,
        decisionId: decision.id,
        decisionStatus: decision.status,
        status: evaluationStatus,
        reasonCode: result.reasonCode ?? result.order.reasonCode,
        reasonCodes: decision.reasonCodes,
        evaluatedAtUtc: utcNow(),
        executionOrderId: result.order.id,
        orderStatus: result.order.status,
        evidence: {
          fillId: result.fill?.["orderId"] ?? null,
          quoteId: result.fill?.["quoteId"] ?? null,
        },
      });
    }
  }

  #recordEntryCandidatesAsSkipped(
    reasonCode: string,
    trigger: string,
    candidateMint?: string,
  ): void {
    const tokens = candidateMint
      ? [this.#store.getToken(candidateMint)].filter(
          (token): token is NonNullable<typeof token> => token !== null,
        )
      : this.#store.listTokens(200);
    this.#recordEntriesSkipped(tokens, reasonCode, { trigger });
  }

  #recordEntriesSkipped(
    tokens: ReturnType<SentinelStore["listTokens"]>,
    reasonCode: string,
    evidence: Record<string, unknown> = {},
  ): void {
    for (const token of tokens) {
      const decision = this.#store.listRiskDecisions(token.mint, 1)[0] ?? null;
      this.#recordEntryEvaluation(
        token.mint,
        decision,
        "NOT_ATTEMPTED",
        reasonCode,
        evidence,
      );
    }
  }

  #recordEntryEvaluation(
    mint: string,
    decision: ReturnType<SentinelStore["listRiskDecisions"]>[number] | null,
    status:
      | "NOT_ATTEMPTED"
      | "SKIPPED"
      | "EVALUATING"
      | "ORDER_SUBMITTED"
      | "FILLED"
      | "REJECTED"
      | "UNFILLABLE",
    reasonCode: string | null,
    evidence: Record<string, unknown> = {},
  ): void {
    this.#store.recordPaperEntryEvaluation({
      mint,
      decisionId: decision?.id ?? null,
      decisionStatus: decision?.status ?? null,
      status,
      reasonCode,
      reasonCodes: decision?.reasonCodes ?? [],
      evaluatedAtUtc: utcNow(),
      evidence: {
        automaticEntriesEnabled: this.#config.paper.automatic_entries_enabled,
        ...evidence,
      },
    });
  }

  async #processManualRequest(): Promise<void> {
    if (this.#manualBusy || this.#stopping) return;
    this.#manualBusy = true;
    let request: ManualPaperRequest | null = null;
    try {
      request = this.#store.claimManualPaperRequest(this.#walletId, utcNow());
      if (!request) return;
      const recoveredOrder = request.executionOrderId
        ? this.#store.getPaperOrder(request.executionOrderId)
        : null;
      if (recoveredOrder && recoveredOrder.status !== "PENDING") {
        const status =
          recoveredOrder.status === "SIMULATED_FILLED"
            ? "FILLED"
            : recoveredOrder.status === "UNFILLABLE"
              ? "UNFILLABLE"
              : "REJECTED";
        if (request.requestType === "EXIT" && status === "FILLED")
          this.#saveMonitor(request.mint, "CLOSED", null, 0, null);
        this.#finishManual(
          request,
          status,
          recoveredOrder.reasonCode,
          { recoveredOrderId: recoveredOrder.id },
          recoveredOrder.id,
        );
        return;
      }
      if (this.#manualRequestExpired(request, Date.now())) {
        if (recoveredOrder?.status === "PENDING")
          this.#store.rejectPaperOrder(
            recoveredOrder.id,
            "EXPIRED",
            "MANUAL_REQUEST_EXPIRED",
            utcNow(),
          );
        this.#finishManual(request, "REJECTED", "MANUAL_REQUEST_EXPIRED", {
          expiresAtUtc: request.expiresAtUtc,
          createdAtUtc: request.createdAtUtc,
        });
        return;
      }
      if (!this.#initialBalanceMatches && request.requestType === "ENTRY") {
        this.#finishManual(
          request,
          "REJECTED",
          "PAPER_INITIAL_BALANCE_CONFIG_MISMATCH",
        );
        return;
      }
      if (request.requestType === "ENTRY") await this.#manualEntry(request);
      else await this.#manualExit(request);
    } catch (error) {
      if (request) {
        const currentRequest = this.#store.getManualPaperRequest(request.id);
        const executionOrderId = currentRequest?.executionOrderId;
        const order = executionOrderId
          ? this.#store.getPaperOrder(executionOrderId)
          : null;
        if (order?.status === "PENDING")
          this.#store.rejectPaperOrder(
            order.id,
            "REJECTED",
            "MANUAL_REQUEST_PROCESSING_FAILED",
            utcNow(),
          );
        this.#finishManual(
          request,
          "REJECTED",
          error instanceof Error
            ? safeReasonCode(error.message)
            : "MANUAL_REQUEST_FAILED",
        );
      }
      log("error", "paper.manual_request.failed", {
        requestId: request?.id ?? null,
        errorCode:
          error instanceof Error
            ? safeReasonCode(error.message)
            : "UNKNOWN_ERROR",
      });
    } finally {
      this.#manualBusy = false;
    }
  }

  async #manualEntry(request: ManualPaperRequest): Promise<void> {
    if (this.#manualRequestExpired(request, Date.now())) {
      this.#finishManual(request, "REJECTED", "MANUAL_REQUEST_EXPIRED");
      return;
    }
    const eligibility = this.#manualEntryEligibility(request);
    if (!eligibility.allowed) {
      this.#finishManual(
        request,
        "REJECTED",
        eligibility.reasonCode,
        eligibility.evidence,
      );
      return;
    }
    const monitorBudgetBlocker = this.#entryMonitorBudgetBlocker();
    if (monitorBudgetBlocker) {
      this.#finishManual(
        request,
        "REJECTED",
        monitorBudgetBlocker.reasonCode,
        monitorBudgetBlocker.evidence,
      );
      return;
    }
    const pair = { reasonCode: "EXIT_QUOTE_UNAVAILABLE" as string | null };
    let transientQuoteError: string | null = null;
    const quoteProvider: PaperQuoteProvider = {
      quoteAtArrival: async (quoteRequest) => {
        if (quoteRequest.side !== "BUY") {
          try {
            return await this.#quotes.quoteAtArrival(quoteRequest);
          } catch (error) {
            transientQuoteError = retryableQuoteError(error);
            return null;
          }
        }
        let buy: QuoteResult | null;
        try {
          buy = await this.#quotes.quoteAtArrival(quoteRequest);
        } catch (error) {
          transientQuoteError = retryableQuoteError(error);
          return null;
        }
        if (
          !this.#validManualQuote(
            buy,
            quoteRequest.mint,
            "BUY",
            quoteRequest.exactInputAmountRaw,
            utcNow(),
          )
        ) {
          pair.reasonCode = "BUY_QUOTE_UNAVAILABLE";
          transientQuoteError = retryableQuoteError(buy);
          return null;
        }
        const sellAmount = buy.expectedOutputAmountRaw;
        if (!sellAmount || BigInt(sellAmount) <= 0n) return null;
        let sell: QuoteResult | null;
        try {
          sell = await this.#quotes.quoteAtArrival({
            mint: quoteRequest.mint,
            side: "SELL",
            exactInputAmountRaw: sellAmount,
            requestedAtUtc: quoteRequest.requestedAtUtc,
            ...(quoteRequest.arrivalAtUtc
              ? { arrivalAtUtc: quoteRequest.arrivalAtUtc }
              : {}),
            maxAgeMs: quoteRequest.maxAgeMs,
            priority: "CANDIDATE",
          });
        } catch (error) {
          transientQuoteError = retryableQuoteError(error);
          return null;
        }
        if (
          !this.#validManualQuote(
            sell,
            quoteRequest.mint,
            "SELL",
            sellAmount,
            utcNow(),
          ) ||
          sell.venue !== buy.venue
        ) {
          pair.reasonCode = "EXIT_QUOTE_UNAVAILABLE";
          transientQuoteError = retryableQuoteError(sell);
          return null;
        }
        this.#store.saveQuoteResult(sell);
        eligibility.evidence["sellQuoteId"] = sell.id;
        eligibility.evidence["buyQuoteId"] = buy.id;
        return buy;
      },
    };
    const engine = new PaperTradingEngine({
      repository: this.#store,
      quotes: quoteProvider,
      config: paperExecutionConfigFromAppConfig(this.#config),
    });
    const orderId = request.executionOrderId ?? manualOrderId(request);
    this.#store.synchronizePendingManualOrderExpiry(
      orderId,
      request.expiresAtUtc ??
        new Date(
          Date.parse(request.createdAtUtc) +
            this.#config.paper.manual_entry_request_expiry_ms,
        ).toISOString(),
    );
    this.#store.setManualPaperExecutionOrder(request.id, orderId);
    const result = await engine.execute({
      id: orderId,
      idempotencyKey: `${orderId}`,
      walletId: this.#walletId,
      mode: "PAPER",
      mint: request.mint,
      side: "BUY",
      exactInputAmountRaw: request.requestedAmountRaw,
      decisionId: eligibility.evidence["decisionId"] as string,
      reasonCodes: [
        "MANUAL_ENTRY",
        ...(eligibility.coverageExceptionReason
          ? ["MANUAL_COVERAGE_EXCEPTION"]
          : []),
      ],
      createdAtUtc: request.createdAtUtc,
      signalQuoteId: null,
      entrySource: "MANUAL",
      expiresAtUtc:
        request.expiresAtUtc ??
        new Date(
          Date.parse(request.createdAtUtc) +
            this.#config.paper.manual_entry_request_expiry_ms,
        ).toISOString(),
    });
    if (
      result.order.status === "EXPIRED" ||
      this.#manualRequestExpired(request, Date.now())
    ) {
      this.#finishManual(
        request,
        "REJECTED",
        "MANUAL_REQUEST_EXPIRED",
        {
          executionOrderId: orderId,
          orderStatus: result.order.status,
        },
        orderId,
      );
      return;
    }
    if (result.order.status === "SIMULATED_FILLED") {
      this.#finishManual(
        request,
        "FILLED",
        null,
        eligibility.evidence,
        orderId,
        eligibility.coverageExceptionReason,
      );
    } else {
      const reason =
        pair.reasonCode === "EXIT_QUOTE_UNAVAILABLE" &&
        result.reasonCode === "PAPER_QUOTE_UNAVAILABLE"
          ? "EXIT_QUOTE_UNAVAILABLE"
          : (result.reasonCode ?? "MANUAL_ENTRY_NOT_FILLED");
      if (transientQuoteError && request.attempts < 3) {
        this.#retryManual(request, transientQuoteError, eligibility.evidence);
      } else {
        this.#finishManual(
          request,
          result.order.status === "UNFILLABLE" ? "UNFILLABLE" : "REJECTED",
          transientQuoteError ?? reason,
          eligibility.evidence,
          orderId,
          eligibility.coverageExceptionReason,
        );
      }
    }
  }

  async #manualExit(request: ManualPaperRequest): Promise<void> {
    if (this.#manualRequestExpired(request, Date.now())) {
      this.#finishManual(request, "REJECTED", "MANUAL_REQUEST_EXPIRED");
      return;
    }
    if (request.positionId !== paperPositionId(this.#walletId, request.mint)) {
      this.#finishManual(request, "REJECTED", "OPEN_POSITION_NOT_FOUND");
      return;
    }
    const position = this.#store
      .getPaperPortfolioState(this.#walletId)
      .positions.find((item) => item.mint === request.mint);
    if (!position || position.tokenAmountRaw !== request.requestedAmountRaw) {
      this.#finishManual(request, "REJECTED", "POSITION_CHANGED_SINCE_REQUEST");
      return;
    }
    const orderId = request.executionOrderId ?? manualOrderId(request);
    this.#store.synchronizePendingManualOrderExpiry(
      orderId,
      request.expiresAtUtc ??
        new Date(
          Date.parse(request.createdAtUtc) +
            this.#config.paper.manual_exit_request_expiry_ms,
        ).toISOString(),
    );
    this.#store.setManualPaperExecutionOrder(request.id, orderId);
    let transientQuoteError: string | null = null;
    const exitQuotes: PaperQuoteProvider = {
      quoteAtArrival: async (quoteRequest) => {
        try {
          const quote = await this.#quotes.quoteAtArrival(quoteRequest);
          if (!quote) transientQuoteError = null;
          else if (quote.validationStatus !== "PASS")
            transientQuoteError = retryableQuoteError(quote);
          return quote;
        } catch (error) {
          transientQuoteError = retryableQuoteError(error);
          return null;
        }
      },
    };
    const engine = new PaperTradingEngine({
      repository: this.#store,
      quotes: exitQuotes,
      config: paperExecutionConfigFromAppConfig(this.#config),
    });
    const result = await engine.execute({
      id: orderId,
      idempotencyKey: `${orderId}`,
      walletId: this.#walletId,
      mode: "PAPER",
      mint: request.mint,
      side: "SELL",
      exactInputAmountRaw: request.requestedAmountRaw,
      decisionId: `manual-exit:${request.id}`,
      reasonCodes: ["MANUAL_EXIT"],
      createdAtUtc: request.createdAtUtc,
      signalQuoteId: null,
      entrySource: "MANUAL",
      expiresAtUtc:
        request.expiresAtUtc ??
        new Date(
          Date.parse(request.createdAtUtc) +
            this.#config.paper.manual_exit_request_expiry_ms,
        ).toISOString(),
    });
    if (
      result.order.status === "EXPIRED" ||
      this.#manualRequestExpired(request, Date.now())
    ) {
      this.#finishManual(
        request,
        "REJECTED",
        "MANUAL_REQUEST_EXPIRED",
        {
          executionOrderId: orderId,
          orderStatus: result.order.status,
        },
        orderId,
      );
      return;
    }
    if (result.order.status === "SIMULATED_FILLED") {
      this.#saveMonitor(request.mint, "CLOSED", null, 0, null);
      this.#finishManual(
        request,
        "FILLED",
        null,
        { fill: result.fill },
        orderId,
      );
    } else {
      const status =
        result.order.status === "UNFILLABLE" ? "UNFILLABLE" : "REJECTED";
      if (transientQuoteError && request.attempts < 3)
        this.#retryManual(request, transientQuoteError, { fill: null });
      else
        this.#finishManual(
          request,
          status,
          transientQuoteError ?? result.reasonCode ?? "PAPER_EXIT_NOT_FILLED",
          { fill: null },
          orderId,
        );
    }
  }

  #manualEntryEligibility(request: ManualPaperRequest): {
    allowed: boolean;
    reasonCode: string;
    evidence: Record<string, unknown>;
    coverageExceptionReason: string | null;
  } {
    const reject = (
      reasonCode: string,
      evidence: Record<string, unknown> = {},
    ) => ({
      allowed: false,
      reasonCode,
      evidence,
      coverageExceptionReason: null,
    });
    const token = this.#store.getToken(request.mint);
    if (!token) return reject("TOKEN_NOT_FOUND");
    const decision = this.#store.listRiskDecisions(request.mint, 1)[0];
    if (!decision || decision.configVersion !== this.#configVersion)
      return reject("CURRENT_RISK_DECISION_UNAVAILABLE");
    if (Date.parse(decision.decidedAtUtc) > Date.parse(request.createdAtUtc))
      return reject("RISK_DECISION_AFTER_REQUEST_TIME", {
        decisionId: decision.id,
      });
    if (
      Date.now() - Date.parse(decision.decidedAtUtc) >
      this.#config.paper.manual_entry_request_expiry_ms
    )
      return reject("RISK_DECISION_STALE", { decisionId: decision.id });
    const coverage = this.#store.getLatestTradeObservationCoverage(
      request.mint,
    );
    const coverageStatus = coverage?.status ?? "UNVERIFIED";
    const behavior = this.#store.listLaunchBehaviorSnapshots(
      request.mint,
      1,
    )[0];
    const security = this.#store.getLatestTokenRiskReport(request.mint);
    if (
      !security ||
      security.id !== decision.securityReportId ||
      security.status !== "SUPPORTED"
    )
      return reject("TOKEN_SECURITY_NOT_VERIFIED", {
        decisionId: decision.id,
        securityReportId: security?.id ?? null,
      });
    if (
      Date.parse(security.observedAtUtc) > Date.parse(request.createdAtUtc) ||
      (this.#config.security.max_snapshot_age_ms > 0 &&
        Date.now() - Date.parse(security.observedAtUtc) >
          this.#config.security.max_snapshot_age_ms)
    )
      return reject("TOKEN_SECURITY_EVIDENCE_STALE", {
        securityReportId: security.id,
      });
    if (security.testTokenClassification === "LIKELY_TEST")
      return reject("TOKEN_CLASSIFIED_LIKELY_TEST", {
        securityReportId: security.id,
      });
    if (
      (this.#config.security.reject_unsafe_mint_authority &&
        security.mintAuthority !== null) ||
      (this.#config.security.reject_unsafe_freeze_authority &&
        security.freezeAuthority !== null) ||
      security.reasonCodes.some((code) =>
        ["MINT_AUTHORITY_ACTIVE", "FREEZE_AUTHORITY_ACTIVE"].includes(code),
      )
    )
      return reject("TOKEN_SECURITY_AUTHORITY_POLICY_FAILED", {
        securityReportId: security.id,
        reasonCodes: security.reasonCodes,
      });
    const unsupportedExtension = security.extensions.find(
      (extension) =>
        extension.classification === "UNSUPPORTED" ||
        (this.#config.security.reject_untrusted_permanent_delegate &&
          extension.name === "PERMANENT_DELEGATE") ||
        (this.#config.security.reject_unsupported_transfer_hooks &&
          extension.name === "TRANSFER_HOOK"),
    );
    if (unsupportedExtension)
      return reject("TOKEN_SECURITY_EXTENSION_POLICY_FAILED", {
        securityReportId: security.id,
        extension: unsupportedExtension.name,
      });
    if (
      security.holderSampleValidated !== true ||
      (security.holderSampleCoverageBps ?? -1) <
        this.#config.analysis.min_holder_sample_coverage_bps
    )
      return reject("HOLDER_EVIDENCE_INSUFFICIENT", {
        securityReportId: security.id,
      });
    const verifiedCreator = this.#store.getVerifiedCreatorWallet(request.mint);
    if (!verifiedCreator || token.creator !== verifiedCreator)
      return reject("CREATOR_IDENTITY_UNVERIFIED", { decisionId: decision.id });
    const creatorRole = this.#store
      .listWalletRoleEvidence(request.mint)
      .find(
        (item) =>
          item.wallet === verifiedCreator &&
          item.source === "PUMP_IDL_CREATE_EVENT" &&
          item.confidenceBps === 10000,
      );
    if (
      !creatorRole ||
      Date.parse(creatorRole.observedAtUtc) > Date.parse(request.createdAtUtc)
    )
      return reject("CREATOR_ROLE_EVIDENCE_UNVERIFIED", {
        decisionId: decision.id,
      });
    if (
      !decision.evidenceRefs.includes(`wallet_role_evidence:${creatorRole.id}`)
    )
      return reject("CREATOR_ROLE_NOT_IN_RISK_EVIDENCE", {
        decisionId: decision.id,
      });
    const reputation = this.#store.getCreatorReputation(verifiedCreator);
    if (
      !reputation ||
      !reputation.historyComplete ||
      reputation.status === "SUSPICIOUS" ||
      reputation.suspiciousIndicators.length > 0 ||
      Date.parse(reputation.freshUntilUtc) <= Date.now()
    )
      return reject("CREATOR_REPUTATION_UNSAFE_OR_INCOMPLETE", {
        creator: verifiedCreator,
        evidenceRefs: reputation?.evidenceRefs ?? [],
      });
    if (Date.parse(reputation.computedAtUtc) > Date.parse(request.createdAtUtc))
      return reject("CREATOR_REPUTATION_AFTER_REQUEST_TIME", {
        creator: verifiedCreator,
      });
    if (
      !reputation.evidenceRefs.every((reference) =>
        decision.evidenceRefs.includes(reference),
      )
    )
      return reject("CREATOR_EVIDENCE_NOT_IN_RISK_DECISION", {
        decisionId: decision.id,
        evidenceRefs: reputation.evidenceRefs,
      });
    if (
      !security.evidenceRefs.every((reference) =>
        decision.evidenceRefs.includes(reference),
      )
    )
      return reject("SECURITY_EVIDENCE_NOT_IN_RISK_DECISION", {
        decisionId: decision.id,
        securityReportId: security.id,
      });

    const coverageException =
      decision.status === "QUARANTINE" &&
      decision.reasonCodes.includes("LAUNCH_BEHAVIOR_INCOMPLETE") &&
      coverageStatus !== "COMPLETE" &&
      request.originalCoverageStatus !== "COMPLETE" &&
      behavior?.complete === false &&
      behavior.gapReason === "TRADE_STREAM_COMPLETENESS_UNVERIFIED";
    if (decision.status !== "BUY_ELIGIBLE" && !coverageException)
      return reject("RISK_DECISION_NOT_MANUALLY_ELIGIBLE", {
        decisionId: decision.id,
        status: decision.status,
        reasonCodes: decision.reasonCodes,
      });
    if (
      !behavior ||
      Date.parse(behavior.observedAtUtc) > Date.parse(request.createdAtUtc)
    )
      return reject("LAUNCH_BEHAVIOR_EVIDENCE_UNAVAILABLE", {
        decisionId: decision.id,
      });
    if (!decision.evidenceRefs.includes(`launch_behavior:${behavior.id}`))
      return reject("LAUNCH_BEHAVIOR_NOT_IN_RISK_EVIDENCE", {
        decisionId: decision.id,
        behaviorId: behavior.id,
      });
    if (
      coverageException &&
      (behavior.complete ||
        behavior.gapReason !== "TRADE_STREAM_COMPLETENESS_UNVERIFIED")
    )
      return reject("COVERAGE_EXCEPTION_NOT_APPLICABLE", {
        coverageStatus,
        behaviorComplete: behavior.complete,
        gapReason: behavior.gapReason,
      });
    if (
      !coverageException &&
      (coverageStatus !== "COMPLETE" || !behavior.complete)
    )
      return reject("TRADE_OBSERVATION_COVERAGE_INCOMPLETE", {
        coverageStatus,
        behaviorId: behavior.id,
      });

    const observations = this.#store
      .listLaunchTradeObservations(
        request.mint,
        behavior.windowStartedAtUtc,
        request.createdAtUtc,
        null,
        5000,
      )
      .filter(
        (event) =>
          event.validationStatus === "VERIFIED" &&
          event.traderWallet !== null &&
          event.tokenAmountRaw !== null &&
          event.quoteAmountRaw !== null &&
          event.quoteMint === "So11111111111111111111111111111111111111112" &&
          event.venue !== "UNKNOWN" &&
          Date.parse(event.receivedAtUtc) <= Date.parse(request.createdAtUtc),
      );
    if (observations.length === 0)
      return reject("VERIFIED_LAUNCH_BEHAVIOR_MISSING", {
        decisionId: decision.id,
        behaviorId: behavior.id,
      });
    const assessed = analyzeLaunchBehavior({
      mint: request.mint,
      observations,
      creatorWallets: [verifiedCreator],
      linkedWallets: [],
      windowStartedAtUtc: behavior.windowStartedAtUtc,
      observedAtUtc: request.createdAtUtc,
      windowSeconds: behavior.windowSeconds,
      throughSlot: observations.reduce<number | null>(
        (slot, event) =>
          event.slot === null ? slot : Math.max(slot ?? 0, event.slot),
        null,
      ),
      complete: behavior.complete,
      gapReason: behavior.complete ? null : behavior.gapReason,
      minIndependentBuyers: Math.max(
        this.#config.analysis.min_independent_buyers,
        this.#config.strategy.min_independent_buyers,
      ),
      metadataLikelyTest: behavior.reasonCodes.includes(
        "TEST_TOKEN_METADATA_PATTERN",
      ),
    });
    const unsafeBehaviorReasons = [
      "POSSIBLE_WASH_TRADING_PATTERN",
      "EARLY_VOLUME_CONCENTRATION_HIGH",
      "TEST_TOKEN_METADATA_PATTERN",
      "MULTI_VENUE_WINDOW_REQUIRES_SEPARATE_ANALYSIS",
    ];
    const unsafeReason = assessed.reasonCodes.find((code) =>
      unsafeBehaviorReasons.includes(code),
    );
    if (unsafeReason)
      return reject(unsafeReason, {
        decisionId: decision.id,
        behaviorId: behavior.id,
        verifiedObservationIds: observations.map((event) => event.id),
      });
    if (
      assessed.independentBuyerEstimate <
      Math.max(
        this.#config.analysis.min_independent_buyers,
        this.#config.strategy.min_independent_buyers,
      )
    )
      return reject("LAUNCH_BEHAVIOR_BUYER_THRESHOLD_NOT_MET", {
        decisionId: decision.id,
        behaviorId: behavior.id,
        independentBuyerEstimate: assessed.independentBuyerEstimate,
        verifiedObservationIds: observations.map((event) => event.id),
      });

    const unexplainedReasons = decision.reasonCodes.filter((code) => {
      if (code === "BUY_AND_SELL_QUOTES_VALIDATED") return false;
      if (
        code === "VALIDATED_HOLDER_SAMPLE_COVERAGE_POLICY_PASSED" &&
        security.holderSampleValidated === true &&
        (security.holderSampleCoverageBps ?? -1) >=
          this.#config.analysis.min_holder_sample_coverage_bps
      )
        return false;
      if (code === "LAUNCH_BEHAVIOR_INCOMPLETE") return !coverageException;
      if (code === "TRADE_STREAM_COMPLETENESS_UNVERIFIED")
        return !coverageException;
      if (
        [
          "INDEPENDENT_BUYER_THRESHOLD_MET",
          "CREATOR_ASSOCIATED_BUY_ACTIVITY",
        ].includes(code)
      )
        return !assessed.reasonCodes.includes(code);
      if (code === "MANDATORY_CHECKS_PASSED")
        return decision.status !== "BUY_ELIGIBLE";
      return true;
    });
    if (unexplainedReasons.length > 0)
      return reject("RISK_DECISION_HAS_UNVERIFIED_REASON_CODES", {
        decisionId: decision.id,
        reasonCodes: unexplainedReasons,
        originalReasonCodes: decision.reasonCodes,
      });

    return {
      allowed: true,
      reasonCode: "MANUAL_ELIGIBILITY_PASSED",
      coverageExceptionReason: coverageException
        ? "MANUAL_ENTRY_ACCEPTED_UNVERIFIED_STREAM_COVERAGE"
        : null,
      evidence: {
        decisionId: decision.id,
        originalDecisionStatus: decision.status,
        originalDecisionReasonCodes: decision.reasonCodes,
        decisionEvidenceRefs: decision.evidenceRefs,
        securityReportId: security.id,
        securityReasonCodes: security.reasonCodes,
        securityEvidenceRefs: security.evidenceRefs,
        creator: verifiedCreator,
        creatorEvidenceRefs: reputation.evidenceRefs,
        behaviorId: behavior.id,
        behaviorEvidenceRefs: assessed.evidenceRefs,
        independentBuyerEstimate: assessed.independentBuyerEstimate,
        coverageStatus,
        coverageStatusAtRequest: request.originalCoverageStatus,
        coverageReasonCode: coverage?.reasonCode ?? "NO_COVERAGE_RECORD",
        coverageException: coverageException
          ? "MANUAL_ENTRY_ACCEPTED_UNVERIFIED_STREAM_COVERAGE"
          : null,
        verifiedObservationIds: observations.map((event) => event.id),
      },
    };
  }

  #validManualQuote(
    quote: QuoteResult | null,
    mint: string,
    side: "BUY" | "SELL",
    amount: string,
    settledAtUtc: string,
  ): quote is QuoteResult {
    if (
      !quote ||
      !["PUMP_BONDING_CURVE", "PUMPSWAP"].includes(quote.venue ?? "")
    )
      return false;
    const reason = this.#risk.validateQuote(
      quote,
      {
        id: "manual-quote-validation",
        idempotencyKey: "manual-quote-validation",
        walletId: this.#walletId,
        mode: "PAPER",
        mint,
        side,
        exactInputAmountRaw: amount,
        decisionId: "manual-quote-validation",
        reasonCodes: [],
        createdAtUtc: settledAtUtc,
        signalQuoteId: null,
        entrySource: "MANUAL",
      },
      settledAtUtc,
      paperExecutionConfigFromAppConfig(this.#config),
    );
    return reason === null;
  }

  #manualRequestExpired(request: ManualPaperRequest, nowMs: number): boolean {
    const createdAtMs = Date.parse(request.createdAtUtc);
    const expiresAtMs = request.expiresAtUtc
      ? Date.parse(request.expiresAtUtc)
      : createdAtMs +
        (request.requestType === "ENTRY"
          ? this.#config.paper.manual_entry_request_expiry_ms
          : this.#config.paper.manual_exit_request_expiry_ms);
    return (
      !Number.isFinite(createdAtMs) ||
      !Number.isFinite(expiresAtMs) ||
      createdAtMs > nowMs ||
      nowMs >= expiresAtMs
    );
  }

  #finishManual(
    request: ManualPaperRequest,
    status: "FILLED" | "REJECTED" | "UNFILLABLE",
    reasonCode: string | null,
    evidence: Record<string, unknown> = {},
    executionOrderId: string | null = null,
    coverageExceptionReason: string | null = null,
  ): void {
    this.#store.finishManualPaperRequest({
      id: request.id,
      status,
      reasonCode,
      evidence,
      executionOrderId,
      coverageExceptionReason,
      completedAtUtc: utcNow(),
    });
    log(
      status === "FILLED" ? "info" : "warn",
      "paper.manual_request.completed",
      {
        requestId: request.id,
        requestType: request.requestType,
        mint: request.mint,
        status,
        reasonCode,
        executionOrderId,
        entrySource: "MANUAL",
      },
    );
  }

  #retryManual(
    request: ManualPaperRequest,
    reasonCode: string,
    evidence: Record<string, unknown>,
  ): void {
    const nextAttemptAtUtc = this.#nextRetry(request.attempts);
    this.#store.finishManualPaperRequest({
      id: request.id,
      status: "PENDING",
      reasonCode,
      evidence,
      resetExecutionOrder: true,
      nextAttemptAtUtc,
      completedAtUtc: null,
    });
    log("warn", "paper.manual_request.retry_scheduled", {
      requestId: request.id,
      requestType: request.requestType,
      attempt: request.attempts,
      nextAttemptAtUtc,
      reasonCode,
    });
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

/**
 * Smooth exit polling across the remaining daily provider budget. This is a
 * scheduling estimate, not a guarantee that an exit will execute in time.
 */
export function computeAdaptivePositionMonitorDelayMs(input: {
  baseIntervalMs: number;
  maxIntervalMs: number;
  openPositions: number;
  estimatedRpcRequestsPerPosition: number;
  remainingRpcRequests: number;
  untilBudgetResetMs: number;
}): number {
  if (input.openPositions <= 0) return input.baseIntervalMs;
  if (input.remainingRpcRequests <= 0) return input.maxIntervalMs;
  const estimatedCycleRequests =
    input.openPositions * input.estimatedRpcRequestsPerPosition;
  const budgetCadenceMs = Math.ceil(
    (estimatedCycleRequests * input.untilBudgetResetMs) /
      input.remainingRpcRequests,
  );
  return Math.min(
    input.maxIntervalMs,
    Math.max(input.baseIntervalMs, budgetCadenceMs),
  );
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function manualOrderId(request: ManualPaperRequest): string {
  return hash(`manual-paper-order:${request.id}:${request.attempts}`);
}

function retryableQuoteError(value: unknown): string | null {
  const allowed = [
    "QUOTE_TIMEOUT",
    "PROVIDER_UNAVAILABLE",
    "RATE_LIMITED",
    "PROVIDER_BUDGET_EXHAUSTED",
  ];
  const code =
    value && typeof value === "object" && "failureReason" in value
      ? String(value.failureReason)
      : value instanceof Error
        ? value.message.toUpperCase()
        : "";
  return (
    allowed.find((candidate) =>
      new RegExp(`(?:^|[^A-Z0-9_])${candidate}(?:$|[^A-Z0-9_])`).test(code),
    ) ?? null
  );
}

function safeReasonCode(value: string): string {
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .slice(0, 80);
  return normalized || "MANUAL_REQUEST_FAILED";
}
