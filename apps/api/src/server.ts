import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { PubkeySchema, utcNow } from "@sentinel/domain";
import type { AppConfig } from "@sentinel/config";
import type { SentinelStore } from "@sentinel/storage";

export type ApiOptions = {
  store: SentinelStore;
  mode: AppConfig["mode"];
  staleFeedSeconds: number;
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
    return send(response, 200, {
      ok: true,
      mode: options.mode,
      checkedAtUtc: utcNow(),
      completeness: options.store.getStreamCompleteness(),
      providers: options.store.listProviderHealth(),
      providerFrames: options.store.listProviderFrameDiagnostics(20),
    });
  }
  if (url.pathname === "/ready") {
    const providers = options.store.listProviderHealth();
    const pump = providers.find(
      (provider) => provider.provider === "pumpportal",
    );
    const checkedAtMs = pump?.checkedAtUtc
      ? Date.parse(pump.checkedAtUtc)
      : Number.NaN;
    const feedFresh =
      Number.isFinite(checkedAtMs) &&
      Date.now() - checkedAtMs <= options.staleFeedSeconds * 1000;
    const ready = pump?.state === "HEALTHY" && feedFresh;
    return send(response, ready ? 200 : 503, {
      ready,
      mode: options.mode,
      providers,
      completeness: options.store.getStreamCompleteness(),
      checkedAtUtc: utcNow(),
    });
  }
  if (url.pathname === "/api/completeness")
    return send(response, 200, options.store.getStreamCompleteness());
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

function send(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.end(JSON.stringify(value));
}
