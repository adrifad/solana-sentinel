import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { base58Encode } from "@sentinel/domain";
import type { PaperOrderIntent, QuoteResult } from "@sentinel/domain";
import { loadConfig } from "@sentinel/config";
import {
  PaperTradingEngine,
  paperExecutionConfigFromAppConfig,
} from "@sentinel/paper";
import { SentinelStore, TelegramOutboxRepository } from "@sentinel/storage";
import {
  dailySummaryTargetDate,
  TelegramBotService,
} from "../apps/telegram-bot/src/bot.ts";
import {
  formatDailySummary,
  formatNotification,
  formatSol,
} from "../apps/telegram-bot/src/format.ts";
import {
  TelegramApiClient,
  TelegramApiError,
} from "../apps/telegram-bot/src/telegram-api.ts";

const mint = base58Encode(Buffer.alloc(32, 77));
const wsol = "So11111111111111111111111111111111111111112";

async function withStore(
  run: (store: SentinelStore, path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-telegram-"));
  const path = join(directory, "sentinel.db");
  const store = new SentinelStore(path, { telegramEnabled: true });
  await store.open();
  try {
    await run(store, path);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function paperIntent(
  id: string,
  side: "BUY" | "SELL" = "BUY",
): PaperOrderIntent {
  return {
    id,
    idempotencyKey: `telegram-test:${id}`,
    walletId: "telegram-paper-wallet",
    mode: "PAPER",
    mint,
    side,
    exactInputAmountRaw: side === "BUY" ? "10000000" : "995000",
    decisionId: `decision:${id}`,
    reasonCodes: side === "SELL" ? ["STOP_LOSS_TRIGGERED"] : ["TEST_FIXTURE"],
    createdAtUtc: new Date().toISOString(),
    signalQuoteId: null,
    entrySource: "MANUAL",
  };
}

function quoteProvider() {
  let index = 0;
  return {
    async quoteAtArrival(request: {
      mint: string;
      side: "BUY" | "SELL";
      exactInputAmountRaw: string;
      requestedAtUtc: string;
    }): Promise<QuoteResult> {
      index += 1;
      return {
        id: `telegram-quote:${index}`,
        mint: request.mint,
        direction: request.side,
        exactInputAmountRaw: request.exactInputAmountRaw,
        expectedOutputAmountRaw:
          request.side === "BUY" ? "1000000" : "20000000",
        inputMint: request.side === "BUY" ? wsol : request.mint,
        outputMint: request.side === "BUY" ? request.mint : wsol,
        venue: "PUMP_BONDING_CURVE",
        source: "synthetic-telegram-test-quote",
        snapshotSlot: 123,
        snapshotAtUtc: request.requestedAtUtc,
        feeAmountRaw: "0",
        feeMint: wsol,
        feeModel: "synthetic-test-no-fee",
        priceImpactBps: 10,
        liquidityQuoteRaw: "100000000000",
        freshnessMs: 0,
        validationStatus: "PASS",
        failureReason: null,
        evidenceRefs: ["synthetic:telegram-test"],
        provenance: { fixture: "synthetic" },
        observedAtUtc: request.requestedAtUtc,
      };
    },
  };
}

test("committed PAPER fills create one durable PAPER/VIRTUAL notification", async () => {
  await withStore(async (store, path) => {
    const loaded = await loadConfig({ APP_MODE: "PAPER" });
    const engine = new PaperTradingEngine({
      repository: store,
      quotes: quoteProvider(),
      config: paperExecutionConfigFromAppConfig(loaded.config),
    });
    engine.initializeWallet("telegram-paper-wallet", "1");
    const order = paperIntent("telegram-buy");
    const result = await engine.execute(order);
    assert.equal(result.order.status, "SIMULATED_FILLED");
    const replay = await engine.execute(order);
    assert.equal(replay.order.status, "SIMULATED_FILLED");
    const direct = new DatabaseSync(path);
    try {
      const event = direct
        .prepare("SELECT * FROM telegram_outbox WHERE dedupe_key = ?")
        .get("paper-fill:telegram-buy") as Record<string, unknown> | undefined;
      assert.ok(event);
      assert.equal(event["event_type"], "PAPER_FILL");
      assert.equal(event["status"], "PENDING");
      const payload = JSON.parse(String(event["payload_json"])) as Record<
        string,
        unknown
      >;
      assert.equal(payload["virtual"], true);
      assert.equal(payload["side"], "BUY");
      assert.equal(payload["entrySource"], "MANUAL");
      const count = direct
        .prepare(
          "SELECT COUNT(*) AS count FROM telegram_outbox WHERE dedupe_key = ?",
        )
        .get("paper-fill:telegram-buy") as { count: number };
      assert.equal(count.count, 1);
      const integrity = direct.prepare("PRAGMA integrity_check").get() as {
        integrity_check: string;
      };
      assert.equal(integrity.integrity_check, "ok");
      assert.match(
        formatNotification("PAPER_FILL", payload),
        /PAPER \/ VIRTUAL/,
      );
      assert.equal(store.getPaperFill("telegram-buy")?.["side"], "BUY");
    } finally {
      direct.close();
    }
  });
});

test("failed PAPER exit is notified only after its rejection is persisted and preserves holdings", async () => {
  await withStore(async (store, path) => {
    const loaded = await loadConfig({ APP_MODE: "PAPER" });
    const baseQuotes = quoteProvider();
    const engine = new PaperTradingEngine({
      repository: store,
      quotes: {
        async quoteAtArrival(request) {
          if (request.side === "SELL") return null;
          return baseQuotes.quoteAtArrival(request);
        },
      },
      config: paperExecutionConfigFromAppConfig(loaded.config),
    });
    engine.initializeWallet("telegram-paper-wallet", "1");
    assert.equal(
      (await engine.execute(paperIntent("telegram-buy-before-exit"))).order
        .status,
      "SIMULATED_FILLED",
    );
    const before = store.getPaperPortfolioState("telegram-paper-wallet");
    const exit = await engine.execute(
      paperIntent("telegram-exit-unavailable", "SELL"),
    );
    assert.equal(exit.order.status, "UNFILLABLE");
    const after = store.getPaperPortfolioState("telegram-paper-wallet");
    assert.equal(after.solBalanceRaw, before.solBalanceRaw);
    assert.equal(
      after.positions[0]?.tokenAmountRaw,
      before.positions[0]?.tokenAmountRaw,
    );
    const direct = new DatabaseSync(path);
    try {
      const event = direct
        .prepare(
          "SELECT status, payload_json FROM telegram_outbox WHERE dedupe_key = ?",
        )
        .get("paper-exit-failed:telegram-exit-unavailable") as
        { status: string; payload_json: string } | undefined;
      assert.ok(event);
      assert.equal(event.status, "PENDING");
      assert.equal(
        JSON.parse(event.payload_json).reasonCode,
        "PAPER_QUOTE_UNAVAILABLE",
      );
    } finally {
      direct.close();
    }
  });
});

test("Telegram provider transitions are deduplicated and delivery lease is exclusive", async () => {
  await withStore(async (store, path) => {
    const time = "2026-11-03T01:00:00.000Z";
    store.setProviderHealth({
      provider: "helius",
      state: "DEGRADED",
      checkedAtUtc: time,
      lastEventAtUtc: null,
      reconnectCount: 0,
      errorCode: "PROVIDER_TIMEOUT",
    });
    store.setProviderHealth({
      provider: "helius",
      state: "DEGRADED",
      checkedAtUtc: "2026-11-03T01:00:10.000Z",
      lastEventAtUtc: null,
      reconnectCount: 0,
      errorCode: "PROVIDER_TIMEOUT",
    });
    store.setProviderHealth({
      provider: "helius",
      state: "HEALTHY",
      checkedAtUtc: "2026-11-03T01:01:00.000Z",
      lastEventAtUtc: null,
      reconnectCount: 1,
      errorCode: null,
    });
    const first = new TelegramOutboxRepository(path);
    const second = new TelegramOutboxRepository(path);
    first.open();
    second.open();
    try {
      assert.equal(first.getQueueDepth(), 2);
      assert.equal(
        first.claimConsumer(
          "token-hash",
          "first",
          time,
          "2026-11-03T01:02:00.000Z",
        ),
        true,
      );
      assert.equal(
        second.claimConsumer(
          "token-hash",
          "second",
          time,
          "2026-11-03T01:02:00.000Z",
        ),
        false,
      );
      const item = first.claimNext("first", time, "2026-11-03T01:02:00.000Z");
      assert.ok(item);
      assert.equal(item.eventType, "PROVIDER_DISCONNECTED");
      assert.equal(
        first.scheduleRetry({
          id: item.id,
          ownerId: "first",
          availableAtUtc: "2026-11-03T01:00:17.000Z",
          errorCode: "TELEGRAM_RATE_LIMITED",
          terminal: false,
        }),
        true,
      );
      const retried = first.claimNext(
        "first",
        "2026-11-03T01:00:17.000Z",
        "2026-11-03T01:01:17.000Z",
      );
      assert.ok(retried);
      assert.equal(retried.attempts, 2);
      first.setState("update_offset", "42", time);
      first.close();
      const restarted = new TelegramOutboxRepository(path);
      restarted.open();
      assert.equal(restarted.getState("update_offset"), "42");
      const recovered = restarted.claimNext(
        "restart",
        "2026-11-03T01:02:00.000Z",
        "2026-11-03T01:03:00.000Z",
      );
      assert.ok(recovered);
      assert.equal(recovered.id, retried.id);
      assert.equal(recovered.attempts, 3);
      assert.equal(
        restarted.markSent(recovered.id, "restart", "2026-11-03T01:02:01.000Z"),
        true,
      );
      restarted.close();
    } finally {
      try {
        first.close();
      } catch {
        /* already closed during restart check */
      }
      second.close();
    }
  });
});

test("daily summaries use a unique local-date key across restarts", async () => {
  await withStore(async (store, path) => {
    const repository = new TelegramOutboxRepository(path);
    repository.open();
    try {
      const summary = { dateAsiaJakarta: "2026-11-03", summary: { sells: 0 } };
      assert.equal(
        repository.enqueueDailySummary(
          "2026-11-03",
          summary,
          "2026-11-03T16:59:00.000Z",
        ),
        true,
      );
      assert.equal(
        repository.enqueueDailySummary(
          "2026-11-03",
          summary,
          "2026-11-03T17:00:00.000Z",
        ),
        false,
      );
      assert.equal(
        repository.getState("daily_summary_last_queued_date"),
        "2026-11-03",
      );
    } finally {
      repository.close();
    }
  });
});

test("daily summary scheduler follows 23:59 Asia/Jakarta and catches up after restart", () => {
  assert.equal(
    dailySummaryTargetDate(new Date("2026-11-03T16:58:59.000Z"), null),
    null,
  );
  assert.equal(
    dailySummaryTargetDate(new Date("2026-11-03T16:59:00.000Z"), null),
    "2026-11-03",
  );
  assert.equal(
    dailySummaryTargetDate(new Date("2026-11-03T02:00:00.000Z"), "2026-11-01"),
    "2026-11-02",
  );
  assert.equal(
    dailySummaryTargetDate(new Date("2026-11-03T02:00:00.000Z"), "2026-11-02"),
    null,
  );
});

test("only explicitly allowlisted Telegram users in the configured chat get read-only commands", async () => {
  const sent: string[] = [];
  let apiCalls = 0;
  const service = new TelegramBotService(
    {
      enabled: true,
      botToken: "test-token-not-real",
      chatId: "-100123",
      allowedUserIds: ["456"],
      apiInternalUrl: "http://api:8787",
    },
    {} as never,
    {
      async getUpdates() {
        return [];
      },
      async getWebhookInfo() {
        return { configured: false };
      },
      async sendMessage(_chat, text) {
        sent.push(text);
      },
    },
    {
      async get(path) {
        apiCalls += 1;
        return path === "/api/health"
          ? {
              mode: "PAPER",
              readiness: { blockers: ["TRADE_STREAM_COVERAGE_UNVERIFIED"] },
              providers: [],
            }
          : {
              positions: [],
              solBalanceLamports: "10000000000",
              realizedPnlLamports: "0",
              unrealizedPnlLamports: null,
            };
      },
    },
  );
  await service.processUpdate({
    update_id: 1,
    message: { chat: { id: -100123 }, from: { id: 999 }, text: "/status" },
  });
  assert.equal(sent.length, 0);
  assert.equal(apiCalls, 0);
  await service.processUpdate({
    update_id: 2,
    message: {
      chat: { id: -100123 },
      from: { id: 456 },
      text: "/status@sentinel_bot",
    },
  });
  assert.equal(apiCalls, 1);
  assert.match(sent[0] ?? "", /PAPER/);
  assert.match(sent[0] ?? "", /TRADE_STREAM_COVERAGE_UNVERIFIED/);
});

test("all Telegram commands are read-only and never invoke PAPER write routes", async () => {
  const sent: string[] = [];
  const requestedPaths: string[] = [];
  const service = new TelegramBotService(
    {
      enabled: true,
      botToken: "test-token-not-real",
      chatId: "100",
      allowedUserIds: ["200"],
      apiInternalUrl: "http://api:8787",
    },
    {} as never,
    {
      async getUpdates() {
        return [];
      },
      async getWebhookInfo() {
        return { configured: false };
      },
      async sendMessage(_chat, text) {
        sent.push(text);
      },
    },
    {
      async get(path) {
        requestedPaths.push(path);
        return path === "/api/health"
          ? { mode: "PAPER", readiness: { blockers: [] }, providers: [] }
          : {
              positions: [],
              latestFills: [],
              solBalanceLamports: "10000000000",
              realizedPnlLamports: "0",
              unrealizedPnlLamports: null,
              closedTradeCount: 0,
              winningTrades: 0,
              readinessBlockers: [],
            };
      },
    },
  );
  const commands = [
    "/start",
    "/help",
    "/status",
    "/portfolio",
    "/positions",
    "/trades",
    "/pnl",
    "/health",
  ];
  for (const [index, text] of commands.entries())
    await service.processUpdate({
      update_id: index,
      message: { chat: { id: 100 }, from: { id: 200 }, text },
    });
  assert.equal(sent.length, commands.length);
  assert.ok(requestedPaths.every((path) => path.startsWith("/api/")));
  assert.equal(requestedPaths.includes("/api/paper/entry"), false);
  assert.equal(requestedPaths.includes("/api/paper/exit"), false);
  assert.equal(
    requestedPaths.filter((path) => path === "/api/paper/status").length,
    4,
  );
});

test("Telegram API honors retry_after without exposing response text", async () => {
  const client = new TelegramApiClient(
    "fake-test-token",
    async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: "private detail",
          parameters: { retry_after: 17 },
        }),
        { status: 429 },
      ),
  );
  await assert.rejects(
    () => client.sendMessage("1", "test"),
    (error: unknown) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.errorCode, "TELEGRAM_RATE_LIMITED");
      assert.equal(error.retryAfterSeconds, 17);
      assert.equal(error.message.includes("private detail"), false);
      return true;
    },
  );
});

test("read-only command replies retry Telegram 429 using retry_after", async () => {
  let attempts = 0;
  const service = new TelegramBotService(
    {
      enabled: true,
      botToken: "fake-test-token",
      chatId: "100",
      allowedUserIds: ["200"],
      apiInternalUrl: "http://localhost:8787",
    },
    {} as TelegramOutboxRepository,
    {
      async getUpdates() {
        return [];
      },
      async getWebhookInfo() {
        return { configured: false };
      },
      async sendMessage() {
        attempts += 1;
        if (attempts === 1)
          throw new TelegramApiError("TELEGRAM_RATE_LIMITED", 1);
      },
    },
    {
      async get() {
        return { mode: "DRY_RUN" };
      },
    },
  );
  await service.processUpdate({
    update_id: 42,
    message: { chat: { id: 100 }, from: { id: 200 }, text: "/start" },
  });
  assert.equal(attempts, 2);
});

test("long-poll startup detects an existing webhook without removing it", async () => {
  const requestedMethods: string[] = [];
  const client = new TelegramApiClient("fake-test-token", async (input) => {
    requestedMethods.push(String(input).split("/").at(-1) ?? "");
    return new Response(
      JSON.stringify({
        ok: true,
        result: { url: "https://example.invalid/hook" },
      }),
      { status: 200 },
    );
  });
  assert.deepEqual(await client.getWebhookInfo(), { configured: true });
  assert.deepEqual(requestedMethods, ["getWebhookInfo"]);
});

test("SOL and fill notifications use exact lamports and clearly label virtual execution", () => {
  assert.equal(formatSol("10000000000"), "10 SOL");
  const message = formatNotification("PAPER_FILL", {
    side: "SELL",
    mint,
    tokenName: "TEST",
    inputAmountRaw: "1000000",
    outputAmountRaw: "25000000",
    tokenDecimals: 6,
    realizedPnlLamports: "15000000",
    realizedPnlPercentBps: "1500",
    venueFeeRaw: "1000000",
    networkFeeLamports: "10000",
    exitReasonCodes: ["TAKE_PROFIT_TRIGGERED"],
    entrySource: "AUTOMATIC",
    venue: "PUMPSWAP",
    filledAtUtc: "2026-11-03T00:00:00.000Z",
  });
  assert.match(message, /PAPER \/ VIRTUAL/);
  assert.match(message, /Realized PnL: 0.015 SOL/);
  assert.match(message, /Realized PnL: \+15.00%/);
  assert.match(message, /TAKE_PROFIT_TRIGGERED/);
  const daily = formatDailySummary({
    dateAsiaJakarta: "2026-11-03",
    mode: "PAPER",
    summary: {
      discoveries: 12,
      createdTokens: 10,
      migrations: 2,
      buys: 3,
      sells: 2,
      winningSells: 1,
      realizedPnlLamports: "10000000",
      openPositions: 1,
    },
  });
  assert.match(daily, /Discoveries: 12/);
  assert.match(daily, /Win rate: 50.0%/);
  assert.match(daily, /Realized PnL: 0.01 SOL/);
});
