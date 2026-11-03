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
  const tradeObservationReady =
    options.tradeStreamEnabled &&
    heliusTradeStream?.state === "HEALTHY" &&
    tokens.length > 0 &&
    tokens.every(
      (token) =>
        options.store.getLatestTradeObservationCoverage(token.mint)?.status ===
        "COMPLETE",
    );
  const analysisReady =
    tokens.length > 0 &&
    tokens.every(
      (token) =>
        options.store.getAnalysisOutcome(token.mint)[0]?.["status"] ===
          "COMPLETE" &&
        options.store.listRiskDecisions(token.mint, 1).length > 0,
    );
  const blockers: string[] = [];
  const discoveryReady = pumpFresh && pump?.state === "HEALTHY";
  if (!discoveryReady) blockers.push("PUMPPORTAL_DISCOVERY_NOT_HEALTHY");
  if (!options.tradeStreamEnabled) blockers.push("TRADE_STREAM_DISABLED");
  if (options.tradeStreamEnabled && heliusTradeStream?.state !== "HEALTHY")
    blockers.push("HELIUS_TRADE_STREAM_NOT_HEALTHY");
  if (!tradeObservationReady) blockers.push("TRADE_STREAM_COVERAGE_UNVERIFIED");
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
  const paperExecutionReady =
    options.mode === "PAPER" &&
    options.automaticEntriesEnabled &&
    analysisReady &&
    tradeObservationReady &&
    Boolean(helius?.state === "HEALTHY") &&
    Boolean(heliusTradeStream?.state === "HEALTHY") &&
    (paperAccount?.latestMark?.unpriceablePositions ?? 0) === 0;
  const paperRuntimeReady = options.mode === "PAPER" && paperAccount !== null;
  const walletReady = Boolean(
    paperAccount && paperAccountInit && initialBalanceMatches,
  );
  const operatorAuthReady = Boolean(options.operatorToken);
  const quoteInfrastructureReady = helius?.state === "HEALTHY";
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
  return {
    mode: options.mode,
    processHealth: true,
    discoveryReady,
    providerConnectivity: {
      pumpPortal: pump?.state === "HEALTHY" && pumpFresh,
      heliusRpc: helius?.state === "HEALTHY",
      heliusTradeStream:
        options.tradeStreamEnabled && heliusTradeStream?.state === "HEALTHY",
    },
    dataCompleteness: completeness,
    heliusRequestBudget,
    analysisReadiness: analysisReady,
    tradeObservationReady,
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
