import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ProviderFailure, parsePumpPortalMessage } from "@sentinel/providers";
import { SentinelStore } from "@sentinel/storage";
import { EnrichmentScheduler } from "../apps/worker/src/enrichment.ts";

const launch = JSON.parse(
  await readFile("tests/fixtures/pumpportal-created.synthetic.json", "utf8"),
) as Record<string, unknown>;

test("budget-deferred enrichment is durably reclaimed after its retry time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-analysis-health-"));
  const path = join(directory, "test.sqlite");
  const store = new SentinelStore(path);
  await store.open();
  try {
    const event = parsePumpPortalMessage(launch, Date.now());
    assert.equal(store.ingestEvent(event, 20, true).inserted, true);
    const first = store.claimEnrichmentJob();
    assert.ok(first);
    store.finishEnrichmentJob(
      first.eventId,
      "DEFERRED_BUDGET",
      "REQUEST_BUDGET_EXHAUSTED",
      60_000,
    );
    assert.equal(store.claimEnrichmentJob(), null);

    const db = new DatabaseSync(path);
    db.prepare(
      "UPDATE enrichment_jobs SET next_attempt_at_utc = ? WHERE event_id = ?",
    ).run(new Date(Date.now() - 1000).toISOString(), first.eventId);
    db.close();

    const recovered = store.claimEnrichmentJob();
    assert.equal(recovered?.eventId, first.eventId);
    assert.equal(recovered?.attempts, 2);
    assert.equal(store.getAnalysisPipelineStats().eligibleTokens, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("analysis diagnostics report durable queue states and clear recovered errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-analysis-state-"));
  const store = new SentinelStore(join(directory, "test.sqlite"));
  await store.open();
  try {
    const event = parsePumpPortalMessage(launch, Date.now());
    store.ingestEvent(event, 20, true);
    const job = store.claimAnalysisJob();
    assert.ok(job);
    store.finishAnalysisJob(job.eventId, 5000, "REQUEST_BUDGET_EXHAUSTED");
    let stats = store.getAnalysisPipelineStats();
    assert.equal(stats.analysis["PENDING"], 1);
    assert.equal(
      stats.failureReasons[0]?.reasonCode,
      "REQUEST_BUDGET_EXHAUSTED",
    );

    const db = new DatabaseSync(store.path);
    db.prepare(
      "UPDATE analysis_jobs SET next_attempt_at_utc = ? WHERE event_id = ?",
    ).run(new Date(Date.now() - 1000).toISOString(), job.eventId);
    db.close();

    const reclaimed = store.claimAnalysisJob();
    assert.equal(reclaimed?.eventId, job.eventId);
    store.finishAnalysisJob(job.eventId);
    stats = store.getAnalysisPipelineStats();
    assert.equal(stats.analysis["COMPLETE"], 1);
    assert.deepEqual(stats.failureReasons, []);
    assert.equal(stats.latestCompletedAtUtc !== null, true);
    assert.equal(stats.oldestPendingAtUtc, null);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Helius budget exhaustion defers enrichment without reporting RPC connectivity failure", async () => {
  let claimed = false;
  let result: unknown;
  const healthUpdates: Array<{ provider: string; state: string }> = [];
  const store = {
    recoverInterruptedEnrichmentJobs: () => 0,
    recoverInterruptedMigrationJobs: () => 0,
    claimEnrichmentJob: () => {
      if (claimed) return null;
      claimed = true;
      return {
        eventId: "event-budget",
        mint: "mint-budget",
        kind: "TOKEN_CREATED",
        slot: null,
        chainTimeStatus: "UNKNOWN",
        attempts: 1,
      };
    },
    claimMigrationRecoveryJob: () => null,
    getToken: () => ({ mintStateStatus: "UNKNOWN" }),
    recordMintAccount: () => undefined,
    finishEnrichmentJob: (...args: unknown[]) => {
      result = args;
    },
    setProviderHealth: (health: { provider: string; state: string }) => {
      healthUpdates.push(health);
    },
  } as never;
  const scheduler = new EnrichmentScheduler(
    store,
    {
      getAccountInfo: async () => {
        throw new ProviderFailure("REQUEST_BUDGET_EXHAUSTED");
      },
    } as never,
    1,
  );
  scheduler.start();
  await scheduler.stop();
  assert.equal(
    healthUpdates.some(
      (health) => health.provider === "helius" && health.state === "DEGRADED",
    ),
    false,
  );
  assert.equal(Array.isArray(result), true);
  const args = result as unknown[];
  assert.equal(args[0], "event-budget");
  assert.equal(args[1], "DEFERRED_BUDGET");
  assert.equal(args[2], "REQUEST_BUDGET_EXHAUSTED");
  assert.ok(Number(args[3]) >= 1000);
});
