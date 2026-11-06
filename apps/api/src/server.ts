import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { PubkeySchema, paperPositionId, utcNow } from "@sentinel/domain";
import { z } from "zod";
import type { AppConfig } from "@sentinel/config";
import type { SentinelStore } from "@sentinel/storage";

export type ApiOptions = {
  store: SentinelStore;
  mode: AppConfig["mode"];
  staleFeedSeconds: number;
  tradeStreamEnabled: boolean;
  automaticEntriesEnabled: boolean;
  heliusMaxRequestsPerUtcDay?: number;
  heliusExitReservedRequestsPerUtcDay?: number;
  paperWalletId: string;
  operatorToken?: string;
  maxTradeSol?: string;
  maxQuoteAgeMs?: number;
  initialSol?: string;
  manualEntryRequestExpiryMs?: number;
  manualExitRequestExpiryMs?: number;
  minHolderSampleCoverageBps?: number;
  minIndependentBuyers?: number;
};

const EntryRequestSchema = z
  .object({
    mint: PubkeySchema,
    sizeSol: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/),
  })
  .strict()
  .refine(
    (value) => decimalLamports(value.sizeSol) > 0n,
    "sizeSol must be positive",
  );
const ExitRequestSchema = z
  .object({ positionId: z.string().min(1).max(200) })
  .strict();

export function createApiServer(options: ApiOptions): Server {
  const requestTimes = new Map<string, number[]>();
  return createServer((request, response) => {
    void handleRequest(request, response, options, requestTimes);
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ApiOptions,
  requestTimes: Map<string, number[]>,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  if (
    request.method === "POST" &&
    ["/api/paper/entry", "/api/paper/exit"].includes(url.pathname)
  ) {
    if (options.mode !== "PAPER")
      return send(response, 409, { error: "PAPER_MODE_REQUIRED" });
    if (!authorizeOperator(request, options.operatorToken))
      return send(response, options.operatorToken ? 401 : 503, {
        error: options.operatorToken
          ? "UNAUTHORIZED"
          : "PAPER_OPERATOR_AUTH_NOT_CONFIGURED",
      });
    if (!allowWrite(requestTimes, request.socket.remoteAddress ?? "unknown"))
      return send(response, 429, { error: "PAPER_REQUEST_RATE_LIMITED" });
    const idempotencyKey = request.headers["idempotency-key"];
    if (
      typeof idempotencyKey !== "string" ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 128
    )
      return send(response, 400, { error: "IDEMPOTENCY_KEY_REQUIRED" });
    const body = await readJson(request);
    if (!body.ok) return send(response, body.status, { error: body.error });
    if (url.pathname === "/api/paper/entry") {
      const parsed = EntryRequestSchema.safeParse(body.value);
      if (!parsed.success)
        return send(response, 400, { error: "INVALID_ENTRY_REQUEST" });
      const sizeLamports = decimalLamports(parsed.data.sizeSol);
      const maxTrade = decimalLamports(options.maxTradeSol ?? "0");
      if (sizeLamports > maxTrade)
        return send(response, 400, { error: "PAPER_MAX_TRADE_EXCEEDED" });
      if (!options.store.getToken(parsed.data.mint))
        return send(response, 404, { error: "TOKEN_NOT_FOUND" });
      try {
        const now = utcNow();
        const existing =
          options.store.getManualPaperRequestByIdempotencyKey(idempotencyKey);
        if (
          existing &&
          (existing.requestType !== "ENTRY" ||
            existing.walletId !== options.paperWalletId ||
            existing.mint !== parsed.data.mint ||
            existing.requestedAmountRaw !== sizeLamports.toString())
        )
          return send(response, 409, { error: "IDEMPOTENCY_KEY_CONFLICT" });
        const result =
          existing ??
          options.store.createManualPaperRequest({
            id: randomUUID(),
            idempotencyKey,
            requestType: "ENTRY",
            walletId: options.paperWalletId,
            mint: parsed.data.mint,
            requestedAmountRaw: sizeLamports.toString(),
            requestedSizeSol: parsed.data.sizeSol,
            originalCoverageStatus:
              options.store.getLatestTradeObservationCoverage(parsed.data.mint)
                ?.status ?? "UNVERIFIED",
            createdAtUtc: now,
            expiresAtUtc: new Date(
              Date.parse(now) + (options.manualEntryRequestExpiryMs ?? 5000),
            ).toISOString(),
          });
        return send(response, existing ? 200 : 202, {
          requestId: result.id,
          status: result.status,
          reasonCode: result.reasonCode,
          expiresAtUtc: result.expiresAtUtc,
        });
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "MANUAL_ENTRY_REJECTED";
        return send(response, 409, {
          error: code.includes("IDEMPOTENCY")
            ? "IDEMPOTENCY_KEY_CONFLICT"
            : "MANUAL_ENTRY_CONFLICT",
        });
      }
    }
    const parsed = ExitRequestSchema.safeParse(body.value);
    if (!parsed.success)
      return send(response, 400, { error: "INVALID_EXIT_REQUEST" });
    try {
      const prior =
        options.store.getManualPaperRequestByIdempotencyKey(idempotencyKey);
      if (prior) {
        if (
          prior.requestType !== "EXIT" ||
          prior.walletId !== options.paperWalletId ||
          prior.positionId !== parsed.data.positionId
        )
          return send(response, 409, { error: "IDEMPOTENCY_KEY_CONFLICT" });
        return send(response, 200, {
          requestId: prior.id,
          status: prior.status,
          reasonCode: prior.reasonCode,
          expiresAtUtc: prior.expiresAtUtc,
        });
      }
      const portfolio = options.store.getPaperPortfolioState(
        options.paperWalletId,
      );
      const position = portfolio.positions.find(
        (item) =>
          paperPositionId(options.paperWalletId, item.mint) ===
          parsed.data.positionId,
      );
      if (!position)
        return send(response, 404, { error: "OPEN_POSITION_NOT_FOUND" });
      const now = utcNow();
      const result = options.store.createManualPaperRequest({
        id: randomUUID(),
        idempotencyKey,
        requestType: "EXIT",
        walletId: options.paperWalletId,
        mint: position.mint,
        positionId: parsed.data.positionId,
        requestedAmountRaw: position.tokenAmountRaw,
        createdAtUtc: now,
        expiresAtUtc: new Date(
          Date.parse(now) + (options.manualExitRequestExpiryMs ?? 300000),
        ).toISOString(),
      });
      return send(response, 202, {
        requestId: result.id,
        status: result.status,
        reasonCode: result.reasonCode,
        expiresAtUtc: result.expiresAtUtc,
      });
    } catch (error) {
      const code =
        error instanceof Error ? error.message : "MANUAL_EXIT_REJECTED";
      return send(response, 409, {
        error: code.includes("IDEMPOTENCY")
          ? "IDEMPOTENCY_KEY_CONFLICT"
          : "MANUAL_EXIT_CONFLICT",
      });
    }
  }
  if (request.method !== "GET")
    return send(response, 405, { error: "METHOD_NOT_ALLOWED" });
  if (url.pathname === "/api/paper/candidates") {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      return send(response, 400, { error: "INVALID_LIMIT" });
    const tokens = options.store.listTokens(200);
    const candidates = tokens.slice(0, limit).map((token) => {
      const decision =
        options.store.listRiskDecisions(token.mint, 1)[0] ?? null;
      const coverage = options.store.getLatestTradeObservationCoverage(
        token.mint,
      );
      const behavior =
        options.store.listLaunchBehaviorSnapshots(token.mint, 1)[0] ?? null;
      const security = options.store.getLatestTokenRiskReport(token.mint);
      const analysis = options.store.getAnalysisOutcome(token.mint)[0] ?? null;
      const evaluation = options.store.getLatestPaperEntryEvaluation(
        token.mint,
      ) ?? {
        mint: token.mint,
        decisionId: decision?.id ?? null,
        decisionStatus: decision?.status ?? null,
        status: options.automaticEntriesEnabled
          ? "NOT_EVALUATED"
          : "NOT_ATTEMPTED",
        reasonCode: options.automaticEntriesEnabled
          ? "ENTRY_EVALUATION_NOT_RECORDED"
          : "AUTOMATIC_ENTRIES_DISABLED",
        reasonCodes: decision?.reasonCodes ?? [],
        evaluatedAtUtc: null,
        evaluationCount: 0,
        orderAttemptCount: 0,
        executionOrderId: null,
        orderStatus: null,
        evidence: {},
      };
      const evaluationAgeMs = evaluation.evaluatedAtUtc
        ? Date.now() - Date.parse(evaluation.evaluatedAtUtc)
        : null;
      const attemptActivity =
        evaluation.status !== "EVALUATING"
          ? evaluation.status
          : evaluationAgeMs !== null && evaluationAgeMs <= 30_000
            ? "IN_PROGRESS"
            : "STALE_EVALUATION_RECORD";
      return {
        token,
        analysis,
        decision,
        security: security
          ? {
              id: security.id,
              status: security.status,
              reasonCodes: security.reasonCodes,
              observedAtUtc: security.observedAtUtc,
              testTokenClassification: security.testTokenClassification,
            }
          : null,
        tradeCoverage: coverage,
        launchBehavior: behavior
          ? {
              id: behavior.id,
              complete: behavior.complete,
              classification: behavior.classification,
              reasonCodes: behavior.reasonCodes,
              independentBuyerEstimate: behavior.independentBuyerEstimate,
              observedAtUtc: behavior.observedAtUtc,
            }
          : null,
        entryEvaluation: {
          ...evaluation,
          activity: attemptActivity,
          ageMs: evaluationAgeMs,
        },
      };
    });
    const decisionCounts: Record<string, number> = {};
    const entryEvaluationCounts: Record<string, number> = {};
    const entryReasonCounts: Record<string, number> = {};
    for (const candidate of candidates) {
      const decisionStatus = candidate.decision?.status ?? "NO_DECISION";
      decisionCounts[decisionStatus] =
        (decisionCounts[decisionStatus] ?? 0) + 1;
      const evaluationStatus = candidate.entryEvaluation.status;
      entryEvaluationCounts[evaluationStatus] =
        (entryEvaluationCounts[evaluationStatus] ?? 0) + 1;
      const reason = candidate.entryEvaluation.reasonCode;
      if (typeof reason === "string")
        entryReasonCounts[reason] = (entryReasonCounts[reason] ?? 0) + 1;
    }
    const totalEvaluations = candidates.reduce(
      (sum, candidate) => sum + candidate.entryEvaluation.evaluationCount,
      0,
    );
    const totalOrderAttempts = candidates.reduce(
      (sum, candidate) => sum + candidate.entryEvaluation.orderAttemptCount,
      0,
    );
    return send(response, 200, {
      mode: options.mode,
      automaticEntriesEnabled: options.automaticEntriesEnabled,
      schedulerState: options.automaticEntriesEnabled ? "ENABLED" : "DISABLED",
      schedulerBlockers: options.automaticEntriesEnabled
        ? []
        : ["AUTOMATIC_ENTRIES_DISABLED"],
      totalDiscovered: options.store.getTokenCount(),
      sampleLimit: 200,
      returnedCount: candidates.length,
      monitoringEligibleInSample: tokens.filter(
        (token) => token.monitoringEligible,
      ).length,
      decisionCounts,
      entryEvaluationCounts,
      entryReasonCounts,
      currentlyEvaluatingInSample: candidates.filter(
        (candidate) => candidate.entryEvaluation.activity === "IN_PROGRESS",
      ).length,
      evaluationCountInSample: totalEvaluations,
      orderAttemptCountInSample: totalOrderAttempts,
      candidates,
      checkedAtUtc: utcNow(),
    });
  }
  if (url.pathname === "/api/paper/status") {
    if (options.mode !== "PAPER")
      return send(response, 409, { error: "PAPER_MODE_REQUIRED" });
    try {
      const portfolio = options.store.getPaperPortfolioState(
        options.paperWalletId,
      );
      const account = options.store.getPaperAccountInitialization(
        options.paperWalletId,
      );
      const maxAge = options.maxQuoteAgeMs ?? 0;
      const positions = portfolio.positions.map((position) => {
        const mark = position.latestMark;
        const monitor = options.store.getPaperPositionMonitorState(
          options.paperWalletId,
          position.mint,
        );
        const markFresh = Boolean(
          mark &&
          Date.now() - Date.parse(mark.markedAtUtc) <= maxAge &&
          monitor?.status !== "UNPRICEABLE" &&
          monitor?.status !== "EXIT_BLOCKED",
        );
        return {
          ...position,
          tokenDecimals:
            options.store.getLatestTokenRiskReport?.(position.mint)?.decimals ??
            null,
          positionId: paperPositionId(options.paperWalletId, position.mint),
          unrealizedPnlLamports: markFresh
            ? (mark?.unrealizedPnlLamports ?? null)
            : null,
          markFresh,
          monitor,
        };
      });
      const realized = portfolio.realizedPnl
        .reduce((sum, item) => sum + BigInt(item.pnlLamports), 0n)
        .toString();
      const winningTrades = portfolio.realizedPnl.filter(
        (item) => BigInt(item.pnlLamports) > 0n,
      ).length;
      const readiness = getOperationalReadiness(options);
      return send(response, 200, {
        mode: options.mode,
        walletId: options.paperWalletId,
        initialBalanceConfiguredSol: options.initialSol ?? null,
        initialBalancePersistedLamports: account?.initialSolLamports ?? null,
        initialBalanceConfigMatches: account
          ? account.initialSolLamports ===
            decimalLamports(options.initialSol ?? "0").toString()
          : false,
        solBalanceLamports: portfolio.solBalanceRaw,
        positions,
        realizedPnlLamports: realized,
        winningTrades,
        closedTradeCount: portfolio.realizedPnl.length,
        unrealizedPnlLamports:
          portfolio.latestMark &&
          portfolio.latestMark.unpriceablePositions === 0 &&
          Date.now() - Date.parse(portfolio.latestMark.markedAtUtc) <= maxAge &&
          positions.every((position) => position.markFresh)
            ? positions
                .reduce(
                  (sum, position) =>
                    sum + BigInt(position.unrealizedPnlLamports ?? "0"),
                  0n,
                )
                .toString()
            : null,
        latestMark: portfolio.latestMark,
        latestFills: options.store.listPaperFills(options.paperWalletId, 20),
        manualRequests: options.store.listManualPaperRequests(
          options.paperWalletId,
          50,
        ),
        readinessBlockers: readiness.blockers,
        paperManualEntryReady: readiness.paperManualEntryReady,
        paperManualEntryBlockers: readiness.paperManualEntryBlockers,
        paperManualExitReady: readiness.paperManualExitReady,
        paperManualExitBlockers: readiness.paperManualExitBlockers,
        paperAutomaticEntryReady: readiness.paperAutomaticEntryReady,
      });
    } catch {
      return send(response, 503, { error: "PAPER_WALLET_NOT_INITIALIZED" });
    }
  }
  if (url.pathname === "/health" || url.pathname === "/api/health") {
    const readiness = getOperationalReadiness(options);
    return send(response, 200, {
      ok: true,
      mode: options.mode,
      readiness,
      checkedAtUtc: utcNow(),
      completeness: options.store.getStreamCompleteness(),
      providers: options.store.listProviderHealth(),
      providerFrames: options.store.listProviderFrameDiagnostics(20),
    });
  }
  if (url.pathname === "/ready") {
    const readiness = getOperationalReadiness(options);
    const ready =
      readiness.processHealth &&
      readiness.providerConnectivity.pumpPortal &&
      (readiness.mode !== "PAPER" || readiness.paperExecutionReady);
    return send(response, ready ? 200 : 503, {
      ...readiness,
      ready,
      checkedAtUtc: utcNow(),
    });
  }
  if (url.pathname === "/api/completeness")
    return send(response, 200, options.store.getStreamCompleteness());
  if (url.pathname === "/api/metrics/latency")
    return send(response, 200, {
      stages: options.store.getAnalysisLatencySummary(),
      checkedAtUtc: utcNow(),
    });
  if (url.pathname === "/api/metrics/daily-summary") {
    const date = url.searchParams.get("date") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      return send(response, 400, { error: "INVALID_SUMMARY_DATE" });
    const [year, month, day] = date.split("-").map(Number);
    const localDate = new Date(Date.UTC(year!, month! - 1, day!));
    if (localDate.toISOString().slice(0, 10) !== date)
      return send(response, 400, { error: "INVALID_SUMMARY_DATE" });
    const start = new Date(localDate.getTime() - 7 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return send(response, 200, {
      dateAsiaJakarta: date,
      mode: options.mode,
      summary: options.store.getDailyTelegramSummary(
        options.paperWalletId,
        start.toISOString(),
        end.toISOString(),
      ),
      checkedAtUtc: utcNow(),
    });
  }
  if (url.pathname === "/api/tokens") {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      return send(response, 400, { error: "INVALID_LIMIT" });
    return send(response, 200, { tokens: options.store.listTokens(limit) });
  }
  const match = /^\/api\/tokens\/([^/]+)$/.exec(url.pathname);
  if (match) {
    let mint: string;
    try {
      mint = decodeURIComponent(match[1] ?? "");
    } catch {
      return send(response, 400, { error: "INVALID_MINT" });
    }
    if (!PubkeySchema.safeParse(mint).success)
      return send(response, 400, { error: "INVALID_MINT" });
    const token = options.store.getToken(mint);
    return token
      ? send(response, 200, {
          token,
          roleEvidence: options.store.listWalletRoleEvidence(mint),
          securityReport: options.store.getLatestTokenRiskReport(mint),
          decisions: options.store.listRiskDecisions(mint),
          launchBehavior: options.store.listLaunchBehaviorSnapshots(mint),
          tradeCoverage: options.store.getLatestTradeObservationCoverage(mint),
          analysisJobs: options.store.getAnalysisOutcome(mint),
          migrationRecovery: options.store.getMigrationRecoveryStatus(mint),
        })
      : send(response, 404, { error: "NOT_FOUND" });
  }
  const creatorMatch = /^\/api\/creators\/([^/]+)$/.exec(url.pathname);
  if (creatorMatch) {
    let wallet: string;
    try {
      wallet = decodeURIComponent(creatorMatch[1] ?? "");
    } catch {
      return send(response, 400, { error: "INVALID_WALLET" });
    }
    if (!PubkeySchema.safeParse(wallet).success)
      return send(response, 400, { error: "INVALID_WALLET" });
    return send(response, 200, {
      wallet,
      reputation: options.store.getCreatorReputation(wallet),
      launches: options.store.listCreatorLaunches(
        wallet,
        Number.MAX_SAFE_INTEGER,
      ),
      walletLinks: options.store.getWalletLinks(wallet),
    });
  }
  return send(response, 404, { error: "NOT_FOUND" });
}

export function getOperationalReadiness(options: ApiOptions) {
  const providers = options.store.listProviderHealth();
  const pump = providers.find((provider) => provider.provider === "pumpportal");
  const helius = providers.find((provider) => provider.provider === "helius");
  const heliusTradeStream = providers.find(
    (provider) => provider.provider === "helius_trade_stream",
  );
  const analysisScheduler = providers.find(
    (provider) => provider.provider === "analysis_scheduler",
  );
  const enrichmentScheduler = providers.find(
    (provider) => provider.provider === "enrichment_scheduler",
  );
  const paperRuntimeHealth = providers.find(
    (provider) => provider.provider === "paper_runtime",
  );
  const recentlyChecked = (provider: (typeof providers)[number] | undefined) =>
    Boolean(
      provider?.checkedAtUtc &&
      Date.now() - Date.parse(provider.checkedAtUtc) <=
        options.staleFeedSeconds * 1000,
    );
  const freshHealth = (provider: (typeof providers)[number] | undefined) =>
    provider?.state === "HEALTHY" && recentlyChecked(provider);
  const pumpFresh = Boolean(
    pump?.checkedAtUtc &&
    Date.now() - Date.parse(pump.checkedAtUtc) <=
      options.staleFeedSeconds * 1000,
  );
  const completeness = options.store.getStreamCompleteness();
  const heliusRequestBudget =
    options.heliusMaxRequestsPerUtcDay !== undefined &&
    options.heliusExitReservedRequestsPerUtcDay !== undefined
      ? options.store.getHeliusRequestBudget(
          options.heliusMaxRequestsPerUtcDay,
          options.heliusExitReservedRequestsPerUtcDay,
        )
      : null;
  const tokens = options.store.listTokens(200);
  const monitoredTokens = tokens.filter((token) => token.monitoringEligible);
  const analysisStats = options.store.getAnalysisPipelineStats?.() ?? {
    eligibleTokens: monitoredTokens.length,
    analysis: {},
    enrichment: {},
    migrationRecovery: {},
    failureReasons: [],
    latestCompletedAtUtc: null,
    oldestPendingAtUtc: null,
  };
  const tradeCoverageStats =
    options.store.getTradeObservationCoverageStats?.() ?? {
      monitoredTokens: monitoredTokens.length,
      byStatus: {},
      completeTokens: monitoredTokens.filter(
        (token) =>
          options.store.getLatestTradeObservationCoverage(token.mint)
            ?.status === "COMPLETE",
      ).length,
    };
  const analysisPending = analysisStats.analysis["PENDING"] ?? 0;
  const analysisProcessing = analysisStats.analysis["PROCESSING"] ?? 0;
  const analysisCompleted = analysisStats.analysis["COMPLETE"] ?? 0;
  const enrichmentPending = analysisStats.enrichment["PENDING"] ?? 0;
  const enrichmentProcessing = analysisStats.enrichment["PROCESSING"] ?? 0;
  const budgetDeferred = analysisStats.enrichment["DEFERRED_BUDGET"] ?? 0;
  const migrationPending = analysisStats.migrationRecovery["PENDING"] ?? 0;
  const migrationProcessing =
    analysisStats.migrationRecovery["PROCESSING"] ?? 0;
  const analysisFailures = analysisStats.failureReasons.length > 0;
  const budgetBlocked =
    budgetDeferred > 0 || heliusRequestBudget?.remaining === 0;
  const analysisSchedulerDegraded =
    analysisScheduler?.state === "DEGRADED" ||
    enrichmentScheduler?.state === "DEGRADED";
  const heliusRpcDegraded = helius?.state === "DEGRADED";
  const analysisReady =
    analysisStats.eligibleTokens > 0 &&
    helius?.state === "HEALTHY" &&
    freshHealth(analysisScheduler) &&
    freshHealth(enrichmentScheduler) &&
    analysisPending === 0 &&
    analysisProcessing === 0 &&
    enrichmentPending === 0 &&
    enrichmentProcessing === 0 &&
    migrationPending === 0 &&
    migrationProcessing === 0 &&
    analysisCompleted > 0 &&
    !budgetDeferred &&
    !analysisFailures;
  const analysisStatus =
    analysisStats.eligibleTokens === 0
      ? "BLOCKED"
      : !recentlyChecked(analysisScheduler) ||
          !recentlyChecked(enrichmentScheduler)
        ? "BLOCKED"
        : budgetBlocked ||
            analysisFailures ||
            analysisSchedulerDegraded ||
            heliusRpcDegraded
          ? "DEGRADED"
          : helius?.state !== "HEALTHY"
            ? "BLOCKED"
            : analysisPending > 0 ||
                analysisProcessing > 0 ||
                enrichmentPending > 0 ||
                enrichmentProcessing > 0 ||
                migrationPending > 0 ||
                migrationProcessing > 0
              ? "RUNNING"
              : analysisReady
                ? "READY"
                : "BLOCKED";
  const tradeObservationReady =
    options.tradeStreamEnabled &&
    heliusTradeStream?.state === "HEALTHY" &&
    tradeCoverageStats.monitoredTokens > 0 &&
    tradeCoverageStats.completeTokens === tradeCoverageStats.monitoredTokens;
  const blockers: string[] = [];
  const analysisBlockers: string[] = [];
  const discoveryReady = pumpFresh && pump?.state === "HEALTHY";
  if (!discoveryReady) blockers.push("PUMPPORTAL_DISCOVERY_NOT_HEALTHY");
  if (!options.tradeStreamEnabled) blockers.push("TRADE_STREAM_DISABLED");
  if (options.tradeStreamEnabled && heliusTradeStream?.state !== "HEALTHY")
    blockers.push("HELIUS_TRADE_STREAM_NOT_HEALTHY");
  if (!tradeObservationReady) blockers.push("TRADE_STREAM_COVERAGE_UNVERIFIED");
  if (analysisStats.eligibleTokens === 0)
    analysisBlockers.push("NO_MONITORING_ELIGIBLE_TOKENS");
  if (helius?.state !== "HEALTHY")
    analysisBlockers.push("HELIUS_RPC_NOT_HEALTHY");
  if (!recentlyChecked(analysisScheduler))
    analysisBlockers.push("ANALYSIS_SCHEDULER_NOT_HEALTHY");
  else if (analysisScheduler?.state === "DEGRADED")
    analysisBlockers.push("ANALYSIS_SCHEDULER_DEGRADED");
  if (!recentlyChecked(enrichmentScheduler))
    analysisBlockers.push("ENRICHMENT_SCHEDULER_NOT_HEALTHY");
  else if (enrichmentScheduler?.state === "DEGRADED")
    analysisBlockers.push("ENRICHMENT_SCHEDULER_DEGRADED");
  if (analysisPending > 0) analysisBlockers.push("ANALYSIS_JOBS_PENDING");
  if (analysisProcessing > 0) analysisBlockers.push("ANALYSIS_JOBS_PROCESSING");
  if (enrichmentPending > 0 || enrichmentProcessing > 0)
    analysisBlockers.push("ENRICHMENT_JOBS_PENDING");
  if (migrationPending > 0 || migrationProcessing > 0)
    analysisBlockers.push("MIGRATION_RECOVERY_PENDING");
  if (budgetBlocked) analysisBlockers.push("HELIUS_REQUEST_BUDGET_EXHAUSTED");
  if (analysisFailures) analysisBlockers.push("ANALYSIS_PROVIDER_FAILURES");
  if (!analysisReady) blockers.push("ANALYSIS_NOT_READY");
  let paperAccount: ReturnType<SentinelStore["getPaperPortfolioState"]> | null =
    null;
  if (options.mode === "PAPER") {
    try {
      paperAccount = options.store.getPaperPortfolioState(
        options.paperWalletId,
      );
    } catch {
      blockers.push("PAPER_WALLET_NOT_INITIALIZED");
    }
  }
  const paperAccountInit =
    options.mode === "PAPER"
      ? options.store.getPaperAccountInitialization?.(options.paperWalletId)
      : null;
  const initialBalanceMatches = Boolean(
    paperAccountInit &&
    paperAccountInit.initialSolLamports ===
      decimalLamports(options.initialSol ?? "0").toString(),
  );
  if (options.mode === "PAPER" && paperAccountInit && !initialBalanceMatches)
    blockers.push("PAPER_INITIAL_BALANCE_CONFIG_MISMATCH");
  const runtimeHealthFresh = freshHealth(paperRuntimeHealth);
  const paperRuntimeReady =
    options.mode === "PAPER" && paperAccount !== null && runtimeHealthFresh;
  if (options.mode === "PAPER" && !runtimeHealthFresh)
    blockers.push("PAPER_WORKER_NOT_HEALTHY");
  const paperExecutionReady =
    options.mode === "PAPER" &&
    options.automaticEntriesEnabled &&
    analysisReady &&
    tradeObservationReady &&
    !budgetBlocked &&
    Boolean(helius?.state === "HEALTHY") &&
    Boolean(heliusTradeStream?.state === "HEALTHY") &&
    paperRuntimeReady &&
    (paperAccount?.latestMark?.unpriceablePositions ?? 0) === 0;
  const walletReady = Boolean(
    paperAccount && paperAccountInit && initialBalanceMatches,
  );
  const operatorAuthReady = Boolean(options.operatorToken);
  const quoteInfrastructureReady =
    helius?.state === "HEALTHY" &&
    (heliusRequestBudget === null || heliusRequestBudget.remaining > 0);
  const manualCandidateAvailable = tokens.some((token) => {
    const decision = options.store.listRiskDecisions(token.mint, 1)[0];
    const security = options.store.getLatestTokenRiskReport?.(token.mint);
    const creatorWallet = options.store.getVerifiedCreatorWallet?.(token.mint);
    const creator = creatorWallet
      ? options.store.getCreatorReputation?.(creatorWallet)
      : null;
    const behavior = options.store.listLaunchBehaviorSnapshots?.(
      token.mint,
      1,
    )[0];
    const coverageStatus =
      options.store.getLatestTradeObservationCoverage(token.mint)?.status ??
      "UNVERIFIED";
    const minimumBuyers = options.minIndependentBuyers ?? 3;
    const observations = behavior
      ? (options.store.listLaunchTradeObservations?.(
          token.mint,
          behavior.windowStartedAtUtc,
          decision?.decidedAtUtc ?? utcNow(),
          null,
          5000,
        ) ?? [])
      : [];
    const verifiedBuyers = new Set(
      observations
        .filter(
          (item) =>
            item.validationStatus === "VERIFIED" &&
            item.side === "BUY" &&
            item.traderWallet !== null &&
            item.quoteMint === "So11111111111111111111111111111111111111112" &&
            item.venue !== "UNKNOWN",
        )
        .map((item) => item.traderWallet),
    );
    const quarantineReasonsAllowed = new Set([
      "LAUNCH_BEHAVIOR_INCOMPLETE",
      "TRADE_STREAM_COMPLETENESS_UNVERIFIED",
      "VALIDATED_HOLDER_SAMPLE_COVERAGE_POLICY_PASSED",
      "BUY_AND_SELL_QUOTES_VALIDATED",
      "INDEPENDENT_BUYER_THRESHOLD_MET",
      "CREATOR_ASSOCIATED_BUY_ACTIVITY",
    ]);
    const coverageExceptionAvailable = Boolean(
      decision?.status === "QUARANTINE" &&
      decision.reasonCodes.includes("LAUNCH_BEHAVIOR_INCOMPLETE") &&
      decision.reasonCodes.every((code) =>
        quarantineReasonsAllowed.has(code),
      ) &&
      coverageStatus !== "COMPLETE" &&
      behavior?.complete === false &&
      behavior.gapReason === "TRADE_STREAM_COMPLETENESS_UNVERIFIED",
    );
    const behaviorValid = Boolean(
      behavior &&
      verifiedBuyers.size >= minimumBuyers &&
      (behavior.complete
        ? coverageStatus === "COMPLETE"
        : coverageExceptionAvailable) &&
      !behavior.reasonCodes.some((code) =>
        [
          "POSSIBLE_WASH_TRADING_PATTERN",
          "EARLY_VOLUME_CONCENTRATION_HIGH",
          "TEST_TOKEN_METADATA_PATTERN",
          "MULTI_VENUE_WINDOW_REQUIRES_SEPARATE_ANALYSIS",
        ].includes(code),
      ),
    );
    return Boolean(
      decision &&
      (decision.status === "BUY_ELIGIBLE" ||
        (decision.status === "QUARANTINE" &&
          decision.reasonCodes.includes("LAUNCH_BEHAVIOR_INCOMPLETE") &&
          decision.reasonCodes.every((code) =>
            quarantineReasonsAllowed.has(code),
          ))) &&
      security?.status === "SUPPORTED" &&
      security.holderSampleValidated === true &&
      (security.holderSampleCoverageBps ?? -1) >=
        (options.minHolderSampleCoverageBps ?? 9500) &&
      creatorWallet !== null &&
      creatorWallet !== undefined &&
      token.creator === creatorWallet &&
      Boolean(
        options.store
          .listWalletRoleEvidence?.(token.mint)
          ?.some(
            (evidence) =>
              evidence.wallet === creatorWallet &&
              evidence.source === "PUMP_IDL_CREATE_EVENT" &&
              evidence.confidenceBps === 10000 &&
              decision.evidenceRefs.includes(
                `wallet_role_evidence:${evidence.id}`,
              ),
          ),
      ) &&
      creator?.historyComplete &&
      creator.status !== "SUSPICIOUS" &&
      creator.suspiciousIndicators.length === 0 &&
      behaviorValid,
    );
  });
  const paperManualEntryBlockers: string[] = [];
  const paperManualExitBlockers: string[] = [];
  if (options.mode !== "PAPER") {
    paperManualEntryBlockers.push("MODE_IS_NOT_PAPER");
    paperManualExitBlockers.push("MODE_IS_NOT_PAPER");
  }
  if (!walletReady) {
    paperManualEntryBlockers.push("PAPER_WALLET_NOT_INITIALIZED_OR_MISMATCHED");
    paperManualExitBlockers.push("PAPER_WALLET_NOT_INITIALIZED_OR_MISMATCHED");
  }
  if (options.mode === "PAPER" && !runtimeHealthFresh) {
    paperManualEntryBlockers.push("PAPER_WORKER_NOT_HEALTHY");
    paperManualExitBlockers.push("PAPER_WORKER_NOT_HEALTHY");
  }
  if (!operatorAuthReady) {
    paperManualEntryBlockers.push("PAPER_OPERATOR_AUTH_NOT_CONFIGURED");
    paperManualExitBlockers.push("PAPER_OPERATOR_AUTH_NOT_CONFIGURED");
  }
  if (!quoteInfrastructureReady) {
    paperManualEntryBlockers.push("QUOTE_PROVIDER_NOT_HEALTHY");
    paperManualExitBlockers.push("QUOTE_PROVIDER_NOT_HEALTHY");
  }
  if (!manualCandidateAvailable)
    paperManualEntryBlockers.push("NO_VERIFIED_MANUAL_ENTRY_CANDIDATE");
  if (!paperAccount?.positions.length)
    paperManualExitBlockers.push("NO_OPEN_POSITION");
  const paperManualEntryReady = paperManualEntryBlockers.length === 0;
  const paperManualExitReady = paperManualExitBlockers.length === 0;
  if (options.mode !== "PAPER") blockers.push("MODE_IS_NOT_PAPER");
  if (options.mode === "PAPER" && !options.automaticEntriesEnabled)
    blockers.push("AUTOMATIC_ENTRIES_DISABLED");
  if (options.mode === "PAPER" && helius?.state !== "HEALTHY")
    blockers.push("HELIUS_PROVIDER_NOT_HEALTHY");
  const automaticEntryStatus =
    options.mode !== "PAPER" || !options.automaticEntriesEnabled
      ? "DISABLED"
      : paperExecutionReady && initialBalanceMatches
        ? "RUNNING"
        : budgetBlocked || analysisSchedulerDegraded || heliusRpcDegraded
          ? "DEGRADED"
          : "BLOCKED";
  const rejectionReasons: Record<string, number> = {};
  let buyEligibleInActiveSample = 0;
  for (const token of tokens) {
    const decision = options.store.listRiskDecisions(token.mint, 1)[0];
    if (token.monitoringEligible && decision?.status === "BUY_ELIGIBLE")
      buyEligibleInActiveSample += 1;
    if (decision && decision.status !== "BUY_ELIGIBLE")
      for (const reason of decision.reasonCodes ?? [])
        rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
  }
  const automaticEntryBlockers =
    options.mode !== "PAPER"
      ? ["MODE_IS_NOT_PAPER"]
      : options.automaticEntriesEnabled
        ? [...new Set(blockers)]
        : ["AUTOMATIC_ENTRIES_DISABLED"];
  if (
    options.mode === "PAPER" &&
    options.automaticEntriesEnabled &&
    buyEligibleInActiveSample === 0
  )
    automaticEntryBlockers.push("NO_BUY_ELIGIBLE_DECISION_IN_ACTIVE_SAMPLE");
  return {
    mode: options.mode,
    processHealth: true,
    discoveryReady,
    providerConnectivity: {
      pumpPortal: pump?.state === "HEALTHY" && pumpFresh,
      heliusRpc: helius?.state === "HEALTHY",
      heliusTradeStream:
        options.tradeStreamEnabled && heliusTradeStream?.state === "HEALTHY",
      analysisScheduler: freshHealth(analysisScheduler),
      enrichmentScheduler: freshHealth(enrichmentScheduler),
      paperRuntime: options.mode === "PAPER" && runtimeHealthFresh,
    },
    dataCompleteness: completeness,
    heliusRequestBudget,
    analysisReadiness: analysisReady,
    analysisStatus,
    analysisDiagnostics: {
      eligibleTokens: analysisStats.eligibleTokens,
      pending: analysisPending,
      processing: analysisProcessing,
      complete: analysisCompleted,
      enrichment: analysisStats.enrichment,
      migrationRecovery: analysisStats.migrationRecovery,
      failureReasons: analysisStats.failureReasons,
      blockers: analysisBlockers,
      latestCompletedAtUtc: analysisStats.latestCompletedAtUtc,
      oldestPendingAtUtc: analysisStats.oldestPendingAtUtc,
    },
    tradeObservationReady,
    tradeObservationStatus: !options.tradeStreamEnabled
      ? "DISABLED"
      : tradeObservationReady
        ? "READY"
        : heliusTradeStream?.state === "HEALTHY"
          ? "DEGRADED"
          : "BLOCKED",
    tradeObservationDiagnostics: {
      monitoredTokens: tradeCoverageStats.monitoredTokens,
      completeTokens: tradeCoverageStats.completeTokens,
      byStatus: tradeCoverageStats.byStatus,
      streamHealth: heliusTradeStream?.state ?? "UNKNOWN",
      completenessReason: "HELIUS_LOGS_SUBSCRIBE_HAS_NO_REPLAY_CURSOR",
    },
    paperRuntimeReady,
    paperManualEntryReady,
    paperManualEntryBlockers,
    paperManualExitReady,
    paperManualExitBlockers,
    paperExecutionReady:
      paperExecutionReady && (paperAccountInit ? initialBalanceMatches : false),
    paperAutomaticEntryReady:
      paperExecutionReady && (paperAccountInit ? initialBalanceMatches : false),
    automaticEntriesEnabled: options.automaticEntriesEnabled,
    automaticEntryStatus,
    automaticEntryBlockers,
    buyEligibleInActiveSample,
    decisionReasonCodes: Object.entries(rejectionReasons)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10)
      .map(([reasonCode, count]) => ({ reasonCode, count })),
    paper: paperAccount
      ? {
          openPositions: paperAccount.positions.length,
          unpriceablePositions:
            paperAccount.latestMark?.unpriceablePositions ?? 0,
        }
      : null,
    blockers: [...new Set(blockers)],
  };
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.end(JSON.stringify(value));
}

function authorizeOperator(
  request: IncomingMessage,
  token: string | undefined,
): boolean {
  if (!token) return false;
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

function allowWrite(
  requestTimes: Map<string, number[]>,
  address: string,
): boolean {
  const now = Date.now();
  const prior = (requestTimes.get(address) ?? []).filter(
    (time) => now - time < 60_000,
  );
  if (prior.length >= 5) return false;
  prior.push(now);
  requestTimes.set(address, prior);
  if (requestTimes.size > 1000) {
    for (const [key, values] of requestTimes)
      if (values.every((time) => now - time >= 60_000))
        requestTimes.delete(key);
  }
  return true;
}

async function readJson(
  request: IncomingMessage,
): Promise<
  { ok: true; value: unknown } | { ok: false; status: number; error: string }
> {
  const contentType = request.headers["content-type"]
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json")
    return { ok: false, status: 415, error: "JSON_REQUIRED" };
  const declaredLength = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 8192)
    return { ok: false, status: 413, error: "REQUEST_TOO_LARGE" };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > 8192)
      return { ok: false, status: 413, error: "REQUEST_TOO_LARGE" };
    chunks.push(buffer);
  }
  try {
    return {
      ok: true,
      value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
    };
  } catch {
    return { ok: false, status: 400, error: "INVALID_JSON" };
  }
}

function decimalLamports(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  if (!/^\d+$/.test(whole) || !/^\d{0,9}$/.test(fraction)) return 0n;
  return (
    BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0") || "0")
  );
}
