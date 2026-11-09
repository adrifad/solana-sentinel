import { createHash, randomUUID } from "node:crypto";
import { isTelegramConfigured, loadConfig } from "@sentinel/config";
import { utcNow } from "@sentinel/domain";
import type { ProviderHealth } from "@sentinel/domain";
import {
  HeliusTradeStream,
  HeliusRpcClient,
  HeliusParsedEventsScanClient,
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
import {
  parsedScanMatchesVerifiedTrades,
  TradeReconciliationWorker,
} from "./trade-reconciliation.ts";
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
      maxPendingRequests: loaded.config.providers.helius.max_pending_requests,
      consumeRequestBudget: (request) =>
        store.consumeHeliusRequest({
          ...request,
          maxRequestsPerUtcDay:
            loaded.config.providers.helius.max_requests_per_utc_day,
          exitReservedRequestsPerUtcDay:
            loaded.config.providers.helius.exit_reserved_requests_per_utc_day,
          maxRequestsPerWindow:
            loaded.config.providers.helius.max_requests_per_window,
          requestWindowSeconds:
            loaded.config.providers.helius.request_window_seconds,
          maxRequestsPerSecond:
            loaded.config.providers.helius.max_requests_per_second,
        }),
      recordRequestOutcome: (request) =>
        store.recordHeliusRequestOutcome(request),
    });
    const health = await helius.getHealth();
    heliusState = health.ok ? "HEALTHY" : "DEGRADED";
    heliusError = health.errorCode;
    const budget = store.getHeliusRequestBudget(
      loaded.config.providers.helius.max_requests_per_utc_day,
      loaded.config.providers.helius.exit_reserved_requests_per_utc_day,
      {
        maxRequestsPerWindow:
          loaded.config.providers.helius.max_requests_per_window,
        requestWindowSeconds:
          loaded.config.providers.helius.request_window_seconds,
      },
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
  const notifyAnalysisForReconciliation = (
    items: Array<{
      jobId: string;
      mint: string;
      status: "COMPLETE" | "PARTIAL";
    }>,
  ) => {
    for (const item of items) {
      if (
        store.requeueLatestAnalysisForMint(
          item.mint,
          `reconciliation:${item.jobId}:${item.status}`,
        )
      )
        analysis.wake();
    }
  };
  const tradeVerifier =
    (loaded.config.providers.helius.enable_trade_stream ||
      loaded.config.providers.helius.parsed_events_scan_enabled) &&
    helius
      ? new BoundedTradeVerificationQueue({
          maxPending:
            loaded.config.providers.helius.max_pending_trade_verifications,
          concurrency:
            loaded.config.providers.helius.trade_verification_concurrency,
          async process(input) {
            const transaction = await helius!.getTransaction(
              input.signature,
              input.payloadRef.startsWith("parsed-scan:")
                ? "CANDIDATE"
                : "BACKGROUND",
              input.mint,
            );
            if (
              input.payloadRef.startsWith("parsed-scan:") &&
              transaction === null
            ) {
              notifyAnalysisForReconciliation(
                store.retryParsedReconciliationTransaction({
                  mint: input.mint,
                  signature: input.signature,
                  reasonCode: "TRADE_TRANSACTION_NOT_FOUND",
                  retryAfterMs: 2_000,
                }),
              );
              return;
            }
            if (
              input.payloadRef.startsWith("parsed-scan:") &&
              (input.providerBlockTime === undefined ||
                input.providerBlockTime === null ||
                transaction?.blockTime !== input.providerBlockTime)
            ) {
              const reasonCode = transaction
                ? "SCAN_TRANSACTION_BLOCK_TIME_MISMATCH"
                : "TRADE_TRANSACTION_NOT_FOUND";
              notifyAnalysisForReconciliation(
                store.setParsedReconciliationTransactionStatus({
                  mint: input.mint,
                  signature: input.signature,
                  status: "FAILED",
                  reasonCode,
                }),
              );
              if (!input.payloadRef.startsWith("parsed-scan:")) {
                store.recordTradeObservationCoverage({
                  mint: input.mint,
                  source: tradeCoverageSource,
                  status: "PARTIAL",
                  windowStartedAtUtc: input.windowStartedAtUtc,
                  windowExpiresAtUtc: input.windowExpiresAtUtc,
                  lastEventAtUtc: input.observedAtUtc,
                  reconnectCount: input.reconnectCount,
                  reasonCode,
                  updatedAtUtc: utcNow(),
                });
                if (
                  store.requeueLatestAnalysisForMint(
                    input.mint,
                    `coverage:${input.mint}:${input.windowStartedAtUtc}:${reasonCode}`,
                  )
                )
                  analysis.wake();
              }
              return;
            }
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
            const parsedScanMismatch =
              input.payloadRef.startsWith("parsed-scan:") &&
              validated.status === "VERIFIED" &&
              !parsedScanMatchesVerifiedTrades({
                expectedMint: input.expectedMint,
                expectedSide: input.expectedSide,
                observations: validated.observations,
              });
            if (validated.status !== "VERIFIED" || parsedScanMismatch) {
              const reasonCode = parsedScanMismatch
                ? "SCAN_TRADE_MINT_OR_SIDE_MISMATCH"
                : (validated.reasonCode ?? "TRADE_EVIDENCE_UNVERIFIED");
              notifyAnalysisForReconciliation(
                store.setParsedReconciliationTransactionStatus({
                  mint: input.mint,
                  signature: input.signature,
                  status: "UNSUPPORTED",
                  reasonCode,
                }),
              );
              if (!input.payloadRef.startsWith("parsed-scan:")) {
                store.recordTradeObservationCoverage({
                  mint: input.mint,
                  source: tradeCoverageSource,
                  status: "UNVERIFIED",
                  windowStartedAtUtc: input.windowStartedAtUtc,
                  windowExpiresAtUtc: input.windowExpiresAtUtc,
                  lastEventAtUtc: input.observedAtUtc,
                  reconnectCount: input.reconnectCount,
                  reasonCode,
                  updatedAtUtc: utcNow(),
                });
                if (
                  store.requeueLatestAnalysisForMint(
                    input.mint,
                    `coverage:${input.mint}:${input.windowStartedAtUtc}:${reasonCode}`,
                  )
                )
                  analysis.wake();
              }
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
              const inserted = store.saveLaunchTradeObservation({
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
              if (inserted) {
                const triggerKey = `trade:${id}`;
                if (store.requeueLatestAnalysisForMint(input.mint, triggerKey))
                  analysis.wake();
              }
            }
            const finalized = store.setParsedReconciliationTransactionStatus({
              mint: input.mint,
              signature: input.signature,
              status: "VERIFIED",
              reasonCode: null,
            });
            notifyAnalysisForReconciliation(finalized);
            if (!input.payloadRef.startsWith("parsed-scan:"))
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
            if (validated.observations.length === 0) analysis.wake();
          },
          onFailure(input, error) {
            const code =
              error && typeof error === "object" && "code" in error
                ? String(error.code)
                : "TRADE_TRANSACTION_VALIDATION_FAILED";
            if (
              [
                "TIMEOUT",
                "RATE_LIMITED",
                "PROVIDER_UNAVAILABLE",
                "CIRCUIT_OPEN",
                "REQUEST_BUDGET_EXHAUSTED",
              ].includes(code)
            )
              notifyAnalysisForReconciliation(
                store.retryParsedReconciliationTransaction({
                  mint: input.mint,
                  signature: input.signature,
                  reasonCode: code,
                  retryAfterMs: Math.min(120_000, 1000 * 2 ** Math.min(7, 1)),
                }),
              );
            else
              notifyAnalysisForReconciliation(
                store.setParsedReconciliationTransactionStatus({
                  mint: input.mint,
                  signature: input.signature,
                  status: "FAILED",
                  reasonCode: code,
                }),
              );
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
            if (
              store.requeueLatestAnalysisForMint(
                input.mint,
                `trade-validation-error:${input.mint}:${input.signature}:${code}`,
              )
            )
              analysis.wake();
          },
        })
      : undefined;

  const parsedScanEnabled =
    loaded.config.providers.helius.parsed_events_scan_enabled &&
    loaded.config.providers.helius.parsed_events_scan_max_credits_per_utc_day >
      0 &&
    Boolean(helius && loaded.heliusApiKey) &&
    Boolean(tradeVerifier);
  const reconciliation = parsedScanEnabled
    ? new TradeReconciliationWorker({
        store,
        scan: new HeliusParsedEventsScanClient({
          apiKey: loaded.heliusApiKey!,
          timeoutMs: loaded.config.providers.helius.request_timeout_ms,
          creditReservation: {
            reserve: (credits) =>
              store.reserveParsedEventsScanCredits(
                loaded.config.providers.helius
                  .parsed_events_scan_max_credits_per_utc_day,
                credits,
              ),
            settle: (reservationDay, credits) =>
              store.settleParsedEventsScanCredits(
                reservationDay,
                10 +
                  Math.ceil(
                    loaded.config.providers.helius
                      .parsed_events_scan_max_scanned_transactions / 1000,
                  ),
                credits,
              ),
          },
        }),
        verificationQueue: tradeVerifier!,
        maxPagesPerJob:
          loaded.config.providers.helius.parsed_events_scan_max_pages_per_job,
        maxScannedTransactions:
          loaded.config.providers.helius
            .parsed_events_scan_max_scanned_transactions,
        concurrency:
          loaded.config.providers.helius.parsed_events_scan_concurrency,
        finalityBufferSeconds:
          loaded.config.providers.helius
            .parsed_events_scan_finality_buffer_seconds,
        onEvidence: ({ mint, triggerKey }) => {
          if (store.requeueLatestAnalysisForMint(mint, triggerKey))
            analysis.wake();
        },
      })
    : undefined;
  if (parsedScanEnabled) {
    for (const token of store.listTokens(200)) {
      if (!token.monitoringEligible) continue;
      const start = Date.parse(token.firstSeenAtUtc);
      if (!Number.isFinite(start)) continue;
      const seconds = loaded.config.analysis.token_observation_seconds;
      store.enqueueTradeReconciliation({
        mint: token.mint,
        windowStartedAtUtc: token.firstSeenAtUtc,
        windowExpiresAtUtc: new Date(start + seconds * 1000).toISOString(),
      });
    }
    reconciliation?.start();
  }

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
            const triggerKey =
              input.reasonCode === "OBSERVATION_WINDOW_EXPIRED"
                ? `stream-window:${input.mint}:${input.windowStartedAtUtc}:${input.windowExpiresAtUtc}`
                : `stream-coverage:${input.mint}:${input.status}:${input.reasonCode}:${input.windowStartedAtUtc}`;
            if (store.requeueLatestAnalysisForMint(input.mint, triggerKey))
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
      if (
        event.kind === "TOKEN_CREATED" &&
        outcome.monitoringEligible &&
        parsedScanEnabled
      ) {
        const windowStart = event.firstSeenAtUtc;
        const windowEnd = new Date(
          Date.parse(windowStart) +
            loaded.config.analysis.token_observation_seconds * 1000,
        ).toISOString();
        store.enqueueTradeReconciliation({
          mint: event.mint,
          windowStartedAtUtc: windowStart,
          windowExpiresAtUtc: windowEnd,
        });
      }
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
        await reconciliation?.stop();
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
