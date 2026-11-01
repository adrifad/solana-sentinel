import { loadConfig } from "@sentinel/config";
import { utcNow } from "@sentinel/domain";
import type { ProviderHealth } from "@sentinel/domain";
import {
  HeliusRpcClient,
  PumpPortalClient,
  pumpPortalHealth,
} from "@sentinel/providers";
import { SentinelStore } from "@sentinel/storage";
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

  const pump = new PumpPortalClient({
    apiKey: loaded.pumpPortalApiKey,
    enableNewTokens: loaded.config.providers.pumpportal.enable_new_tokens,
    enableMigrations: loaded.config.providers.pumpportal.enable_migrations,
    onHealth(state, reconnectCount, errorCode, lastEventAtUtc) {
      const health = pumpPortalHealth(
        state,
        reconnectCount,
        errorCode,
        lastEventAtUtc,
      );
      store.setProviderHealth(health);
      log(state === "DEGRADED" ? "warn" : "info", "provider.pumpportal.state", {
        state,
        reconnectCount,
        errorCode,
      });
    },
    async onEvent(event) {
      const outcome = store.ingestEvent(
        event,
        loaded.config.providers.pumpportal.max_monitored_tokens,
      );
      if (outcome.inserted && event.kind === "TOKEN_CREATED" && helius) {
        try {
          const mintAccount = await helius.getAccountInfo(event.mint);
          store.recordMintAccount(
            event.mint,
            mintAccount.account ? "PRESENT" : "NOT_FOUND",
            mintAccount.slot,
            mintAccount.account?.owner ?? null,
            null,
          );
          store.setProviderHealth({
            provider: "helius",
            state: "HEALTHY",
            checkedAtUtc: utcNow(),
            lastEventAtUtc: null,
            reconnectCount: 0,
            errorCode: null,
          });
        } catch (error) {
          const errorCode =
            error instanceof Error ? error.message : "PROVIDER_UNAVAILABLE";
          store.recordMintAccount(
            event.mint,
            "PROVIDER_ERROR",
            null,
            null,
            errorCode,
          );
          store.setProviderHealth({
            provider: "helius",
            state: "DEGRADED",
            checkedAtUtc: utcNow(),
            lastEventAtUtc: null,
            reconnectCount: 0,
            errorCode,
          });
          log("warn", "provider.helius.mint_read_failed", {
            mint: event.mint,
            errorCode,
          });
        }
      }
      if (outcome.inserted && event.slot !== undefined && helius) {
        try {
          const observedAtUtc = await helius.getBlockTime(event.slot);
          if (observedAtUtc)
            store.recordObservedTimestamp(event.id, observedAtUtc);
          store.setProviderHealth({
            provider: "helius",
            state: "HEALTHY",
            checkedAtUtc: utcNow(),
            lastEventAtUtc: null,
            reconnectCount: 0,
            errorCode: null,
          });
        } catch (error) {
          const errorCode =
            error instanceof Error ? error.message : "PROVIDER_UNAVAILABLE";
          store.setProviderHealth({
            provider: "helius",
            state: "DEGRADED",
            checkedAtUtc: utcNow(),
            lastEventAtUtc: null,
            reconnectCount: 0,
            errorCode,
          });
          log("warn", "provider.helius.block_time_failed", {
            mint: event.mint,
            slot: event.slot,
            errorCode,
          });
        }
      }
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
  });

  let stopped = false;
  const shutdown = (): void => {
    if (stopped) return;
    stopped = true;
    void pump.stop().finally(() => {
      store.close();
      log("info", "worker.stopped");
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  log("info", "worker.started", {
    mode: loaded.config.mode,
    configVersion: loaded.configVersion,
    database: loaded.dbPath,
  });
  await pump.start();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  log("error", "worker.start_failed", { errorCode: message.slice(0, 80) });
  process.exitCode = 1;
});
