import { loadConfig } from "@sentinel/config";
import { SentinelStore } from "@sentinel/storage";
import { createApiServer } from "./server.ts";

const config = await loadConfig();
const store = new SentinelStore(config.dbPath);
await store.open();
const server = createApiServer({
  store,
  mode: config.config.mode,
  staleFeedSeconds: config.config.observability.health_stale_feed_seconds,
  tradeStreamEnabled: config.config.providers.helius.enable_trade_stream,
  parsedScanEnabled:
    config.config.providers.helius.parsed_events_scan_enabled &&
    config.config.providers.helius.parsed_events_scan_max_credits_per_utc_day >
      0 &&
    Boolean(config.heliusApiKey),
  heliusMaxRequestsPerUtcDay:
    config.config.providers.helius.max_requests_per_utc_day,
  heliusExitReservedRequestsPerUtcDay:
    config.config.providers.helius.exit_reserved_requests_per_utc_day,
  parsedScanCreditsPerUtcDay:
    config.config.providers.helius.parsed_events_scan_max_credits_per_utc_day,
  automaticEntriesEnabled: config.config.paper.automatic_entries_enabled,
  paperWalletId: config.config.paper.wallet_id,
  ...(config.paperOperatorToken
    ? { operatorToken: config.paperOperatorToken }
    : {}),
  maxTradeSol: config.config.risk.max_trade_sol,
  maxQuoteAgeMs: config.config.paper.max_quote_age_ms,
  initialSol: config.config.paper.initial_sol,
  manualEntryRequestExpiryMs:
    config.config.paper.manual_entry_request_expiry_ms,
  manualExitRequestExpiryMs: config.config.paper.manual_exit_request_expiry_ms,
  minHolderSampleCoverageBps:
    config.config.analysis.min_holder_sample_coverage_bps,
  minIndependentBuyers: Math.max(
    config.config.analysis.min_independent_buyers,
    config.config.strategy.min_independent_buyers,
  ),
  positionMonitorIntervalMs: config.config.paper.position_monitor_interval_ms,
  positionMonitorMaxIntervalMs:
    config.config.paper.position_monitor_max_interval_ms,
  positionMonitorEstimatedRpcRequests:
    config.config.paper.position_monitor_estimated_rpc_requests,
});
server.listen(config.apiPort, config.apiHost, () => {
  process.stdout.write(
    `${JSON.stringify({ level: "info", event: "api.listening", host: config.apiHost, port: config.apiPort })}\n`,
  );
});

const shutdown = (): void => {
  server.close(() => {
    store.close();
    process.exitCode = 0;
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
