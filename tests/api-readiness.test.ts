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
    ],
    getStreamCompleteness: () => ({
      coverageStatus: "OBSERVED_WITHOUT_KNOWN_GAP",
      historyComplete: false,
      unreconciledGapCount: 0,
      providerIssueOccurrences: 0,
      checkpoint: null,
    }),
    listTokens: () => [{ mint: "So11111111111111111111111111111111111111112" }],
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
  assert.equal(readiness.tradeObservationReady, false);
  assert.equal(readiness.paperRuntimeReady, true);
  assert.equal(readiness.paperManualEntryReady, false);
  assert.equal(readiness.paperManualExitReady, false);
  assert.equal(readiness.paperExecutionReady, false);
  assert.equal(readiness.paperAutomaticEntryReady, false);
  assert.ok(readiness.blockers.includes("TRADE_STREAM_COVERAGE_UNVERIFIED"));
  assert.ok(readiness.blockers.includes("HELIUS_TRADE_STREAM_NOT_HEALTHY"));
});
