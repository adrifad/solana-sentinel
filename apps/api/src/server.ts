import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { PubkeySchema, utcNow } from "@sentinel/domain";
import type { AppConfig } from "@sentinel/config";
import type { SentinelStore } from "@sentinel/storage";

export type ApiOptions = {
  store: SentinelStore;
  mode: AppConfig["mode"];
  staleFeedSeconds: number;
  tradeStreamEnabled: boolean;
  automaticEntriesEnabled: boolean;
  paperWalletId: string;
};

export function createApiServer(options: ApiOptions): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, options);
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ApiOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  if (request.method !== "GET")
    return send(response, 405, { error: "METHOD_NOT_ALLOWED" });
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
  const pumpFresh = Boolean(
    pump?.checkedAtUtc &&
    Date.now() - Date.parse(pump.checkedAtUtc) <=
      options.staleFeedSeconds * 1000,
  );
  const completeness = options.store.getStreamCompleteness();
  const tokens = options.store.listTokens(200);
  const tradeObservationReady =
    options.tradeStreamEnabled &&
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
  if (!pumpFresh || pump?.state !== "HEALTHY")
    blockers.push("PUMPPORTAL_DISCOVERY_NOT_HEALTHY");
  if (!options.tradeStreamEnabled) blockers.push("TRADE_STREAM_DISABLED");
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
  const paperExecutionReady =
    options.mode === "PAPER" &&
    options.automaticEntriesEnabled &&
    analysisReady &&
    tradeObservationReady &&
    Boolean(helius?.state === "HEALTHY") &&
    (paperAccount?.latestMark?.unpriceablePositions ?? 0) === 0;
  if (options.mode !== "PAPER") blockers.push("MODE_IS_NOT_PAPER");
  if (options.mode === "PAPER" && !options.automaticEntriesEnabled)
    blockers.push("AUTOMATIC_ENTRIES_DISABLED");
  if (options.mode === "PAPER" && helius?.state !== "HEALTHY")
    blockers.push("HELIUS_PROVIDER_NOT_HEALTHY");
  return {
    mode: options.mode,
    processHealth: true,
    providerConnectivity: {
      pumpPortal: pump?.state === "HEALTHY" && pumpFresh,
      heliusRpc: helius?.state === "HEALTHY",
      heliusTradeStream:
        options.tradeStreamEnabled && helius?.state === "HEALTHY",
    },
    dataCompleteness: completeness,
    analysisReadiness: analysisReady,
    tradeObservationReady,
    paperExecutionReady,
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
