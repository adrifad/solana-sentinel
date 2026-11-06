import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "@sentinel/config";
import type { QuoteResult } from "@sentinel/domain";
import {
  PaperTradingEngine,
  paperExecutionConfigFromAppConfig,
} from "@sentinel/paper";
import { SentinelStore } from "@sentinel/storage";
import { parsePumpPortalMessage } from "@sentinel/providers";
import { PaperRuntime } from "../apps/worker/src/paper-runtime.ts";

test("PAPER runtime initializes and recovers only virtual wallet state without quote provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-paper-runtime-"));
  const path = join(directory, "paper.db");
  const config = (await loadConfig({ APP_MODE: "PAPER" })).config;
  const firstStore = new SentinelStore(path);
  await firstStore.open();
  const firstRuntime = new PaperRuntime({
    store: firstStore,
    config,
    configVersion: "a".repeat(64),
  });
  try {
    await firstRuntime.start();
    const state = firstStore.getPaperPortfolioState(config.paper.wallet_id);
    assert.equal(state.solBalanceRaw, "10000000000");
    assert.equal(firstRuntime.readiness().automaticEntriesEnabled, false);
    assert.equal(firstRuntime.readiness().openPositions, 0);
    await firstRuntime.stop();
  } finally {
    await firstRuntime.stop();
    firstStore.close();
  }

  const restartedStore = new SentinelStore(path);
  await restartedStore.open();
  const restartedRuntime = new PaperRuntime({
    store: restartedStore,
    config,
    configVersion: "a".repeat(64),
  });
  try {
    await restartedRuntime.start();
    assert.equal(
      restartedStore.getPaperPortfolioState(config.paper.wallet_id)
        .solBalanceRaw,
      "10000000000",
    );
    assert.equal(
      restartedStore.listPaperLedgerEntries(config.paper.wallet_id).length,
      2,
    );
  } finally {
    await restartedRuntime.stop();
    restartedStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("automatic entry scheduler wakes independently from the position monitor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-paper-entry-wake-"));
  const store = new SentinelStore(join(directory, "paper.db"));
  await store.open();
  const config = (await loadConfig({ APP_MODE: "PAPER" })).config;
  config.paper.automatic_entries_enabled = true;
  let tokenScans = 0;
  const listTokens = store.listTokens.bind(store);
  store.listTokens = ((...args: Parameters<typeof store.listTokens>) => {
    tokenScans += 1;
    return listTokens(...args);
  }) as typeof store.listTokens;
  const runtime = new PaperRuntime({
    store,
    config,
    configVersion: "c".repeat(64),
  });
  try {
    await runtime.start();
    tokenScans = 0;
    await runtime.tick();
    assert.equal(tokenScans, 0);
    await runtime.wakeEntries("TEST_DECISION_PERSISTED");
    assert.equal(tokenScans, 1);
  } finally {
    await runtime.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("disabled automatic entry scheduler persists a visible candidate reason", async () => {
  const fixture = JSON.parse(
    await readFile("tests/fixtures/pumpportal-created.synthetic.json", "utf8"),
  ) as unknown;
  const event = parsePumpPortalMessage(fixture);
  const directory = await mkdtemp(
    join(tmpdir(), "sentinel-entry-diagnostics-"),
  );
  const store = new SentinelStore(join(directory, "paper.db"));
  await store.open();
  const config = (await loadConfig({ APP_MODE: "PAPER" })).config;
  const runtime = new PaperRuntime({
    store,
    config,
    configVersion: "d".repeat(64),
  });
  try {
    store.ingestEvent(event, 20, true, 120);
    await runtime.start();
    const evaluation = store.getLatestPaperEntryEvaluation(event.mint);
    assert.equal(evaluation?.status, "NOT_ATTEMPTED");
    assert.equal(evaluation?.reasonCode, "AUTOMATIC_ENTRIES_DISABLED");
    assert.equal(evaluation?.orderAttemptCount, 0);
  } finally {
    await runtime.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("enabled automatic entry scheduler records a missing-decision skip", async () => {
  const fixture = JSON.parse(
    await readFile("tests/fixtures/pumpportal-created.synthetic.json", "utf8"),
  ) as unknown;
  const event = parsePumpPortalMessage(fixture);
  const directory = await mkdtemp(join(tmpdir(), "sentinel-entry-skip-"));
  const store = new SentinelStore(join(directory, "paper.db"));
  await store.open();
  const config = (await loadConfig({ APP_MODE: "PAPER" })).config;
  config.paper.automatic_entries_enabled = true;
  const runtime = new PaperRuntime({
    store,
    config,
    configVersion: "e".repeat(64),
  });
  try {
    store.ingestEvent(event, 20, true, 120);
    await runtime.start();
    const evaluation = store.getLatestPaperEntryEvaluation(event.mint);
    assert.equal(evaluation?.status, "SKIPPED");
    assert.equal(evaluation?.reasonCode, "RISK_DECISION_NOT_FOUND");
    assert.equal(evaluation?.orderAttemptCount, 0);
  } finally {
    await runtime.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("PAPER runtime monitors a fixture-backed position and settles a virtual take-profit exit", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "sentinel-paper-exit-runtime-"),
  );
  const store = new SentinelStore(join(directory, "paper.db"));
  await store.open();
  const config = (await loadConfig({ APP_MODE: "PAPER" })).config;
  config.paper.execution_latency_ms = 0;
  const provider = {
    async quoteAtArrival(request: {
      mint: string;
      side: "BUY" | "SELL";
      exactInputAmountRaw: string;
      requestedAtUtc: string;
    }): Promise<QuoteResult> {
      const requestedAtMs = Date.parse(request.requestedAtUtc);
      return {
        id: `runtime:${request.side}:${requestedAtMs}`,
        mint: request.mint,
        direction: request.side,
        exactInputAmountRaw: request.exactInputAmountRaw,
        expectedOutputAmountRaw:
          request.side === "BUY" ? "1000000" : "20000000",
        inputMint:
          request.side === "BUY"
            ? "So11111111111111111111111111111111111111112"
            : request.mint,
        outputMint:
          request.side === "BUY"
            ? request.mint
            : "So11111111111111111111111111111111111111112",
        venue: "PUMP_BONDING_CURVE",
        source: "synthetic-runtime-test-quote",
        snapshotSlot: 100,
        snapshotAtUtc: new Date(requestedAtMs - 10).toISOString(),
        feeAmountRaw: "0",
        feeMint: "So11111111111111111111111111111111111111112",
        feeModel: "synthetic-no-fee",
        priceImpactBps: 10,
        liquidityQuoteRaw: "100000000000",
        freshnessMs: 10,
        validationStatus: "PASS",
        failureReason: null,
        evidenceRefs: ["synthetic:paper-runtime-quote"],
        provenance: { fixture: "synthetic" },
        observedAtUtc: request.requestedAtUtc,
      };
    },
  };
  const walletId = config.paper.wallet_id;
  const seeder = new PaperTradingEngine({
    repository: store,
    quotes: provider,
    config: paperExecutionConfigFromAppConfig(config),
  });
  seeder.initializeWallet(walletId, config.paper.initial_sol);
  const createdAtUtc = new Date().toISOString();
  const buy = await seeder.execute({
    id: "synthetic-runtime-entry",
    idempotencyKey: "synthetic-runtime-entry",
    walletId,
    mode: "PAPER",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    side: "BUY",
    exactInputAmountRaw: "10000000",
    decisionId: "synthetic-decision",
    reasonCodes: ["SYNTHETIC_TEST_SIGNAL"],
    createdAtUtc,
    signalQuoteId: null,
  });
  assert.equal(buy.order.status, "SIMULATED_FILLED");
  const balanceBeforeExit =
    store.getPaperPortfolioState(walletId).solBalanceRaw;
  const runtime = new PaperRuntime({
    store,
    config,
    configVersion: "b".repeat(64),
    quotes: provider,
  });
  try {
    await runtime.start();
    const portfolio = store.getPaperPortfolioState(walletId);
    assert.equal(portfolio.positions.length, 0);
    assert.ok(BigInt(portfolio.solBalanceRaw) > BigInt(balanceBeforeExit));
    assert.ok(BigInt(portfolio.realizedPnl.at(-1)?.pnlLamports ?? "0") > 0n);
    assert.equal(
      store.getPaperPositionMonitorState(walletId, buy.order.mint)?.status,
      "CLOSED",
    );
  } finally {
    await runtime.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
