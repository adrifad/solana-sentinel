import { loadConfig } from "@sentinel/config";
import { utcNow } from "@sentinel/domain";
import type { ProviderHealth } from "@sentinel/domain";
import {
  HeliusRpcClient,
  PumpPortalClient,
  pumpPortalHealth,
} from "@sentinel/providers";
import { SentinelStore } from "@sentinel/storage";
import { EnrichmentScheduler } from "./enrichment.ts";
import { TokenAnalysisScheduler } from "./analysis.ts";
import { log } from "./logger.ts";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  const loaded = await loadConfig();
  const store = new SentinelStore(loaded.dbPath);
  await store.open();

  if (command === "migrate") {
    log("info", "database.migrated", { dbPath: loaded.dbPath });
    store.close();
    return;
  }
  if (command === "health") {
    const providers = store.listProviderHealth();
    process.stdout.write(
      `${JSON.stringify({ mode: loaded.config.mode, eventCount: store.eventCount(), providers }, null, 2)}\n`,
    );
    store.close();
    return;
  }
  if (command === "tokens") {
    process.stdout.write(`${JSON.stringify(store.listTokens(), null, 2)}\n`);
    store.close();
    return;
  }
  if (command !== "start") {
    process.stdout.write("Usage: sentinel <start|health|tokens|migrate>\n");
    store.close();
    return;
  }
  if (
    !loaded.config.providers.pumpportal.enable_new_tokens &&
    !loaded.config.providers.pumpportal.enable_migrations
  ) {
    store.close();
    throw new Error("At least one PumpPortal discovery feed must be enabled");
  }
  if (!loaded.pumpPortalApiKey) {
    store.close();
    throw new Error(
      "PUMPPORTAL_API_KEY is required for worker start; no feed was started",
    );
  }

  let helius: HeliusRpcClient | undefined;
  let heliusState: ProviderHealth["state"] = loaded.heliusApiKey
    ? "STARTING"
    : "DISABLED";
  let heliusError: string | null = null;
  if (loaded.heliusApiKey) {
    helius = new HeliusRpcClient({
      apiKey: loaded.heliusApiKey,
      requestTimeoutMs: loaded.config.providers.helius.request_timeout_ms,
      maxRequestsPerSecond:
        loaded.config.providers.helius.max_requests_per_second,
      consumeRequestBudget: () =>
        store.tryConsumeHeliusRequest(
          loaded.config.providers.helius.max_requests_per_utc_day,
        ),
    });
    const health = await helius.getHealth();
    heliusState = health.ok ? "HEALTHY" : "DEGRADED";
    heliusError = health.errorCode;
    log(health.ok ? "info" : "warn", "provider.helius.health", {
      ok: health.ok,
      errorCode: health.errorCode,
    });
  }
  store.setProviderHealth({
    provider: "helius",
    state: heliusState,
    checkedAtUtc: utcNow(),
    lastEventAtUtc: null,
    reconnectCount: 0,
    errorCode: heliusError,
  });

  const enrichment = helius
    ? new EnrichmentScheduler(
        store,
        helius,
        loaded.config.providers.helius.max_concurrent_enrichments,
      )
    : undefined;
  enrichment?.start();

  const analysis = new TokenAnalysisScheduler({
    store,
    helius,
    config: loaded.config,
    configVersion: loaded.configVersion,
    concurrency: loaded.config.analysis.concurrent_token_analysis,
  });
  analysis.start();

  const pump = new PumpPortalClient({
    apiKey: loaded.pumpPortalApiKey,
    enableNewTokens: loaded.config.providers.pumpportal.enable_new_tokens,
    enableMigrations: loaded.config.providers.pumpportal.enable_migrations,
    eventProcessingConcurrency:
      loaded.config.providers.pumpportal.event_processing_concurrency,
    maxPendingEvents: loaded.config.providers.pumpportal.max_pending_events,
    onHealth(
      state,
      reconnectCount,
      errorCode,
      lastEventAtUtc,
      queueDepth,
      lastProcessedAtUtc,
    ) {
      const health = pumpPortalHealth(
        state,
        reconnectCount,
        errorCode,
        lastEventAtUtc,
        queueDepth,
        lastProcessedAtUtc ?? null,
      );
      store.setProviderHealth(health);
      if (state === "DEGRADED" && errorCode)
        store.recordProviderIssue("pumpportal", errorCode);
      if (health.connectionState === "DISCONNECTED")
        store.recordStreamDisconnect(errorCode ?? "SOCKET_DISCONNECTED");
      if (state === "HEALTHY" && reconnectCount > 0)
        store.recordStreamReconnect();
      log(state === "DEGRADED" ? "warn" : "info", "provider.pumpportal.state", {
        state,
        reconnectCount,
        errorCode,
      });
    },
    persistEvent(event) {
      const outcome = store.ingestEvent(
        event,
        loaded.config.providers.pumpportal.max_monitored_tokens,
        Boolean(helius),
      );
      log(
        "info",
        outcome.inserted ? "token.event.persisted" : "token.event.duplicate",
        {
          kind: event.kind,
          mint: event.mint,
          slot: event.slot ?? null,
          monitoringEligible: outcome.monitoringEligible,
          ingestionLatencyMs: outcome.ingestionLatencyMs,
        },
      );
    },
    async onEvent() {
      enrichment?.wake();
      analysis.wake();
    },
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      let pumpStopError: unknown;
      try {
        try {
          await pump.stop();
        } catch (error) {
          pumpStopError = error;
        }
        await enrichment?.stop();
        await analysis.stop();
        if (pumpStopError) throw pumpStopError;
      } finally {
        store.close();
        log("info", "worker.stopped");
      }
    })();
    return shutdownPromise;
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  log("info", "worker.started", {
    mode: loaded.config.mode,
    configVersion: loaded.configVersion,
    database: loaded.dbPath,
  });
  try {
    await pump.start();
  } finally {
    await shutdown();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  log("error", "worker.start_failed", { errorCode: message.slice(0, 80) });
  process.exitCode = 1;
});
