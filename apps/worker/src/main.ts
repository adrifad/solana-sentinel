import { createHash, randomUUID } from "node:crypto";
import { isTelegramConfigured, loadConfig } from "@sentinel/config";
import { utcNow } from "@sentinel/domain";
import type { ProviderHealth } from "@sentinel/domain";
import {
  HeliusTradeStream,
  HeliusRpcClient,
  JupiterQuoteClient,
  PumpPortalClient,
  PumpSwapStateLoader,
  pumpPortalHealth,
} from "@sentinel/providers";
import {
  decodePumpSwapTradeEvents,
  validateTradeTransaction,
} from "@sentinel/intelligence";
import { SentinelStore } from "@sentinel/storage";
import { EnrichmentScheduler } from "./enrichment.ts";
import { TokenAnalysisScheduler } from "./analysis.ts";
import { PaperRuntime } from "./paper-runtime.ts";
import { BoundedTradeVerificationQueue } from "./trade-verification.ts";
import { log } from "./logger.ts";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  const loaded = await loadConfig();
  const store = new SentinelStore(loaded.dbPath, {
    telegramEnabled: isTelegramConfigured(process.env),
  });
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
      consumeRequestBudget: ({ priority }) =>
        store.tryConsumeHeliusRequest(
          loaded.config.providers.helius.max_requests_per_utc_day,
          loaded.config.providers.helius.exit_reserved_requests_per_utc_day,
          priority,
        ),
      recordRequestOutcome: (request) =>
        store.recordHeliusRequestOutcome(request),
    });
    const health = await helius.getHealth();
    heliusState = health.ok ? "HEALTHY" : "DEGRADED";
    heliusError = health.errorCode;
    const budget = store.getHeliusRequestBudget(
      loaded.config.providers.helius.max_requests_per_utc_day,
      loaded.config.providers.helius.exit_reserved_requests_per_utc_day,
    );
    log(health.ok ? "info" : "warn", "provider.helius.health", {
      ok: health.ok,
      errorCode: health.errorCode,
      internalRequestBudgetUsed: budget.used,
      internalRequestBudgetRemaining: budget.remaining,
      reservedForExitRequests: budget.reservedForExits,
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

  const paper =
    loaded.config.mode === "PAPER"
      ? new PaperRuntime({
          store,
          config: loaded.config,
          configVersion: loaded.configVersion,
          ...(helius ? { helius } : {}),
        })
      : undefined;
  const paperRecovery = paper ? await paper.start() : null;
  if (isTelegramConfigured(process.env))
    store.enqueueTelegramNotification({
      eventType: "WORKER_RESTART",
      dedupeKey: `worker-start:${randomUUID()}`,
      payload: {
        mode: loaded.config.mode,
        recoveredPaperOrders: paperRecovery?.recoveredOrderCount ?? 0,
        openPositions: paperRecovery?.openPositionCount ?? 0,
        observedAtUtc: utcNow(),
      },
    });

  const analysis = new TokenAnalysisScheduler({
    store,
    helius,
    jupiter,
    config: loaded.config,
    configVersion: loaded.configVersion,
    concurrency: loaded.config.analysis.concurrent_token_analysis,
    onDecisionPersisted: (decision) => {
      if (paper) void paper.wakeEntries("DECISION_PERSISTED", decision.mint);
    },
  });
  analysis.start();

  const tradeCoverageSource = "helius_logs:pump-sdk-4.1.0+pump-swap-sdk-2.1.0";
  const pumpSwapStateLoader = helius
    ? new PumpSwapStateLoader({ helius })
    : undefined;
  const pumpSwapIdentityByMint = new Map<
    string,
    { poolAddress: string; baseMint: string; quoteMint: string }
  >();
  const tradeVerifier =
    loaded.config.providers.helius.enable_trade_stream && helius
      ? new BoundedTradeVerificationQueue({
          maxPending:
            loaded.config.providers.helius.max_pending_trade_verifications,
          concurrency:
            loaded.config.providers.helius.trade_verification_concurrency,
          async process(input) {
            const transaction = await helius!.getTransaction(input.signature);
            let pumpSwapPools:
              Map<string, { baseMint: string; quoteMint: string }> | undefined;
            if (
              transaction &&
              decodePumpSwapTradeEvents(transaction.logMessages).length > 0
            ) {
              let identity = pumpSwapIdentityByMint.get(input.mint);
              if (!identity && pumpSwapStateLoader) {
                const state = await pumpSwapStateLoader.load(input.mint);
                if (state.status === "SUPPORTED") {
                  identity = {
                    poolAddress: state.poolAddress,
                    baseMint: state.state.pool.baseMint.toBase58(),
                    quoteMint: state.state.pool.quoteMint.toBase58(),
                  };
                  pumpSwapIdentityByMint.set(input.mint, identity);
                }
              }
              if (identity)
                pumpSwapPools = new Map([[identity.poolAddress, identity]]);
            }
            const validated = validateTradeTransaction({
              mint: input.mint,
              signature: input.signature,
              providerSlot: input.slot,
              receivedAtUtc: input.observedAtUtc,
              transaction,
              ...(pumpSwapPools ? { pumpSwapPools } : {}),
            });
            if (validated.status !== "VERIFIED") {
              store.recordTradeObservationCoverage({
                mint: input.mint,
                source: tradeCoverageSource,
                status: "UNVERIFIED",
                windowStartedAtUtc: input.windowStartedAtUtc,
                windowExpiresAtUtc: input.windowExpiresAtUtc,
                lastEventAtUtc: input.observedAtUtc,
                reconnectCount: input.reconnectCount,
                reasonCode: validated.reasonCode ?? "TRADE_VALIDATION_UNKNOWN",
                updatedAtUtc: utcNow(),
              });
              return;
            }
            const transactionPayloadRef = `sha256:${createHash("sha256")
              .update(
                JSON.stringify({
                  signature: transaction?.signature,
                  slot: transaction?.slot,
                  logs: transaction?.logMessages,
                }),
              )
              .digest("hex")}`;
            for (const event of validated.observations) {
              const id = createHash("sha256")
                .update(`${event.signature}:${event.eventIndex}:${event.mint}`)
                .digest("hex");
              store.saveLaunchTradeObservation({
                id,
                eventIndex: event.eventIndex,
                mint: event.mint,
                signature: event.signature,
                slot: event.slot,
                blockTimeUtc: event.blockTimeUtc,
                eventTimeUtc: event.eventTimeUtc,
                eventTimeSource:
                  event.venue === "PUMPSWAP"
                    ? "PUMPSWAP_TRADE_EVENT_TIMESTAMP"
                    : "PUMP_TRADE_EVENT_TIMESTAMP",
                receivedAtUtc: event.receivedAtUtc,
                ingestedAtUtc: utcNow(),
                side: event.side,
                traderWallet: event.traderWallet,
                tokenAmountRaw: event.tokenAmountRaw,
                quoteAmountRaw: event.quoteAmountRaw,
                quoteMint: event.quoteMint,
                venue: event.venue,
                source: event.source,
                decoderVersion: event.decoderVersion,
                validationStatus: "VERIFIED",
                validationConfidenceBps: event.validationConfidenceBps,
                payloadRef: transactionPayloadRef,
              });
            }
            store.recordTradeObservationCoverage({
              mint: input.mint,
              source: tradeCoverageSource,
              status: "UNVERIFIED",
              windowStartedAtUtc: input.windowStartedAtUtc,
              windowExpiresAtUtc: input.windowExpiresAtUtc,
              lastEventAtUtc: input.observedAtUtc,
              reconnectCount: input.reconnectCount,
              reasonCode: "TRADE_EVENTS_VALIDATED_WINDOW_NOT_RECONCILED",
              updatedAtUtc: utcNow(),
            });
            analysis.wake();
          },
          onFailure(input, error) {
            const code =
              error && typeof error === "object" && "code" in error
                ? String(error.code)
                : "TRADE_TRANSACTION_VALIDATION_FAILED";
            store.recordTradeObservationCoverage({
              mint: input.mint,
              source: tradeCoverageSource,
              status: "GAP_DETECTED",
              windowStartedAtUtc: input.windowStartedAtUtc,
              windowExpiresAtUtc: input.windowExpiresAtUtc,
              lastEventAtUtc: input.observedAtUtc,
              reconnectCount: input.reconnectCount,
              reasonCode: code,
              updatedAtUtc: utcNow(),
            });
            store.recordProviderIssue("helius", code);
          },
        })
      : undefined;

  const tradeStream =
    loaded.config.providers.helius.enable_trade_stream &&
    heliusApiKeyPresent(loaded.heliusApiKey) &&
    tradeVerifier
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
              source: tradeCoverageSource,
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
              provider: "helius_trade_stream",
              state,
              checkedAtUtc: utcNow(),
              lastEventAtUtc: null,
              reconnectCount,
              errorCode,
            });
            if (errorCode) store.recordProviderIssue("helius", errorCode);
          },
          onLogs(input) {
            const outcome = tradeVerifier?.enqueue(input) ?? "STOPPED";
            if (outcome === "DUPLICATE") return;
            store.recordTradeObservationCoverage({
              mint: input.mint,
              source: tradeCoverageSource,
              status: outcome === "ACCEPTED" ? "UNVERIFIED" : "GAP_DETECTED",
              windowStartedAtUtc: input.windowStartedAtUtc,
              windowExpiresAtUtc: input.windowExpiresAtUtc,
              lastEventAtUtc: input.observedAtUtc,
              reconnectCount: input.reconnectCount,
              reasonCode:
                outcome === "ACCEPTED"
                  ? "TRADE_TRANSACTION_VALIDATION_PENDING"
                  : outcome === "FULL"
                    ? "TRADE_VERIFICATION_QUEUE_FULL"
                    : "TRADE_VERIFIER_STOPPED",
              updatedAtUtc: utcNow(),
            });
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
        loaded.config.providers.pumpportal.monitoring_duration_seconds,
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
        await tradeVerifier?.stop();
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
