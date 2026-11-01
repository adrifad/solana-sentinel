import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "@sentinel/config";
import { analyzeLaunchBehavior } from "@sentinel/intelligence";
import { paperPositionId } from "@sentinel/domain";
import type { QuoteResult } from "@sentinel/domain";
import { parsePumpPortalMessage } from "@sentinel/providers";
import { solToLamports } from "@sentinel/paper";
import { SentinelStore } from "@sentinel/storage";
import { createApiServer } from "@sentinel/api";
import { PaperRuntime } from "../apps/worker/src/paper-runtime.ts";

const tokenFixture = JSON.parse(
  await readFile("tests/fixtures/pumpportal-created.synthetic.json", "utf8"),
) as Record<string, unknown>;
const wsol = "So11111111111111111111111111111111111111112";
const creator = "11111111111111111111111111111111";

test("manual PAPER BUY then SELL settles virtual balances, position and realized PnL from fixture quotes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentinel-manual-paper-"));
  const store = new SentinelStore(join(dir, "test.sqlite"));
  await store.open();
  const loaded = await loadConfig({ APP_MODE: "PAPER" });
  const config = structuredClone(loaded.config);
  config.paper.execution_latency_ms = 0;
  config.paper.exit_retry_base_ms = 1000;
  config.paper.exit_retry_max_ms = 1000;
  config.paper.max_quote_age_ms = 5000;
  config.security.max_snapshot_age_ms = 10000;
  const event = parsePumpPortalMessage(tokenFixture, Date.now());
  store.ingestEvent(event, 20, false);
  const now = new Date().toISOString();
  store.saveWalletRoleEvidence({
    id: "synthetic-create-role",
    mint: event.mint,
    wallet: creator,
    role: "CLAIMED_CREATOR",
    source: "PUMP_IDL_CREATE_EVENT",
    signature: event.txSignature ?? null,
    slot: event.slot ?? null,
    observedAtUtc: now,
    confidenceBps: 10000,
    reasonCode: "ONCHAIN_CREATE_EVENT_VERIFIED",
  });
  store.saveCreatorReputation({
    wallet: creator,
    status: "KNOWN",
    launchesObserved: 1,
    suspiciousIndicators: [],
    confidenceBps: 9000,
    historyComplete: true,
    asOfSlot: 100,
    computedAtUtc: now,
    freshUntilUtc: new Date(Date.now() + 60_000).toISOString(),
    evidenceRefs: ["synthetic:creator-history"],
  });
  const observations = Array.from({ length: 3 }, (_, index) => ({
    id: `synthetic-trade-${index}`,
    eventIndex: 0,
    mint: event.mint,
    signature: `synthetic-signature-${index}`,
    slot: 101 + index,
    blockTimeUtc: now,
    eventTimeUtc: now,
    eventTimeSource: "PUMP_TRADE_EVENT_TIMESTAMP" as const,
    receivedAtUtc: now,
    ingestedAtUtc: now,
    side: "BUY" as const,
    traderWallet: `1111111111111111111111111111111${index + 2}`,
    tokenAmountRaw: "1000000",
    quoteAmountRaw: "10000000",
    quoteMint: wsol,
    venue: "PUMP_BONDING_CURVE" as const,
    source: "synthetic-contract-fixture",
    decoderVersion: "SYNTHETIC_FIXTURE",
    validationStatus: "VERIFIED" as const,
    validationConfidenceBps: 10000,
    payloadRef: `sha256:${createHash("sha256").update(`fixture-${index}`).digest("hex")}`,
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
    throughSlot: 103,
    complete: false,
    gapReason: "TRADE_STREAM_COMPLETENESS_UNVERIFIED",
    minIndependentBuyers: 3,
    metadataLikelyTest: false,
  });
  store.saveLaunchBehaviorSnapshot(behavior);
  store.recordTradeObservationCoverage({
    mint: event.mint,
    source: "synthetic",
    status: "UNVERIFIED",
    windowStartedAtUtc: event.firstSeenAtUtc,
    windowExpiresAtUtc: new Date(Date.now() + 30_000).toISOString(),
    lastEventAtUtc: now,
    reconnectCount: 0,
    reasonCode: "TRADE_STREAM_COMPLETENESS_UNVERIFIED",
    updatedAtUtc: now,
  });
  const securityId = "synthetic-security-report";
  store.saveTokenRiskReport({
    id: securityId,
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
    asOfSlot: 103,
    observedAtUtc: now,
    confidenceBps: 9500,
    evidenceRefs: ["synthetic:security-snapshot"],
  });
  store.saveRiskDecision({
    id: "synthetic-quarantine-coverage-only",
    mint: event.mint,
    status: "QUARANTINE",
    reasonCodes: [
      "BUY_AND_SELL_QUOTES_VALIDATED",
      "LAUNCH_BEHAVIOR_INCOMPLETE",
      "VALIDATED_HOLDER_SAMPLE_COVERAGE_POLICY_PASSED",
    ],
    configVersion: loaded.configVersion,
    evidenceRefs: [
      `launch_behavior:${behavior.id}`,
      ...behavior.evidenceRefs,
      "synthetic:creator-history",
      "synthetic:security-snapshot",
      "wallet_role_evidence:synthetic-create-role",
    ],
    securityReportId: securityId,
    decidedAtUtc: now,
    latencyMs: 12,
  });
  const quoteProvider = {
    quoteAvailable: true,
    rateLimitOnce: true,
    async quoteAtArrival(request: {
      mint: string;
      side: "BUY" | "SELL";
      exactInputAmountRaw: string;
      requestedAtUtc: string;
    }): Promise<QuoteResult | null> {
      if (!this.quoteAvailable) return null;
      await new Promise((resolve) => setTimeout(resolve, 200));
      const time = Date.parse(request.requestedAtUtc);
      const quote: QuoteResult = {
        id: `synthetic-quote-${request.side}-${request.exactInputAmountRaw}-${time}`,
        mint: request.mint,
        direction: request.side,
        exactInputAmountRaw: request.exactInputAmountRaw,
        expectedOutputAmountRaw:
          request.side === "BUY" ? "1000000000" : "20000000",
        inputMint: request.side === "BUY" ? wsol : request.mint,
        outputMint: request.side === "BUY" ? request.mint : wsol,
        venue: "PUMP_BONDING_CURVE",
        source: "synthetic-quote-fixture",
        snapshotSlot: 103,
        snapshotAtUtc: new Date(time - 10).toISOString(),
        feeAmountRaw: "1000",
        feeMint: wsol,
        feeModel: "synthetic fixture fee",
        priceImpactBps: 25,
        liquidityQuoteRaw: "1000000000",
        freshnessMs: 10,
        validationStatus: "PASS",
        failureReason: null,
        evidenceRefs: ["synthetic:market-snapshot"],
        provenance: { fixture: "synthetic" },
        observedAtUtc: new Date().toISOString(),
      };
      if (this.rateLimitOnce) {
        this.rateLimitOnce = false;
        return {
          ...quote,
          expectedOutputAmountRaw: null,
          validationStatus: "FAIL",
          failureReason: "RATE_LIMITED",
        };
      }
      return quote;
    },
  };
  const walletId = config.paper.wallet_id;
  const runtime = new PaperRuntime({
    store,
    config,
    configVersion: loaded.configVersion,
    quotes: quoteProvider,
  });
  try {
    store.initializePaperAccount(
      walletId,
      solToLamports(config.paper.initial_sol),
      now,
    );
    const queued = store.createManualPaperRequest({
      id: "manual-entry-fixture",
      idempotencyKey: "manual-entry-fixture-key",
      requestType: "ENTRY",
      walletId,
      mint: event.mint,
      requestedAmountRaw: solToLamports("0.01"),
      requestedSizeSol: "0.01",
      originalCoverageStatus: "UNVERIFIED",
      createdAtUtc: now,
    });
    assert.equal(queued.status, "PENDING");
    const claimed = store.claimManualPaperRequest(walletId, now);
    assert.equal(claimed?.status, "PROCESSING");
    const recoveredManualOrderId = createHash("sha256")
      .update(`manual-paper-order:${queued.id}:${claimed?.attempts}`)
      .digest("hex");
    store.createPaperOrder({
      id: recoveredManualOrderId,
      idempotencyKey: recoveredManualOrderId,
      walletId,
      mode: "PAPER",
      mint: event.mint,
      side: "BUY",
      exactInputAmountRaw: solToLamports("0.01"),
      decisionId: "synthetic-quarantine-coverage-only",
      reasonCodes: ["MANUAL_ENTRY", "MANUAL_COVERAGE_EXCEPTION"],
      createdAtUtc: now,
      signalQuoteId: null,
      entrySource: "MANUAL",
    });
    store.setManualPaperExecutionOrder(queued.id, recoveredManualOrderId);
    // Simulate restart after the request and idempotent order were claimed.
    await runtime.start();
    await waitForRequest(store, queued.id, "FILLED");
    assert.equal(store.getManualPaperRequest(queued.id)?.attempts, 3);
    const portfolioAfterBuy = store.getPaperPortfolioState(walletId);
    assert.equal(portfolioAfterBuy.positions.length, 1);
    assert.ok(
      BigInt(portfolioAfterBuy.positions[0]?.tokenAmountRaw ?? "0") > 0n,
    );
    assert.ok(
      BigInt(portfolioAfterBuy.positions[0]?.tokenAmountRaw ?? "0") <
        1_000_000_000n,
    );
    assert.equal(
      store.getManualPaperRequest(queued.id)?.coverageExceptionReason,
      "MANUAL_ENTRY_ACCEPTED_UNVERIFIED_STREAM_COVERAGE",
    );
    assert.equal(
      store.listRiskDecisions(event.mint, 1)[0]?.status,
      "QUARANTINE",
    );
    const positionId = paperPositionId(walletId, event.mint);
    const beforeUnavailableExit = store.getPaperPortfolioState(walletId);
    quoteProvider.quoteAvailable = false;
    const unavailableExit = store.createManualPaperRequest({
      id: "manual-exit-unavailable-fixture",
      idempotencyKey: "manual-exit-unavailable-fixture-key",
      requestType: "EXIT",
      walletId,
      mint: event.mint,
      positionId,
      requestedAmountRaw: beforeUnavailableExit.positions[0]!.tokenAmountRaw,
      createdAtUtc: new Date().toISOString(),
    });
    await waitForRequest(store, unavailableExit.id, "UNFILLABLE");
    const unchanged = store.getPaperPortfolioState(walletId);
    assert.equal(unchanged.solBalanceRaw, beforeUnavailableExit.solBalanceRaw);
    assert.equal(
      unchanged.positions[0]?.tokenAmountRaw,
      beforeUnavailableExit.positions[0]?.tokenAmountRaw,
    );
    quoteProvider.quoteAvailable = true;
    const exit = store.createManualPaperRequest({
      id: "manual-exit-fixture",
      idempotencyKey: "manual-exit-fixture-key",
      requestType: "EXIT",
      walletId,
      mint: event.mint,
      positionId,
      requestedAmountRaw: unchanged.positions[0]!.tokenAmountRaw,
      createdAtUtc: new Date().toISOString(),
    });
    await waitForRequest(store, exit.id, "FILLED");
    const finalState = store.getPaperPortfolioState(walletId);
    assert.equal(finalState.positions.length, 0);
    assert.ok(BigInt(finalState.solBalanceRaw) > 10_000_000_000n - 10_000_000n);
    assert.ok(BigInt(finalState.realizedPnl.at(-1)?.pnlLamports ?? "0") > 0n);
    const entryOrder = store.getPaperOrder(
      store.getManualPaperRequest(queued.id)?.executionOrderId ?? "",
    );
    assert.equal(entryOrder?.entrySource, "MANUAL");
    assert.equal(
      store.getPaperFill(entryOrder?.id ?? "")?.["entrySource"],
      "MANUAL",
    );
    assert.equal(store.listPaperLedgerEntries(walletId).length % 2, 0);

    const queueAnotherManualEntry = (id: string) => {
      const createdAtUtc = new Date().toISOString();
      return store.createManualPaperRequest({
        id,
        idempotencyKey: `${id}-idempotency`,
        requestType: "ENTRY",
        walletId,
        mint: event.mint,
        requestedAmountRaw: solToLamports("0.01"),
        requestedSizeSol: "0.01",
        originalCoverageStatus: "UNVERIFIED",
        createdAtUtc,
        expiresAtUtc: new Date(Date.now() + 5000).toISOString(),
      });
    };
    store.saveCreatorReputation({
      wallet: creator,
      status: "SUSPICIOUS",
      launchesObserved: 2,
      suspiciousIndicators: ["REPEATED_SUSPICIOUS_LAUNCH_PATTERN"],
      confidenceBps: 9000,
      historyComplete: true,
      asOfSlot: 104,
      computedAtUtc: new Date().toISOString(),
      freshUntilUtc: new Date(Date.now() + 60_000).toISOString(),
      evidenceRefs: ["synthetic:creator-history"],
    });
    const unsafeCreatorRequest = queueAnotherManualEntry(
      "manual-unsafe-creator",
    );
    await waitForRequest(store, unsafeCreatorRequest.id, "REJECTED");
    assert.equal(
      store.getManualPaperRequest(unsafeCreatorRequest.id)?.reasonCode,
      "CREATOR_REPUTATION_UNSAFE_OR_INCOMPLETE",
    );

    store.saveCreatorReputation({
      wallet: creator,
      status: "KNOWN",
      launchesObserved: 1,
      suspiciousIndicators: [],
      confidenceBps: 9000,
      historyComplete: true,
      asOfSlot: 105,
      computedAtUtc: new Date().toISOString(),
      freshUntilUtc: new Date(Date.now() + 60_000).toISOString(),
      evidenceRefs: ["synthetic:creator-history"],
    });
    const validSecurity = store.getLatestTokenRiskReport(event.mint)!;
    const incompleteHolderSecurity = {
      ...validSecurity,
      id: "synthetic-security-incomplete-holder",
      asOfSlot: 104,
      holderSampleValidated: false,
      holderSampleCoverageBps: 0,
      observedAtUtc: new Date().toISOString(),
    };
    store.saveTokenRiskReport(incompleteHolderSecurity);
    const beforeHolderDecision = store.listRiskDecisions(event.mint, 1)[0]!;
    store.saveRiskDecision({
      ...beforeHolderDecision,
      id: "synthetic-incomplete-holder-decision",
      securityReportId: incompleteHolderSecurity.id,
      decidedAtUtc: new Date(Date.now() - 100).toISOString(),
      reasonCodes: [
        "LAUNCH_BEHAVIOR_INCOMPLETE",
        "BUY_AND_SELL_QUOTES_VALIDATED",
      ],
    });
    const incompleteHolderRequest = queueAnotherManualEntry(
      "manual-incomplete-holder",
    );
    await waitForRequest(store, incompleteHolderRequest.id, "REJECTED");
    assert.equal(
      store.getManualPaperRequest(incompleteHolderRequest.id)?.reasonCode,
      "HOLDER_EVIDENCE_INSUFFICIENT",
    );

    const restoredSecurity = {
      ...validSecurity,
      id: "synthetic-security-restored",
      asOfSlot: 105,
      observedAtUtc: new Date().toISOString(),
    };
    store.saveTokenRiskReport(restoredSecurity);
    const beforeExitDecision = store.listRiskDecisions(event.mint, 1)[0]!;
    store.saveRiskDecision({
      ...beforeExitDecision,
      id: "synthetic-failed-exit-decision",
      securityReportId: restoredSecurity.id,
      decidedAtUtc: new Date(Date.now() - 100).toISOString(),
      reasonCodes: [
        "BUY_AND_SELL_QUOTES_VALIDATED",
        "LAUNCH_BEHAVIOR_INCOMPLETE",
        "VALIDATED_HOLDER_SAMPLE_COVERAGE_POLICY_PASSED",
        "EXIT_VALIDATION_FAILED",
      ],
    });
    const failedExitRequest = queueAnotherManualEntry(
      "manual-failed-exit-validation",
    );
    await waitForRequest(store, failedExitRequest.id, "REJECTED");
    assert.equal(
      store.getManualPaperRequest(failedExitRequest.id)?.reasonCode,
      "RISK_DECISION_HAS_UNVERIFIED_REASON_CODES",
    );
  } finally {
    await runtime.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("manual entry rejects a missing security report instead of applying the coverage exception", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentinel-manual-security-"));
  const store = new SentinelStore(join(dir, "test.sqlite"));
  await store.open();
  const loaded = await loadConfig({ APP_MODE: "PAPER" });
  const event = parsePumpPortalMessage(tokenFixture, Date.now());
  store.ingestEvent(event, 20, false);
  const now = new Date().toISOString();
  store.saveTokenRiskReport({
    id: "manual-missing-security-report",
    mint: event.mint,
    status: "MISSING",
    programId: null,
    mintAuthority: null,
    freezeAuthority: null,
    supplyRaw: null,
    decimals: null,
    extensions: [],
    topHolderConcentrationBps: null,
    creatorConcentrationRaw: null,
    clusterConcentrationRaw: null,
    holderSampleCount: 0,
    holderSampleComplete: false,
    testTokenClassification: "UNKNOWN",
    testTokenConfidenceBps: 0,
    reasonCodes: ["HELIUS_CREDENTIAL_MISSING"],
    source: "HELIUS_RPC",
    asOfSlot: null,
    observedAtUtc: now,
    confidenceBps: 0,
    evidenceRefs: ["missing:security-state"],
  });
  store.saveRiskDecision({
    id: "manual-missing-security-decision",
    mint: event.mint,
    status: "QUARANTINE",
    reasonCodes: ["LAUNCH_BEHAVIOR_INCOMPLETE"],
    configVersion: loaded.configVersion,
    evidenceRefs: [],
    securityReportId: "manual-missing-security-report",
    decidedAtUtc: now,
    latencyMs: 1,
  });
  const runtime = new PaperRuntime({
    store,
    config: loaded.config,
    configVersion: loaded.configVersion,
  });
  try {
    await runtime.start();
    const request = store.createManualPaperRequest({
      id: "manual-unsafe-entry",
      idempotencyKey: "manual-unsafe-entry-key",
      requestType: "ENTRY",
      walletId: loaded.config.paper.wallet_id,
      mint: event.mint,
      requestedAmountRaw: solToLamports("0.01"),
      requestedSizeSol: "0.01",
      originalCoverageStatus: "UNVERIFIED",
      createdAtUtc: now,
    });
    await waitForRequest(store, request.id, "REJECTED");
    assert.equal(
      store.getManualPaperRequest(request.id)?.reasonCode,
      "TOKEN_SECURITY_NOT_VERIFIED",
    );
    assert.equal(
      store.getPaperPortfolioState(loaded.config.paper.wallet_id).positions
        .length,
      0,
    );
  } finally {
    await runtime.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("manual requests have durable atomic claims and idempotent recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentinel-manual-queue-"));
  const store = new SentinelStore(join(dir, "test.sqlite"));
  await store.open();
  try {
    store.initializePaperAccount(
      "queue-wallet",
      "10000000000",
      new Date().toISOString(),
    );
    const request = store.createManualPaperRequest({
      id: "queue-request",
      idempotencyKey: "queue-idempotency",
      requestType: "ENTRY",
      walletId: "queue-wallet",
      mint: wsol,
      requestedAmountRaw: "1",
      requestedSizeSol: "0.000000001",
      createdAtUtc: new Date().toISOString(),
      expiresAtUtc: new Date(Date.now() + 10_000).toISOString(),
    });
    assert.ok(request.expiresAtUtc);
    const [first, second] = await Promise.all([
      Promise.resolve(
        store.claimManualPaperRequest("queue-wallet", new Date().toISOString()),
      ),
      Promise.resolve(
        store.claimManualPaperRequest("queue-wallet", new Date().toISOString()),
      ),
    ]);
    assert.equal([first, second].filter(Boolean).length, 1);
    assert.equal(
      store.recoverInterruptedManualPaperRequests(new Date().toISOString()),
      1,
    );
    assert.equal(store.getManualPaperRequest(request.id)?.status, "PENDING");
    assert.equal(
      store.createManualPaperRequest({
        id: "duplicate-id",
        idempotencyKey: "queue-idempotency",
        requestType: "ENTRY",
        walletId: "queue-wallet",
        mint: wsol,
        requestedAmountRaw: "1",
        requestedSizeSol: "0.000000001",
        createdAtUtc: new Date().toISOString(),
      }).id,
      request.id,
    );
    assert.throws(
      () =>
        store.createManualPaperRequest({
          id: "other-entry",
          idempotencyKey: "other-entry-key",
          requestType: "ENTRY",
          walletId: "queue-wallet",
          mint: wsol,
          requestedAmountRaw: "2",
          createdAtUtc: new Date().toISOString(),
        }),
      /MANUAL_PAPER_REQUEST_CONFLICT/,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("manual API requires bearer auth, PAPER mode, idempotency, and a stored mint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentinel-paper-api-"));
  const store = new SentinelStore(join(dir, "test.sqlite"));
  await store.open();
  const loaded = await loadConfig({ APP_MODE: "PAPER" });
  store.initializePaperAccount(
    loaded.config.paper.wallet_id,
    "10000000000",
    new Date().toISOString(),
  );
  store.ingestEvent(
    parsePumpPortalMessage(tokenFixture, Date.now()),
    20,
    false,
  );
  const server = createApiServer({
    store,
    mode: "PAPER",
    staleFeedSeconds: 30,
    tradeStreamEnabled: false,
    automaticEntriesEnabled: false,
    paperWalletId: loaded.config.paper.wallet_id,
    operatorToken: "t".repeat(40),
    maxTradeSol: "0.05",
    initialSol: "10",
    maxQuoteAgeMs: 1500,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/paper/entry`;
  try {
    const payload = JSON.stringify({ mint: wsol, sizeSol: "0.01" });
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "manual-api-test-1",
          },
          body: payload,
        })
      ).status,
      401,
    );
    const result = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${"t".repeat(40)}`,
        "content-type": "application/json",
        "idempotency-key": "manual-api-test-1",
      },
      body: payload,
    });
    assert.equal(result.status, 202);
    const queued = (await result.json()) as { requestId: string };
    const duplicate = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${"t".repeat(40)}`,
        "content-type": "application/json",
        "idempotency-key": "manual-api-test-1",
      },
      body: payload,
    });
    assert.equal(duplicate.status, 200);
    assert.equal(
      ((await duplicate.json()) as { requestId: string }).requestId,
      queued.requestId,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${"t".repeat(40)}`,
            "content-type": "application/json",
            "idempotency-key": "manual-api-test-2",
          },
          body: JSON.stringify({
            mint: wsol,
            sizeSol: "0.01",
            bypassRisk: true,
          }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${"t".repeat(40)}`,
            "content-type": "application/json",
            "idempotency-key": "manual-api-test-3",
          },
          body: JSON.stringify({ mint: wsol, sizeSol: "0.06" }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${"t".repeat(40)}`,
            "content-type": "application/json",
            "idempotency-key": "manual-api-test-4",
          },
          body: JSON.stringify({ mint: creator, sizeSol: "0.01" }),
        })
      ).status,
      404,
    );
    const status = await fetch(
      `http://127.0.0.1:${address.port}/api/paper/status`,
    );
    assert.equal(status.status, 200);
    const missingTokenServer = createApiServer({
      store,
      mode: "PAPER",
      staleFeedSeconds: 30,
      tradeStreamEnabled: false,
      automaticEntriesEnabled: false,
      paperWalletId: loaded.config.paper.wallet_id,
      maxTradeSol: "0.05",
      initialSol: "10",
      maxQuoteAgeMs: 1500,
    });
    await new Promise<void>((resolve) =>
      missingTokenServer.listen(0, "127.0.0.1", resolve),
    );
    const missingAddress = missingTokenServer.address();
    assert.ok(missingAddress && typeof missingAddress !== "string");
    try {
      assert.equal(
        (
          await fetch(
            `http://127.0.0.1:${missingAddress.port}/api/paper/entry`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "idempotency-key": "missing-operator-token",
              },
              body: payload,
            },
          )
        ).status,
        503,
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        missingTokenServer.close((error) =>
          error ? reject(error) : resolve(),
        ),
      );
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("manual PAPER writes are unavailable in DRY_RUN even with valid operator credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentinel-paper-mode-api-"));
  const store = new SentinelStore(join(dir, "test.sqlite"));
  await store.open();
  const server = createApiServer({
    store,
    mode: "DRY_RUN",
    staleFeedSeconds: 30,
    tradeStreamEnabled: false,
    automaticEntriesEnabled: false,
    paperWalletId: "dry-wallet",
    operatorToken: "d".repeat(40),
    maxTradeSol: "0.05",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/paper/entry`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${"d".repeat(40)}`,
          "content-type": "application/json",
          "idempotency-key": "dry-mode-write-test",
        },
        body: JSON.stringify({ mint: wsol, sizeSol: "0.01" }),
      },
    );
    assert.equal(response.status, 409);
    assert.equal(
      ((await response.json()) as { error: string }).error,
      "PAPER_MODE_REQUIRED",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("wallet initialization converts SOL once and reports configured balance mismatch without rewriting", async () => {
  assert.equal(solToLamports("10.0"), "10000000000");
  assert.equal(solToLamports("0.5"), "500000000");
  const dir = await mkdtemp(join(tmpdir(), "sentinel-paper-wallet-"));
  const store = new SentinelStore(join(dir, "test.sqlite"));
  await store.open();
  try {
    const first = store.initializePaperAccount(
      "wallet",
      "10000000000",
      new Date().toISOString(),
    );
    const restart = store.initializePaperAccount(
      "wallet",
      "500000000",
      new Date().toISOString(),
    );
    assert.equal(first.configuredInitialBalanceMatches, true);
    assert.equal(restart.configuredInitialBalanceMatches, false);
    assert.equal(restart.initialSolLamports, "10000000000");
    assert.equal(store.listPaperLedgerEntries("wallet").length, 2);
    assert.equal(
      store.getPaperPortfolioState("wallet").solBalanceRaw,
      "10000000000",
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function waitForRequest(
  store: SentinelStore,
  id: string,
  status: "FILLED" | "REJECTED" | "UNFILLABLE",
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (store.getManualPaperRequest(id)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    store.getManualPaperRequest(id)?.status,
    status,
    "manual request did not reach terminal state",
  );
}
