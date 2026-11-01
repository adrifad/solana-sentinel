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
  automaticEntriesEnabled: config.config.paper.automatic_entries_enabled,
  paperWalletId: config.config.paper.wallet_id,
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
