import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "@sentinel/config";
import { analyzeLaunchBehavior } from "@sentinel/intelligence";
import { base58Encode } from "@sentinel/domain";
import type { QuoteResult } from "@sentinel/domain";
import {
  PaperTradingEngine,
  paperExecutionConfigFromAppConfig,
} from "@sentinel/paper";
import { SentinelStore } from "@sentinel/storage";
import { parsePumpPortalMessage } from "@sentinel/providers";
import { PaperRuntime } from "../apps/worker/src/paper-runtime.ts";
import { computeAdaptivePositionMonitorDelayMs } from "../apps/worker/src/paper-runtime.ts";

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

test("candidate wake evaluates only its mint and queues concurrent candidate wakes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-paper-entry-wake-"));
  const store = new SentinelStore(join(directory, "paper.db"));
  await store.open();
  const config = (await loadConfig({ APP_MODE: "PAPER" })).config;
  config.paper.automatic_entries_enabled = true;
  let tokenScans = 0;
  const evaluatedMints: string[] = [];
  const evaluatedReasons: string[] = [];
  const listTokens = store.listTokens.bind(store);
  store.listTokens = ((...args: Parameters<typeof store.listTokens>) => {
    tokenScans += 1;
    return listTokens(...args);
  }) as typeof store.listTokens;
  const recordEvaluation = store.recordPaperEntryEvaluation.bind(store);
  store.recordPaperEntryEvaluation = ((
    input: Parameters<typeof store.recordPaperEntryEvaluation>[0],
  ) => {
    evaluatedMints.push(input.mint);
    if (input.reasonCode) evaluatedReasons.push(input.reasonCode);
    return recordEvaluation(input);
  }) as typeof store.recordPaperEntryEvaluation;
  const runtime = new PaperRuntime({
    store,
    config,
    configVersion: "c".repeat(64),
  });
  try {
    const fixture = JSON.parse(
      await readFile(
        "tests/fixtures/pumpportal-created.synthetic.json",
        "utf8",
      ),
    ) as Record<string, unknown>;
    const first = parsePumpPortalMessage(fixture);
    const second = parsePumpPortalMessage({
      ...fixture,
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      signature: base58Encode(Buffer.alloc(64, 1)),
    });
    store.ingestEvent(first, 20, true, -1);
    store.ingestEvent(second, 20, true, -1);
    await runtime.start();
    tokenScans = 0;
    evaluatedMints.length = 0;
    evaluatedReasons.length = 0;
    config.paper.automatic_entries_enabled = true;
    await runtime.tick();
    assert.equal(tokenScans, 0);
    await Promise.all([
      runtime.wakeEntries("DECISION_PERSISTED", first.mint),
      runtime.wakeEntries("DECISION_PERSISTED", second.mint),
    ]);
    assert.equal(tokenScans, 0);
    assert.deepEqual(
      new Set(evaluatedMints),
      new Set([first.mint, second.mint]),
    );
    assert.ok(
      evaluatedReasons.every(
        (reason) => reason !== "MONITORING_LEASE_INACTIVE",
      ),
    );
    assert.ok(
      evaluatedReasons.every((reason) => reason === "RISK_DECISION_NOT_FOUND"),
    );
  } finally {
    await runtime.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("exit monitoring cadence adapts to remaining Helius request budget", () => {
  const input = {
    baseIntervalMs: 15_000,
    maxIntervalMs: 900_000,
    openPositions: 2,
    estimatedRpcRequestsPerPosition: 4,
    remainingRpcRequests: 200,
    untilBudgetResetMs: 12 * 60 * 60 * 1000,
  };
  assert.equal(
    computeAdaptivePositionMonitorDelayMs({
      ...input,
      remainingRpcRequests: 0,
    }),
    input.maxIntervalMs,
  );
  assert.ok(
    computeAdaptivePositionMonitorDelayMs(input) > input.baseIntervalMs,
  );
  assert.equal(
    computeAdaptivePositionMonitorDelayMs({
      ...input,
      remainingRpcRequests: 100_000,
    }),
    input.baseIntervalMs,
  );
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

test("explicit experimental policy can run a virtual cycle on verified partial fixture evidence", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "sentinel-experimental-paper-"),
  );
  const store = new SentinelStore(join(directory, "paper.db"));
  await store.open();
  const loaded = await loadConfig({ APP_MODE: "PAPER" });
  const config = structuredClone(loaded.config);
  config.paper.automatic_entries_enabled = true;
  config.paper.experimental_entries_enabled = true;
  config.paper.execution_latency_ms = 0;
  config.paper.max_quote_age_ms = 5_000;
  config.paper.position_monitor_interval_ms = 900_000;
  config.paper.position_monitor_max_interval_ms = 900_000;
  config.security.max_snapshot_age_ms = 10_000;
  const launchedAtMs = Date.now() - 90_000;
  const event = parsePumpPortalMessage(
    JSON.parse(
      await readFile(
        "tests/fixtures/pumpportal-created.synthetic.json",
        "utf8",
      ),
    ) as Record<string, unknown>,
    launchedAtMs,
  );
  const now = new Date().toISOString();
  const creator = "11111111111111111111111111111111";
  store.ingestEvent(event, 20, true, 120);
  store.saveWalletRoleEvidence({
    id: "experimental-fixture-creator-role",
    mint: event.mint,
    wallet: creator,
    role: "CLAIMED_CREATOR",
    source: "PUMP_IDL_CREATE_EVENT",
    signature: event.txSignature ?? null,
    slot: event.slot ?? 341197053,
    observedAtUtc: now,
    confidenceBps: 10000,
    reasonCode: "ONCHAIN_CREATE_EVENT_VERIFIED",
  });
  store.saveCreatorReputation({
    wallet: creator,
    status: "KNOWN",
    launchesObserved: 1,
    suspiciousIndicators: [],
    confidenceBps: 9500,
    historyComplete: true,
    asOfSlot: 341197053,
    computedAtUtc: now,
    freshUntilUtc: new Date(Date.now() + 60_000).toISOString(),
    evidenceRefs: ["synthetic:creator-history"],
  });
  const observations = Array.from({ length: 3 }, (_, index) => ({
    id: `experimental-trade-${index}`,
    eventIndex: 0,
    mint: event.mint,
    signature: `experimental-signature-${index}`,
    slot: 341197054 + index,
    blockTimeUtc: now,
    eventTimeUtc: now,
    eventTimeSource: "PUMP_TRADE_EVENT_TIMESTAMP" as const,
    receivedAtUtc: now,
    ingestedAtUtc: now,
    side: "BUY" as const,
    traderWallet: `1111111111111111111111111111111${index + 2}`,
    tokenAmountRaw: "1000000",
    quoteAmountRaw: "10000000",
    quoteMint: "So11111111111111111111111111111111111111112",
    venue: "PUMP_BONDING_CURVE" as const,
    source: "synthetic-offline-integration-fixture",
    decoderVersion: "SYNTHETIC_FIXTURE",
    validationStatus: "VERIFIED" as const,
    validationConfidenceBps: 10000,
    payloadRef: `sha256:${createHash("sha256").update(`experimental-${index}`).digest("hex")}`,
  }));
  for (const observation of observations)
    store.saveLaunchTradeObservation(observation);
  const behavior = analyzeLaunchBehavior({
    mint: event.mint,
    observations,
    creatorWallets: [creator],
    linkedWallets: [],
    windowStartedAtUtc: event.firstSeenAtUtc,
    observedAtUtc: now,
    windowSeconds: 60,
    throughSlot: 341197056,
    complete: false,
    gapReason: "TRADE_STREAM_COMPLETENESS_UNVERIFIED",
    minIndependentBuyers: 3,
    metadataLikelyTest: false,
  });
  store.saveLaunchBehaviorSnapshot(behavior);
  store.recordTradeObservationCoverage({
    mint: event.mint,
    source: "synthetic-offline-integration-fixture",
    status: "UNVERIFIED",
    windowStartedAtUtc: event.firstSeenAtUtc,
    windowExpiresAtUtc: new Date(launchedAtMs + 60_000).toISOString(),
    lastEventAtUtc: now,
    reconnectCount: 1,
    reasonCode: "TRADE_STREAM_COMPLETENESS_UNVERIFIED",
    updatedAtUtc: now,
  });
  store.saveTokenRiskReport({
    id: "experimental-fixture-security",
    mint: event.mint,
    status: "SUPPORTED",
    programId: creator,
    mintAuthority: null,
    freezeAuthority: null,
    supplyRaw: "1000000000",
    decimals: 6,
    extensions: [],
    topHolderConcentrationBps: 500,
    creatorConcentrationRaw: "0",
    clusterConcentrationRaw: "0",
    holderSampleCount: 10,
    holderSampleComplete: false,
    holderSampleCoverageBps: 9500,
    holderSampleValidated: true,
    testTokenClassification: "UNKNOWN",
    testTokenConfidenceBps: 0,
    reasonCodes: [],
    source: "HELIUS_RPC",
    asOfSlot: 341197056,
    observedAtUtc: now,
    confidenceBps: 9500,
    evidenceRefs: ["synthetic:security-state"],
  });
  store.saveRiskDecision({
    id: "experimental-fixture-quarantine",
    mint: event.mint,
    status: "QUARANTINE",
    reasonCodes: [
      "BUY_AND_SELL_QUOTES_VALIDATED",
      "LAUNCH_BEHAVIOR_INCOMPLETE",
      "TRADE_STREAM_COMPLETENESS_UNVERIFIED",
      "VALIDATED_HOLDER_SAMPLE_COVERAGE_POLICY_PASSED",
    ],
    configVersion: loaded.configVersion,
    evidenceRefs: [
      `launch_behavior:${behavior.id}`,
      ...behavior.evidenceRefs,
      "synthetic:creator-history",
      "synthetic:security-state",
      "wallet_role_evidence:experimental-fixture-creator-role",
    ],
    securityReportId: "experimental-fixture-security",
    decidedAtUtc: now,
    latencyMs: 8,
  });
  let exitQuoteValue = "12000000";
  const quoteProvider = {
    async quoteAtArrival(request: {
      mint: string;
      side: "BUY" | "SELL";
      exactInputAmountRaw: string;
      requestedAtUtc: string;
    }): Promise<QuoteResult> {
      return {
        id: `synthetic-${request.side}-${request.exactInputAmountRaw}-${Date.now()}`,
        mint: request.mint,
        direction: request.side,
        exactInputAmountRaw: request.exactInputAmountRaw,
        expectedOutputAmountRaw:
          request.side === "BUY" ? "1000000000" : exitQuoteValue,
        inputMint:
          request.side === "BUY"
            ? "So11111111111111111111111111111111111111112"
            : request.mint,
        outputMint:
          request.side === "BUY"
            ? request.mint
            : "So11111111111111111111111111111111111111112",
        venue: "PUMP_BONDING_CURVE",
        source: "synthetic-offline-quote-fixture",
        snapshotSlot: 341197056,
        snapshotAtUtc: new Date(
          Date.parse(request.requestedAtUtc) - 10,
        ).toISOString(),
        feeAmountRaw: "1000",
        feeMint:
          request.side === "BUY"
            ? "So11111111111111111111111111111111111111112"
            : request.mint,
        feeModel: "synthetic fixture fee",
        priceImpactBps: 25,
        liquidityQuoteRaw: "1000000000",
        freshnessMs: 10,
        validationStatus: "PASS",
        failureReason: null,
        evidenceRefs: ["synthetic:market-snapshot"],
        provenance: { fixture: "synthetic-offline" },
        observedAtUtc: new Date().toISOString(),
      };
    },
  };
  const runtime = new PaperRuntime({
    store,
    config,
    configVersion: loaded.configVersion,
    quotes: quoteProvider,
  });
  try {
    await runtime.start();
    const entered = store.getPaperPortfolioState(config.paper.wallet_id);
    assert.equal(entered.positions.length, 1);
    const evaluation = store.getLatestPaperEntryEvaluation(event.mint);
    assert.equal(evaluation?.decisionStatus, "QUARANTINE");
    assert.equal(evaluation?.evidence["entryPolicy"], "PAPER_EXPERIMENTAL");
    exitQuoteValue = "15000000";
    await runtime.tick();
    const closed = store.getPaperPortfolioState(config.paper.wallet_id);
    assert.equal(closed.positions.length, 0);
    assert.equal(closed.realizedPnl.length, 1);
    assert.ok(BigInt(closed.realizedPnl[0]?.pnlLamports ?? "0") > 0n);
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
