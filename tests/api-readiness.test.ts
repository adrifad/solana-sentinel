import assert from "node:assert/strict";
import test from "node:test";
import type { SentinelStore } from "@sentinel/storage";
import { getOperationalReadiness } from "@sentinel/api";

test("PAPER readiness remains blocked when stream coverage is unverified", () => {
  const now = new Date().toISOString();
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
  });
  assert.equal(readiness.processHealth, true);
  assert.equal(readiness.discoveryReady, true);
  assert.equal(readiness.providerConnectivity.pumpPortal, true);
  assert.equal(readiness.providerConnectivity.heliusRpc, true);
  assert.equal(readiness.providerConnectivity.heliusTradeStream, false);
  assert.equal(readiness.analysisReadiness, true);
  assert.equal(readiness.analysisStatus, "READY");
  assert.equal(readiness.tradeObservationReady, false);
  assert.equal(readiness.tradeObservationStatus, "BLOCKED");
  assert.equal(readiness.automaticEntryStatus, "BLOCKED");
  assert.equal(readiness.paperRuntimeReady, true);
  assert.equal(readiness.paperManualEntryReady, false);
  assert.equal(readiness.paperManualExitReady, false);
  assert.equal(readiness.paperExecutionReady, false);
  assert.equal(readiness.paperAutomaticEntryReady, false);
  assert.ok(readiness.blockers.includes("TRADE_STREAM_COVERAGE_UNVERIFIED"));
  assert.ok(readiness.blockers.includes("HELIUS_TRADE_STREAM_NOT_HEALTHY"));
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
