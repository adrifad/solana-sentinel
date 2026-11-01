import { createHash } from "node:crypto";
import { loadConfig } from "@sentinel/config";
import { utcNow } from "@sentinel/domain";
import type { ProviderHealth } from "@sentinel/domain";
import {
  HeliusTradeStream,
  HeliusRpcClient,
  JupiterQuoteClient,
  PumpPortalClient,
  pumpPortalHealth,
} from "@sentinel/providers";
import { decodePumpTradeEvents } from "@sentinel/intelligence";
import { SentinelStore } from "@sentinel/storage";
import { EnrichmentScheduler } from "./enrichment.ts";
import { TokenAnalysisScheduler } from "./analysis.ts";
import { PaperRuntime } from "./paper-runtime.ts";
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

  const enrichment = new EnrichmentScheduler(
    store,
    helius,
    loaded.config.providers.helius.max_concurrent_enrichments,
  );
  enrichment.start();

  const jupiter =
    loaded.config.providers.jupiter.enabled && loaded.jupiterApiKey
      ? new JupiterQuoteClient({
          apiKey: loaded.jupiterApiKey,
          timeoutMs: loaded.config.providers.jupiter.request_timeout_ms,
          maxRequestsPerSecond:
            loaded.config.providers.jupiter.max_requests_per_second,
          consumeRequestBudget: () =>
            store.tryConsumeJupiterRequest(
              loaded.config.providers.jupiter.max_requests_per_utc_day,
            ),
        })
      : undefined;
  if (loaded.config.providers.jupiter.enabled && !loaded.jupiterApiKey)
    log("warn", "provider.jupiter.disabled", {
      errorCode: "JUPITER_API_KEY_MISSING",
    });

  const analysis = new TokenAnalysisScheduler({
    store,
    helius,
    jupiter,
    config: loaded.config,
    configVersion: loaded.configVersion,
    concurrency: loaded.config.analysis.concurrent_token_analysis,
  });
  analysis.start();

  const paper =
    loaded.config.mode === "PAPER"
      ? new PaperRuntime({
          store,
          config: loaded.config,
          configVersion: loaded.configVersion,
          ...(helius ? { helius } : {}),
        })
      : undefined;
  if (paper) await paper.start();

  const tradeStream =
    loaded.config.providers.helius.enable_trade_stream &&
    heliusApiKeyPresent(loaded.heliusApiKey)
      ? new HeliusTradeStream({
          apiKey: loaded.heliusApiKey!,
          maxActiveSubscriptions:
            loaded.config.providers.helius.max_active_trade_subscriptions,
          subscriptionDurationSeconds:
            loaded.config.providers.pumpportal.observation_window_seconds,
          consumeEventBudget: () =>
            store.tryConsumeHeliusTradeEvent(
              loaded.config.providers.helius.max_trade_events_per_day,
            ),
          onCoverage(input) {
            store.recordTradeObservationCoverage({
              mint: input.mint,
              source: "helius_logs:pump-sdk-4.1.0",
              status: input.status,
              windowStartedAtUtc: input.windowStartedAtUtc,
              windowExpiresAtUtc: input.windowExpiresAtUtc,
              lastEventAtUtc: null,
              reconnectCount: input.reconnectCount,
              reasonCode: input.reasonCode,
              updatedAtUtc: input.observedAtUtc,
            });
            if (
              input.reasonCode === "OBSERVATION_WINDOW_EXPIRED" &&
              store.requeueLatestAnalysisForMint(input.mint)
            )
              analysis.wake();
          },
          onHealth(state, errorCode, reconnectCount) {
            store.setProviderHealth({
              provider: "helius",
              state,
              checkedAtUtc: utcNow(),
              lastEventAtUtc: null,
              reconnectCount,
              errorCode,
            });
            if (errorCode) store.recordProviderIssue("helius", errorCode);
          },
          onLogs(input) {
            const decoded = decodePumpTradeEvents(input.logs).filter(
              (event) => event.mint === input.mint,
            );
            const token = store.getToken(input.mint);
            const venue =
              token?.marketPhase === "MIGRATED_PUMPSWAP"
                ? "UNKNOWN"
                : "PUMP_BONDING_CURVE";
            for (const event of decoded) {
              const eventBlockTimeMs = Number(event.timestampSeconds) * 1000;
              const blockTimeUtc =
                Number.isSafeInteger(eventBlockTimeMs) && eventBlockTimeMs > 0
                  ? new Date(eventBlockTimeMs).toISOString()
                  : null;
              const id = createHash("sha256")
                .update(`${input.signature}:${event.eventIndex}:${event.mint}`)
                .digest("hex");
              store.saveLaunchTradeObservation({
                id,
                eventIndex: event.eventIndex,
                mint: event.mint,
                signature: input.signature,
                slot: input.slot,
                blockTimeUtc,
                receivedAtUtc: input.observedAtUtc,
                side: event.side,
                traderWallet: event.traderWallet,
                tokenAmountRaw: event.tokenAmountRaw,
                quoteAmountRaw: event.quoteAmountRaw,
                venue,
                source: "helius_logs:pump-sdk-4.1.0",
                payloadRef: input.payloadRef,
              });
            }
            store.recordTradeObservationCoverage({
              mint: input.mint,
              source: "helius_logs:pump-sdk-4.1.0",
              status: "UNVERIFIED",
              windowStartedAtUtc: input.windowStartedAtUtc,
              windowExpiresAtUtc: input.windowExpiresAtUtc,
              lastEventAtUtc: input.observedAtUtc,
              reconnectCount: input.reconnectCount,
              reasonCode:
                decoded.length > 0
                  ? "TRADE_EVENT_OBSERVED_BUT_WINDOW_NOT_RECONCILED"
                  : "NO_SUPPORTED_PUMP_TRADE_EVENT_DECODED",
              updatedAtUtc: input.observedAtUtc,
            });
            if (decoded.length > 0) analysis.wake();
          },
        })
      : undefined;
  tradeStream?.start();
  if (tradeStream) {
    const observationWindowMs =
      loaded.config.providers.pumpportal.observation_window_seconds * 1000;
    for (const token of store.listTokens(200)) {
      const tokenAgeMs = Date.now() - Date.parse(token.firstSeenAtUtc);
      if (
        token.monitoringEligible &&
        Number.isFinite(tokenAgeMs) &&
        tokenAgeMs >= 0 &&
        tokenAgeMs < observationWindowMs
      )
        tradeStream.subscribeMint(token.mint);
    }
  }

  const pump = new PumpPortalClient({
    apiKey: loaded.pumpPortalApiKey,
    enableNewTokens: loaded.config.providers.pumpportal.enable_new_tokens,
    enableMigrations: loaded.config.providers.pumpportal.enable_migrations,
    eventProcessingConcurrency:
      loaded.config.providers.pumpportal.event_processing_concurrency,
    maxPendingEvents: loaded.config.providers.pumpportal.max_pending_events,
    onFrameDiagnostic(input) {
      store.recordProviderFrameDiagnostic(input);
      if (input.classification !== "PROVIDER_CONTROL")
        store.recordProviderIssue("pumpportal", input.reasonCode);
      log(
        input.classification === "PROVIDER_CONTROL" ? "info" : "warn",
        "provider.pumpportal.frame",
        {
          classification: input.classification,
          reasonCode: input.reasonCode,
        },
      );
    },
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
      if (
        event.kind === "TOKEN_CREATED" &&
        outcome.monitoringEligible &&
        tradeStream
      )
        tradeStream.subscribeMint(event.mint);
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
        await enrichment.stop();
        await analysis.stop();
        await paper?.stop();
        await tradeStream?.stop();
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

function heliusApiKeyPresent(value: string | undefined): value is string {
  return Boolean(value && value.trim());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  log("error", "worker.start_failed", { errorCode: message.slice(0, 80) });
  process.exitCode = 1;
});
