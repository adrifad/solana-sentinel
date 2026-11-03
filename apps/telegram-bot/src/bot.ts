import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type {
  TelegramOutboxRepository,
  TelegramOutboxItem,
} from "@sentinel/storage";
import { formatCommandResponse, formatNotification } from "./format.ts";
import type { TelegramApiClient, TelegramUpdate } from "./telegram-api.ts";
import { TelegramApiError } from "./telegram-api.ts";
import type { SentinelApiClient } from "./api-client.ts";

export type TelegramBotSettings = {
  enabled: boolean;
  botToken: string | undefined;
  chatId: string | undefined;
  allowedUserIds: string[];
  apiInternalUrl: string;
};

type BotRepository = Pick<
  TelegramOutboxRepository,
  | "claimConsumer"
  | "releaseConsumer"
  | "getState"
  | "setState"
  | "enqueueDailySummary"
  | "claimNext"
  | "markSent"
  | "scheduleRetry"
  | "getQueueDepth"
>;
type Messenger = Pick<
  TelegramApiClient,
  "getUpdates" | "getWebhookInfo" | "sendMessage"
>;
type ApiReader = Pick<SentinelApiClient, "get">;

const LEASE_MS = 60_000;
const LEASE_RENEW_MS = 15_000;
const MAX_DELIVERY_ATTEMPTS = 10;

export class TelegramBotService {
  readonly #ownerId = randomUUID();
  readonly #botKey: string;
  readonly #abort = new AbortController();
  readonly #allowedUsers: Set<string>;
  readonly settings: TelegramBotSettings;
  readonly #repository: BotRepository;
  readonly #messenger: Messenger | null;
  readonly #api: ApiReader;
  readonly #now: () => Date;
  readonly #random: () => number;
  #server: Server | undefined;
  #pollTask: Promise<void> | undefined;
  #deliveryTask: Promise<void> | undefined;
  #summaryTask: Promise<void> | undefined;
  #lastPollAtUtc: string | null = null;
  #pollHealthy = false;
  #leaseAt = 0;
  #lastErrorCode: string | null = null;
  #webhookChecked = false;

  constructor(
    settings: TelegramBotSettings,
    repository: BotRepository,
    messenger: Messenger | null,
    api: ApiReader,
    now: () => Date = () => new Date(),
    random: () => number = Math.random,
  ) {
    this.settings = settings;
    this.#repository = repository;
    this.#messenger = messenger;
    this.#api = api;
    this.#now = now;
    this.#random = random;
    this.#botKey = createHash("sha256")
      .update(settings.botToken ?? "disabled")
      .digest("hex");
    this.#allowedUsers = new Set(settings.allowedUserIds);
  }

  async start(port = 8788): Promise<void> {
    if (this.settings.enabled) {
      if (!this.#messenger || !this.settings.botToken || !this.settings.chatId)
        throw new Error("TELEGRAM_CONFIGURATION_INCOMPLETE");
      const now = this.#now();
      if (
        !this.#repository.claimConsumer(
          this.#botKey,
          this.#ownerId,
          now.toISOString(),
          new Date(now.getTime() + LEASE_MS).toISOString(),
        )
      )
        throw new Error("TELEGRAM_CONSUMER_ALREADY_ACTIVE");
      this.#leaseAt = now.getTime();
    }
    this.#server = createServer((request, response) => {
      if (request.method !== "GET" || request.url !== "/health") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(
        this.settings.enabled && (!this.#pollHealthy || this.#lastErrorCode)
          ? 503
          : 200,
        {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      );
      response.end(
        JSON.stringify({
          state: this.settings.enabled ? "ENABLED" : "DISABLED",
          pollingHealthy: this.#pollHealthy,
          lastPollAtUtc: this.#lastPollAtUtc,
          outboxDepth: this.settings.enabled
            ? this.#repository.getQueueDepth()
            : 0,
          lastErrorCode: this.#lastErrorCode,
        }),
      );
    });
    try {
      await new Promise<void>((resolve, reject) => {
        this.#server!.once("error", reject);
        this.#server!.listen(port, "127.0.0.1", resolve);
      });
    } catch (error) {
      if (this.settings.enabled)
        this.#repository.releaseConsumer(this.#botKey, this.#ownerId);
      throw error;
    }
    if (!this.settings.enabled) return;
    this.#pollTask = this.#runPollLoop();
    this.#deliveryTask = this.#runDeliveryLoop();
    this.#summaryTask = this.#runSummaryLoop();
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    await Promise.allSettled(
      [this.#pollTask, this.#deliveryTask, this.#summaryTask].filter(
        (task): task is Promise<void> => task !== undefined,
      ),
    );
    if (this.settings.enabled)
      this.#repository.releaseConsumer(this.#botKey, this.#ownerId);
    if (this.#server)
      await new Promise<void>((resolve) =>
        this.#server!.close(() => resolve()),
      );
  }

  async processUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message?.text || !message.from) return;
    const chatId = String(message.chat.id);
    const userId = String(message.from.id);
    if (chatId !== this.settings.chatId || !this.#allowedUsers.has(userId))
      return;
    const commandMatch =
      /^\/(start|help|status|portfolio|positions|trades|pnl|health)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.exec(
        message.text.trim(),
      );
    if (!commandMatch) return;
    const command = commandMatch[1]?.toLowerCase();
    if (!command) return;
    if (command === "start" || command === "help") {
      await this.#sendCommandMessage(
        command === "start"
          ? "Solana Sentinel monitoring bot. All portfolio and trade information is PAPER / VIRTUAL. This bot is read-only. Use /help for commands."
          : "Read-only commands: /status, /portfolio, /positions, /trades, /pnl, /health. No trading or configuration actions are available here.",
      );
      return;
    }
    try {
      const health = await this.#api.get("/api/health", this.#abort.signal);
      const paper =
        health["mode"] === "PAPER" &&
        ["portfolio", "positions", "trades", "pnl"].includes(command)
          ? await this.#api.get("/api/paper/status", this.#abort.signal)
          : null;
      await this.#sendCommandMessage(
        formatCommandResponse(command, health, paper),
      );
    } catch (error) {
      await this.#sendCommandMessage(
        `Read-only status unavailable (${safeErrorCode(error)}).`,
      );
    }
  }

  async #runPollLoop(): Promise<void> {
    let retry = 0;
    while (!this.#abort.signal.aborted) {
      try {
        await this.#renewLease();
        const offsetRaw = this.#repository.getState("update_offset");
        const offset = offsetRaw === null ? null : Number(offsetRaw);
        if (offset !== null && !Number.isSafeInteger(offset))
          throw new Error("TELEGRAM_UPDATE_OFFSET_INVALID");
        if (!this.#webhookChecked) {
          const webhook = await this.#messenger!.getWebhookInfo(
            this.#abort.signal,
          );
          if (webhook.configured)
            throw new Error("TELEGRAM_WEBHOOK_CONFIGURED");
          this.#webhookChecked = true;
        }
        const updates = await this.#messenger!.getUpdates(
          offset,
          this.#abort.signal,
        );
        this.#pollHealthy = true;
        this.#lastPollAtUtc = this.#now().toISOString();
        this.#lastErrorCode = null;
        retry = 0;
        for (const update of updates) {
          if (this.#abort.signal.aborted) break;
          try {
            await this.processUpdate(update);
          } catch (error) {
            this.#lastErrorCode = safeErrorCode(error);
            break;
          }
          this.#repository.setState(
            "update_offset",
            String(update.update_id + 1),
            this.#now().toISOString(),
          );
        }
      } catch (error) {
        if (this.#abort.signal.aborted) break;
        this.#pollHealthy = false;
        this.#lastErrorCode = safeErrorCode(error);
        retry += 1;
        const retryAfter =
          error instanceof TelegramApiError ? error.retryAfterSeconds : null;
        await delay(
          retryAfter === null
            ? backoffMs(retry, this.#random)
            : retryAfter * 1000,
          this.#abort.signal,
        );
      }
    }
  }

  async #runDeliveryLoop(): Promise<void> {
    while (!this.#abort.signal.aborted) {
      try {
        const now = this.#now();
        const item = this.#repository.claimNext(
          this.#ownerId,
          now.toISOString(),
          new Date(now.getTime() + 60_000).toISOString(),
        );
        if (!item) {
          await delay(750, this.#abort.signal);
          continue;
        }
        await this.#deliver(item);
      } catch (error) {
        this.#lastErrorCode = safeErrorCode(error);
        await delay(1000, this.#abort.signal);
      }
    }
  }

  async #deliver(item: TelegramOutboxItem): Promise<void> {
    try {
      await this.#messenger!.sendMessage(
        this.settings.chatId!,
        formatNotification(item.eventType, item.payload),
        this.#abort.signal,
      );
      this.#repository.markSent(
        item.id,
        this.#ownerId,
        this.#now().toISOString(),
      );
    } catch (error) {
      if (this.#abort.signal.aborted) return;
      const attempts = item.attempts;
      const retrySeconds =
        error instanceof TelegramApiError && error.retryAfterSeconds !== null
          ? error.retryAfterSeconds
          : Math.ceil(backoffMs(attempts, this.#random) / 1000);
      const terminal = attempts >= MAX_DELIVERY_ATTEMPTS;
      this.#repository.scheduleRetry({
        id: item.id,
        ownerId: this.#ownerId,
        availableAtUtc: new Date(
          this.#now().getTime() + retrySeconds * 1000,
        ).toISOString(),
        errorCode: safeErrorCode(error),
        terminal,
      });
      this.#lastErrorCode = safeErrorCode(error);
    }
  }

  async #runSummaryLoop(): Promise<void> {
    while (!this.#abort.signal.aborted) {
      try {
        const now = this.#now();
        const lastDate = this.#repository.getState(
          "daily_summary_last_queued_date",
        );
        const targetDate = dailySummaryTargetDate(now, lastDate);
        if (targetDate) {
          const summary = await this.#api.get(
            `/api/metrics/daily-summary?date=${targetDate}`,
            this.#abort.signal,
          );
          this.#repository.enqueueDailySummary(
            targetDate,
            summary,
            this.#now().toISOString(),
          );
        }
      } catch (error) {
        this.#lastErrorCode = safeErrorCode(error);
      }
      await delay(30_000, this.#abort.signal);
    }
  }

  async #renewLease(): Promise<void> {
    const now = this.#now();
    if (now.getTime() - this.#leaseAt < LEASE_RENEW_MS) return;
    const renewed = this.#repository.claimConsumer(
      this.#botKey,
      this.#ownerId,
      now.toISOString(),
      new Date(now.getTime() + LEASE_MS).toISOString(),
    );
    if (!renewed) throw new Error("TELEGRAM_CONSUMER_LEASE_LOST");
    this.#leaseAt = now.getTime();
  }

  async #sendCommandMessage(text: string): Promise<void> {
    if (!this.#messenger || !this.settings.chatId) return;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.#messenger.sendMessage(
          this.settings.chatId,
          text,
          this.#abort.signal,
        );
        return;
      } catch (error) {
        const retryAfter =
          error instanceof TelegramApiError ? error.retryAfterSeconds : null;
        if (retryAfter === null || attempt >= 3) throw error;
        await delay(retryAfter * 1000, this.#abort.signal);
      }
    }
  }
}

export function dailySummaryTargetDate(
  now: Date,
  lastQueuedDate: string | null,
): string | null {
  const local = jakartaParts(now);
  const today = `${local.year}-${local.month}-${local.day}`;
  const dueDate =
    local.hour === 23 && local.minute >= 59 ? today : previousDate(today);
  if (!lastQueuedDate)
    return local.hour === 23 && local.minute >= 59 ? today : null;
  const next = nextDate(lastQueuedDate);
  return next <= dueDate ? next : null;
}

export function isAuthorizedUpdate(
  update: TelegramUpdate,
  chatId: string | undefined,
  allowedUserIds: readonly string[],
): boolean {
  return Boolean(
    update.message?.from &&
    String(update.message.chat.id) === chatId &&
    allowedUserIds.includes(String(update.message.from.id)),
  );
}

function safeErrorCode(error: unknown): string {
  if (error instanceof TelegramApiError) return error.errorCode;
  if (error instanceof Error && /^[A-Z0-9_:-]{1,80}$/.test(error.message))
    return error.message;
  return "UNEXPECTED_ERROR";
}

function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(15 * 60_000, 1000 * 2 ** Math.min(attempt - 1, 10));
  return Math.max(250, Math.round(ceiling * (0.75 + random() * 0.5)));
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function jakartaParts(date: Date): {
  year: string;
  month: string;
  day: string;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return {
    year: values["year"] ?? "0000",
    month: values["month"] ?? "00",
    day: values["day"] ?? "00",
    hour: Number(values["hour"]),
    minute: Number(values["minute"]),
  };
}

function nextDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function previousDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}
