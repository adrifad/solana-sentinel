import assert from "node:assert/strict";
import test from "node:test";
import type { SentinelStore } from "@sentinel/storage";
import { getOperationalReadiness } from "@sentinel/api";

test("PAPER readiness remains blocked when stream coverage is unverified", () => {
  const now = new Date().toISOString();
  let exitReserve = 200;
  const store = {
    listProviderHealth: () => [
      { provider: "pumpportal", state: "HEALTHY", checkedAtUtc: now },
      { provider: "helius", state: "HEALTHY", checkedAtUtc: now },
      { provider: "analysis_scheduler", state: "HEALTHY", checkedAtUtc: now },
      { provider: "enrichment_scheduler", state: "HEALTHY", checkedAtUtc: now },
      { provider: "paper_runtime", state: "HEALTHY", checkedAtUtc: now },
    ],
    getStreamCompleteness: () => ({
      coverageStatus: "OBSERVED_WITHOUT_KNOWN_GAP",
      historyComplete: false,
      unreconciledGapCount: 0,
      providerIssueOccurrences: 0,
      checkpoint: null,
    }),
    listTokens: () => [
      {
        mint: "So11111111111111111111111111111111111111112",
        monitoringEligible: true,
      },
      { mint: "11111111111111111111111111111111", monitoringEligible: false },
    ],
    getAnalysisPipelineStats: () => ({
      eligibleTokens: 1,
      analysis: { COMPLETE: 1 },
      enrichment: { COMPLETE: 1 },
      migrationRecovery: {},
      failureReasons: [],
      latestCompletedAtUtc: now,
      oldestPendingAtUtc: null,
    }),
    getTradeObservationCoverageStats: () => ({
      monitoredTokens: 1,
      byStatus: { UNVERIFIED: 1 },
      completeTokens: 0,
      observationCount: 2,
      verifiedObservationCount: 1,
      latestObservationAtUtc: now,
    }),
    getHeliusRequestBudget: () => ({
      utcDay: now.slice(0, 10),
      used: 0,
      remaining: 1000,
      reservedForExits: exitReserve,
      exitRequestsUsed: 0,
      byMethod: [],
      byErrorCode: [],
    }),
    getLatestTradeObservationCoverage: () => ({ status: "UNVERIFIED" }),
    getAnalysisOutcome: () => [{ status: "COMPLETE" }],
    listRiskDecisions: () => [{ status: "WATCH" }],
    getLatestTokenRiskReport: () => null,
    getCreatorReputation: () => null,
    getPaperPortfolioState: () => ({
      solBalanceRaw: "0",
      positions: [],
      realizedPnl: [],
      latestMark: { unpriceablePositions: 0 },
    }),
  } as unknown as SentinelStore;
  const readiness = getOperationalReadiness({
    store,
    mode: "PAPER",
    staleFeedSeconds: 30,
    tradeStreamEnabled: true,
    automaticEntriesEnabled: true,
    paperWalletId: "test-wallet",
    heliusMaxRequestsPerUtcDay: 1000,
    heliusExitReservedRequestsPerUtcDay: exitReserve,
    positionMonitorIntervalMs: 15_000,
    positionMonitorMaxIntervalMs: 900_000,
    positionMonitorEstimatedRpcRequests: 2,
  });
  assert.equal(readiness.processHealth, true);
  assert.equal(readiness.discoveryReady, true);
  assert.ok(readiness.paper);
  assert.equal(readiness.providerConnectivity.pumpPortal, true);
  assert.equal(readiness.providerConnectivity.heliusRpc, true);
  assert.equal(readiness.providerConnectivity.heliusTradeStream, false);
  assert.equal(readiness.analysisReadiness, true);
  assert.equal(readiness.analysisStatus, "READY");
  assert.equal(readiness.tradeObservationReady, false);
  assert.equal(readiness.tradeObservationStatus, "BLOCKED");
  assert.equal(readiness.paper.positionMonitor.budgetReadiness, "READY");
  assert.equal(readiness.paper.positionMonitor.requiredDailyExitRequests, 192);
  assert.equal(readiness.tradeObservationDiagnostics.observationCount, 2);
  assert.equal(
    readiness.tradeObservationDiagnostics.verifiedObservationCount,
    1,
  );
  assert.equal(readiness.automaticEntryStatus, "BLOCKED");
  assert.equal(readiness.paperRuntimeReady, true);
  assert.equal(readiness.paperManualEntryReady, false);
  assert.equal(readiness.paperManualExitReady, false);
  assert.equal(readiness.paperExecutionReady, false);
  assert.equal(readiness.paperAutomaticEntryReady, false);
  assert.ok(readiness.blockers.includes("TRADE_STREAM_COVERAGE_UNVERIFIED"));
  assert.ok(readiness.blockers.includes("HELIUS_TRADE_STREAM_NOT_HEALTHY"));
  exitReserve = 100;
  const insufficient = getOperationalReadiness({
    store,
    mode: "PAPER",
    staleFeedSeconds: 30,
    tradeStreamEnabled: true,
    automaticEntriesEnabled: true,
    paperWalletId: "test-wallet",
    heliusMaxRequestsPerUtcDay: 1000,
    heliusExitReservedRequestsPerUtcDay: exitReserve,
    positionMonitorIntervalMs: 15_000,
    positionMonitorMaxIntervalMs: 900_000,
    positionMonitorEstimatedRpcRequests: 2,
  });
  assert.ok(insufficient.paper);
  assert.equal(
    insufficient.paper.positionMonitor.budgetReadiness,
    "EXIT_MONITOR_BUDGET_INSUFFICIENT",
  );
  assert.ok(
    insufficient.automaticEntryBlockers.includes(
      "EXIT_MONITOR_BUDGET_INSUFFICIENT",
    ),
  );
});

test("analysis reports queue progress and Helius budget exhaustion without counting old tokens as blockers", () => {
  const now = new Date().toISOString();
  const store = {
    listProviderHealth: () => [
      { provider: "pumpportal", state: "HEALTHY", checkedAtUtc: now },
      { provider: "helius", state: "HEALTHY", checkedAtUtc: now },
      { provider: "analysis_scheduler", state: "HEALTHY", checkedAtUtc: now },
      {
        provider: "enrichment_scheduler",
        state: "DEGRADED",
        checkedAtUtc: now,
        errorCode: "REQUEST_BUDGET_EXHAUSTED",
      },
    ],
    getStreamCompleteness: () => ({
      coverageStatus: "OBSERVED_WITHOUT_KNOWN_GAP",
      historyComplete: false,
      unreconciledGapCount: 0,
      providerIssueOccurrences: 0,
      checkpoint: null,
    }),
    listTokens: () => [
      {
        mint: "So11111111111111111111111111111111111111112",
        monitoringEligible: true,
      },
      { mint: "11111111111111111111111111111111", monitoringEligible: false },
    ],
    getAnalysisPipelineStats: () => ({
      eligibleTokens: 1,
      analysis: { COMPLETE: 1, PENDING: 1 },
      enrichment: { DEFERRED_BUDGET: 1 },
      migrationRecovery: {},
      failureReasons: [{ reasonCode: "REQUEST_BUDGET_EXHAUSTED", count: 1 }],
      latestCompletedAtUtc: now,
      oldestPendingAtUtc: now,
    }),
    getTradeObservationCoverageStats: () => ({
      monitoredTokens: 1,
      byStatus: { UNVERIFIED: 1 },
      completeTokens: 0,
    }),
    getLatestTradeObservationCoverage: () => ({ status: "UNVERIFIED" }),
    listRiskDecisions: () => [],
  } as unknown as SentinelStore;
  const readiness = getOperationalReadiness({
    store,
    mode: "DRY_RUN",
    staleFeedSeconds: 30,
    tradeStreamEnabled: false,
    automaticEntriesEnabled: false,
    paperWalletId: "test-wallet",
  });
  assert.equal(readiness.analysisReadiness, false);
  assert.equal(readiness.analysisStatus, "DEGRADED");
  assert.equal(readiness.analysisDiagnostics.pending, 1);
  assert.equal(readiness.analysisDiagnostics.eligibleTokens, 1);
  assert.ok(
    readiness.analysisDiagnostics.blockers.includes(
      "HELIUS_REQUEST_BUDGET_EXHAUSTED",
    ),
  );
  assert.ok(
    readiness.analysisDiagnostics.blockers.includes(
      "ENRICHMENT_SCHEDULER_DEGRADED",
    ),
  );
  assert.equal(readiness.tradeObservationStatus, "DISABLED");
  assert.equal(readiness.automaticEntryStatus, "DISABLED");
});

test("analysis is IDLE rather than BLOCKED when healthy schedulers have no active leases", () => {
  const now = new Date().toISOString();
  const store = {
    listProviderHealth: () => [
      { provider: "pumpportal", state: "HEALTHY", checkedAtUtc: now },
      { provider: "helius", state: "HEALTHY", checkedAtUtc: now },
      { provider: "analysis_scheduler", state: "HEALTHY", checkedAtUtc: now },
      { provider: "enrichment_scheduler", state: "HEALTHY", checkedAtUtc: now },
    ],
    getStreamCompleteness: () => ({
      coverageStatus: "OBSERVED_WITHOUT_KNOWN_GAP",
      historyComplete: false,
      unreconciledGapCount: 0,
      providerIssueOccurrences: 0,
      checkpoint: null,
    }),
    listTokens: () => [],
    getAnalysisPipelineStats: () => ({
      eligibleTokens: 0,
      analysis: {},
      historicalAnalysis: { COMPLETE: 12, FAILED: 1 },
      enrichment: {},
      migrationRecovery: {},
      failureReasons: [],
      latestCompletedAtUtc: null,
      oldestPendingAtUtc: null,
    }),
    getTradeObservationCoverageStats: () => ({
      monitoredTokens: 0,
      byStatus: {},
      completeTokens: 0,
    }),
    listRiskDecisions: () => [],
  } as unknown as SentinelStore;
  const readiness = getOperationalReadiness({
    store,
    mode: "DRY_RUN",
    staleFeedSeconds: 30,
    tradeStreamEnabled: false,
    automaticEntriesEnabled: false,
    paperWalletId: "test-wallet",
  });
  assert.equal(readiness.analysisStatus, "IDLE");
  assert.equal(readiness.analysisDiagnostics.eligibleTokens, 0);
  assert.equal(readiness.analysisDiagnostics.complete, 12);
  assert.ok(
    readiness.analysisDiagnostics.blockers.includes(
      "NO_MONITORING_ELIGIBLE_TOKENS",
    ),
  );
});
