import { loadConfig, loadTelegramRuntimeConfig } from "@sentinel/config";
import { TelegramOutboxRepository } from "@sentinel/storage";
import { SentinelApiClient } from "./api-client.ts";
import { TelegramBotService } from "./bot.ts";
import { TelegramApiClient } from "./telegram-api.ts";

const config = await loadConfig();
const telegram = loadTelegramRuntimeConfig(process.env);
const repository = new TelegramOutboxRepository(config.dbPath);
if (telegram.enabled) repository.open();
const bot = new TelegramBotService(
  telegram,
  repository,
  telegram.botToken ? new TelegramApiClient(telegram.botToken) : null,
  new SentinelApiClient(telegram.apiInternalUrl),
);

try {
  await bot.start(Number(process.env["TELEGRAM_HEALTH_PORT"] ?? "8788"));
  process.stdout.write(
    `${JSON.stringify({ level: "info", event: "telegram.service.started", enabled: telegram.enabled })}\n`,
  );
} catch (error) {
  if (telegram.enabled) repository.close();
  throw error;
}

let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await bot.stop();
  if (telegram.enabled) repository.close();
  process.exitCode = 0;
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
