import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  parsePumpPortalMessage,
  type ParsedTradeScanRequest,
} from "@sentinel/providers";
import { SentinelStore } from "@sentinel/storage";
import {
  parsedScanEventWithinExactWindow,
  parsedScanMatchesVerifiedTrades,
  TradeReconciliationWorker,
} from "../apps/worker/src/trade-reconciliation.ts";

const created = JSON.parse(
  await readFile("tests/fixtures/pumpportal-created.synthetic.json", "utf8"),
) as Record<string, unknown>;
const signature =
  "5TKad77QinBX7wpSJABiiH2w7FnSgseEHdjTzTHgT9bcYJAa9xrKyTTfVHifoXXqHZdy1wBfbFHmrVCebBBsfev2";

test("reconciliation checkpoint survives restart and empty finalized window is explicitly complete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentinel-reconcile-"));
  const path = join(dir, "test.sqlite");
  let store = new SentinelStore(path);
  await store.open();
  try {
    const event = parsePumpPortalMessage(created, Date.now());
    store.ingestEvent(event, 20, true);
    const started = new Date(Date.now() - 180_000).toISOString();
    const expires = new Date(Date.now() - 90_000).toISOString();
    store.enqueueTradeReconciliation({
      mint: event.mint,
      windowStartedAtUtc: started,
      windowExpiresAtUtc: expires,
    });
    const job = store.claimParsedReconciliationJob();
    assert.ok(job);
    store.saveParsedReconciliationPage({
      jobId: job.id,
      mint: event.mint,
      items: [],
      paginationToken: null,
      stoppedOn: "windowEnd",
      scannedThrough: null,
      creditsCharged: 11,
      maxPages: 3,
    });
    assert.equal(
      store.getLatestTradeObservationCoverage(event.mint)?.status,
      "COMPLETE",
    );
    store.close();
    store = new SentinelStore(path);
    await store.open();
    assert.equal(
      store.getLatestTradeObservationCoverage(event.mint)?.reasonCode,
      "FINALIZED_SCAN_WINDOW_COMPLETE",
    );
    assert.equal(store.listAppliedMigrations().at(-1)?.version, 18);
    const integrityDb = new DatabaseSync(path, { readOnly: true });
    try {
      const integrity = integrityDb.prepare("PRAGMA integrity_check").get() as {
        integrity_check: string;
      };
      assert.equal(integrity.integrity_check, "ok");
    } finally {
      integrityDb.close();
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconciliation never completes while relevant signatures are unresolved and leaves unsupported data partial", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentinel-reconcile-pending-"));
  const path = join(dir, "test.sqlite");
  const store = new SentinelStore(path);
  await store.open();
  try {
    const event = parsePumpPortalMessage(created, Date.now());
    store.ingestEvent(event, 20, true);
    const started = new Date(Date.now() - 120_000).toISOString();
    const expires = new Date(Date.now() - 60_000).toISOString();
    store.enqueueTradeReconciliation({
      mint: event.mint,
      windowStartedAtUtc: started,
      windowExpiresAtUtc: expires,
    });
    const job = store.claimParsedReconciliationJob();
    assert.ok(job);
    store.saveParsedReconciliationPage({
      jobId: job.id,
      mint: event.mint,
      items: [
        {
          signature,
          slot: 10,
          blockTime: 1792850000,
          parsedProtocol: "pump_fun",
          parsedKind: "buy",
          parsedMint: event.mint,
          instructionNames: ["buy_v3"],
        },
      ],
      paginationToken: null,
      stoppedOn: "windowEnd",
      scannedThrough: { slot: 10, blockTime: 1792850000 },
      creditsCharged: 11,
      maxPages: 3,
    });
    assert.equal(
      store.getLatestTradeObservationCoverage(event.mint)?.status,
      "RECONCILING",
    );
    const inspectDb = new DatabaseSync(path, { readOnly: true });
    let provenance: {
      parsed_protocol: string;
      parsed_kind: string;
      parsed_mint: string;
      instruction_names_json: string;
    };
    try {
      provenance = inspectDb
        .prepare(
          "SELECT parsed_protocol,parsed_kind,parsed_mint,instruction_names_json FROM parsed_event_reconciliation_transactions WHERE signature=?",
        )
        .get(signature) as {
        parsed_protocol: string;
        parsed_kind: string;
        parsed_mint: string;
        instruction_names_json: string;
      };
    } finally {
      inspectDb.close();
    }
    assert.deepEqual(
      { ...provenance },
      {
        parsed_protocol: "pump_fun",
        parsed_kind: "buy",
        parsed_mint: event.mint,
        instruction_names_json: '["buy_v3"]',
      },
    );
    store.setParsedReconciliationTransactionStatus({
      mint: event.mint,
      signature,
      status: "UNSUPPORTED",
      reasonCode: "UNSUPPORTED_INSTRUCTION",
    });
    assert.equal(
      store.getLatestTradeObservationCoverage(event.mint)?.status,
      "PARTIAL",
    );
    store.recordTradeObservationCoverage({
      mint: event.mint,
      source: "helius_parsed_events_scan",
      status: "UNVERIFIED",
      windowStartedAtUtc: started,
      windowExpiresAtUtc: expires,
      lastEventAtUtc: null,
      reconnectCount: 0,
      reasonCode: "LATE_SOCKET_UPDATE",
      updatedAtUtc: new Date().toISOString(),
    });
    assert.equal(
      store.getLatestTradeObservationCoverage(event.mint)?.status,
      "PARTIAL",
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Parsed Events credit budget reserves worst-case request cost and accounts actual charge separately", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentinel-scan-budget-"));
  const store = new SentinelStore(join(dir, "test.sqlite"));
  await store.open();
  try {
    const reservationDay = store.reserveParsedEventsScanCredits(11, 11);
    assert.equal(reservationDay, new Date().toISOString().slice(0, 10));
    assert.equal(store.reserveParsedEventsScanCredits(11, 11), null);
    store.settleParsedEventsScanCredits(reservationDay!, 11, 9);
    assert.deepEqual(store.parsedEventsScanBudget(11), {
      used: 9,
      reserved: 0,
      remaining: 2,
      requests: 1,
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconciliation rounds second-resolution chain time inward at fractional boundaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentinel-reconcile-bounds-"));
  const store = new SentinelStore(join(dir, "test.sqlite"));
  await store.open();
  const now = Date.now();
  const started = new Date(now - 5_137).toISOString();
  const expires = new Date(now - 1_219).toISOString();
  let request: { fromUnixSeconds: number; toUnixSeconds: number } | undefined;
  let notifyEvidence: (() => void) | undefined;
  const evidence = new Promise<void>((resolve) => {
    notifyEvidence = resolve;
  });
  const worker = new TradeReconciliationWorker({
    store,
    scan: {
      scanMintWindow: async (input: ParsedTradeScanRequest) => {
        request = input;
        return {
          items: [],
          paginationToken: null,
          stoppedOn: "windowEnd" as const,
          scannedThrough: null,
          creditsCharged: 0,
          scannedTransactions: 0,
        };
      },
    } as never,
    verificationQueue: { enqueue: () => "ACCEPTED" } as never,
    maxPagesPerJob: 4,
    maxScannedTransactions: 1_000,
    concurrency: 1,
    finalityBufferSeconds: 0,
    onEvidence: () => notifyEvidence?.(),
  });
  try {
    const event = parsePumpPortalMessage(created, now);
    store.ingestEvent(event, 20, true);
    store.enqueueTradeReconciliation({
      mint: event.mint,
      windowStartedAtUtc: started,
      windowExpiresAtUtc: expires,
    });
    worker.start();
    await Promise.race([
      evidence,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("RECONCILIATION_TIMEOUT")), 2_000),
      ),
    ]);
    await worker.stop();
    assert.equal(
      request?.fromUnixSeconds,
      Math.ceil(Date.parse(started) / 1000),
    );
    assert.equal(request?.toUnixSeconds, Math.ceil(Date.parse(expires) / 1000));
    assert.equal(
      store.getLatestTradeObservationCoverage(event.mint)?.status,
      "COMPLETE",
    );
  } finally {
    await worker.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("finality buffer holds the expired observation boundary until safely elapsed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentinel-reconcile-finality-"));
  const store = new SentinelStore(join(dir, "test.sqlite"));
  await store.open();
  try {
    const event = parsePumpPortalMessage(created, Date.now());
    store.ingestEvent(event, 20, true);
    const now = Date.now();
    const started = new Date(now - 120_000).toISOString();
    const expires = new Date(now - 30_000).toISOString();
    store.enqueueTradeReconciliation({
      mint: event.mint,
      windowStartedAtUtc: started,
      windowExpiresAtUtc: expires,
    });
    assert.equal(store.claimParsedReconciliationJob(60), null);

    const olderExpires = new Date(now - 61_000).toISOString();
    store.enqueueTradeReconciliation({
      mint: event.mint,
      windowStartedAtUtc: new Date(now - 121_000).toISOString(),
      windowExpiresAtUtc: olderExpires,
    });
    const job = store.claimParsedReconciliationJob(60);
    assert.ok(job);
    const db = new DatabaseSync(join(dir, "test.sqlite"), { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT finality_ready_at_utc,finality_buffer_seconds FROM parsed_event_reconciliation_jobs WHERE id=?",
        )
        .get(job.id) as {
        finality_ready_at_utc: string;
        finality_buffer_seconds: number;
      };
      assert.ok(row.finality_ready_at_utc);
      assert.equal(row.finality_buffer_seconds, 60);
    } finally {
      db.close();
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy complete scan rows without finality proof are made eligible for a fresh scan", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "sentinel-reconcile-legacy-finality-"),
  );
  const path = join(dir, "test.sqlite");
  const store = new SentinelStore(path);
  await store.open();
  try {
    const event = parsePumpPortalMessage(created, Date.now());
    store.ingestEvent(event, 20, true);
    const started = new Date(Date.now() - 180_000).toISOString();
    const expires = new Date(Date.now() - 90_000).toISOString();
    const jobId = store.enqueueTradeReconciliation({
      mint: event.mint,
      windowStartedAtUtc: started,
      windowExpiresAtUtc: expires,
    });
    const db = new DatabaseSync(path);
    try {
      db.prepare(
        "UPDATE parsed_event_reconciliation_jobs SET status='PARTIAL',reason_code='FINALITY_BOUNDARY_NOT_VERIFIED' WHERE id=?",
      ).run(jobId);
    } finally {
      db.close();
    }
    store.enqueueTradeReconciliation({
      mint: event.mint,
      windowStartedAtUtc: started,
      windowExpiresAtUtc: expires,
    });
    const job = store.claimParsedReconciliationJob(60);
    assert.equal(job?.id, jobId);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider budget failures remain explicitly unverified and exhausted retries remain partial", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "sentinel-reconcile-provider-failure-"),
  );
  const path = join(dir, "test.sqlite");
  const store = new SentinelStore(path);
  await store.open();
  try {
    const event = parsePumpPortalMessage(created, Date.now());
    store.ingestEvent(event, 20, true);
    const now = Date.now();
    const started = new Date(now - 180_000).toISOString();
    const expires = new Date(now - 90_000).toISOString();
    const jobId = store.enqueueTradeReconciliation({
      mint: event.mint,
      windowStartedAtUtc: started,
      windowExpiresAtUtc: expires,
    });
    assert.ok(store.claimParsedReconciliationJob(60));
    assert.equal(
      store.deferParsedReconciliationJob(
        jobId,
        "PARSED_SCAN_CREDIT_BUDGET_EXHAUSTED",
        60_000,
      ),
      false,
    );
    assert.equal(
      store.getLatestTradeObservationCoverage(event.mint)?.status,
      "RECONCILING",
    );
    assert.equal(
      store.getLatestTradeObservationCoverage(event.mint)?.reasonCode,
      "PARSED_SCAN_CREDIT_BUDGET_EXHAUSTED",
    );

    const exhaustedMint = "11111111111111111111111111111111";
    const exhaustedId = store.enqueueTradeReconciliation({
      mint: exhaustedMint,
      windowStartedAtUtc: started,
      windowExpiresAtUtc: expires,
    });
    const db = new DatabaseSync(path);
    try {
      db.prepare(
        "UPDATE parsed_event_reconciliation_jobs SET attempts=5 WHERE id=?",
      ).run(exhaustedId);
    } finally {
      db.close();
    }
    assert.ok(store.claimParsedReconciliationJob(60));
    assert.equal(
      store.deferParsedReconciliationJob(exhaustedId, "RATE_LIMITED", 1000),
      true,
    );
    assert.equal(
      store.getLatestTradeObservationCoverage(exhaustedMint)?.status,
      "PARTIAL",
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("analysis requeue coalesces duplicate evidence and survives PROCESSING race and restart", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "sentinel-analysis-requeue-storage-"),
  );
  const path = join(dir, "test.sqlite");
  let store = new SentinelStore(path);
  await store.open();
  try {
    const event = parsePumpPortalMessage(created, Date.now());
    store.ingestEvent(event, 20, true);
    const initial = store.claimAnalysisJob();
    assert.ok(initial);
    store.finishAnalysisJob(initial.eventId);
    assert.equal(
      store.requeueLatestAnalysisForMint(event.mint, "trade:event-1", 0),
      true,
    );
    assert.equal(
      store.requeueLatestAnalysisForMint(event.mint, "trade:event-1", 0),
      false,
    );
    const second = store.claimAnalysisJob();
    assert.ok(second);
    assert.equal(
      store.requeueLatestAnalysisForMint(event.mint, "coverage:COMPLETE", 0),
      true,
    );
    store.finishAnalysisJob(second.eventId);
    assert.equal(
      store.getAnalysisOutcome(event.mint)[0]?.["status"],
      "PENDING",
    );

    const third = store.claimAnalysisJob();
    assert.ok(third);
    store.close();
    store = new SentinelStore(path);
    await store.open();
    assert.equal(store.recoverInterruptedAnalysisJobs(), 1);
    assert.equal(store.claimAnalysisJob()?.eventId, third.eventId);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("pagination page limit stays partial and resumes from the persisted cursor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentinel-reconcile-pages-"));
  const store = new SentinelStore(join(dir, "test.sqlite"));
  await store.open();
  try {
    const event = parsePumpPortalMessage(created, Date.now());
    store.ingestEvent(event, 20, true);
    const started = new Date(Date.now() - 180_000).toISOString();
    const expires = new Date(Date.now() - 90_000).toISOString();
    const jobId = store.enqueueTradeReconciliation({
      mint: event.mint,
      windowStartedAtUtc: started,
      windowExpiresAtUtc: expires,
    });
    const first = store.claimParsedReconciliationJob(60);
    assert.equal(first?.id, jobId);
    store.saveParsedReconciliationPage({
      jobId,
      mint: event.mint,
      items: [],
      paginationToken: "cursor-page-2",
      stoppedOn: "budget",
      scannedThrough: { slot: 20, blockTime: 1_792_850_000 },
      creditsCharged: 11,
      maxPages: 1,
    });
    assert.equal(
      store.getLatestTradeObservationCoverage(event.mint)?.status,
      "PARTIAL",
    );
    const resumed = store.claimParsedReconciliationJob(60);
    assert.equal(resumed?.id, jobId);
    assert.equal(resumed?.paginationToken, "cursor-page-2");
    store.saveParsedReconciliationPage({
      jobId,
      mint: event.mint,
      items: [],
      paginationToken: null,
      stoppedOn: "windowEnd",
      scannedThrough: null,
      creditsCharged: 10,
      maxPages: 1,
    });
    assert.equal(
      store.getLatestTradeObservationCoverage(event.mint)?.status,
      "COMPLETE",
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("verified parsed scan direction and mint must match decoded on-chain trades", () => {
  assert.equal(
    parsedScanMatchesVerifiedTrades({
      expectedMint: "token-mint",
      expectedSide: "BUY",
      observations: [{ mint: "token-mint", side: "BUY" }],
    }),
    true,
  );
  assert.equal(
    parsedScanMatchesVerifiedTrades({
      expectedMint: "token-mint",
      expectedSide: "SELL",
      observations: [{ mint: "token-mint", side: "SELL" }],
    }),
    true,
  );
  assert.equal(
    parsedScanMatchesVerifiedTrades({
      expectedMint: "token-mint",
      expectedSide: "SELL",
      observations: [{ mint: "token-mint", side: "BUY" }],
    }),
    false,
  );
  assert.equal(
    parsedScanMatchesVerifiedTrades({
      expectedMint: null,
      expectedSide: null,
      observations: [{ mint: "token-mint", side: "BUY" }],
    }),
    false,
  );
});

test("second-resolution scan events outside exact millisecond window are excluded", () => {
  const start = "2026-11-07T02:00:00.500Z";
  const end = "2026-11-07T02:00:02.000Z";
  assert.equal(
    parsedScanEventWithinExactWindow({
      blockTime: Math.floor(Date.parse(start) / 1000),
      windowStartedAtUtc: start,
      windowExpiresAtUtc: end,
    }),
    false,
  );
  assert.equal(
    parsedScanEventWithinExactWindow({
      blockTime: Math.floor(Date.parse(start) / 1000) + 1,
      windowStartedAtUtc: start,
      windowExpiresAtUtc: end,
    }),
    true,
  );
  assert.equal(
    parsedScanEventWithinExactWindow({
      blockTime: Date.parse(end) / 1000,
      windowStartedAtUtc: start,
      windowExpiresAtUtc: end,
    }),
    false,
  );
});

test("reconciliation evidence can requeue a migration-first analysis job", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentinel-migration-requeue-"));
  const store = new SentinelStore(join(dir, "test.sqlite"));
  await store.open();
  try {
    const event = parsePumpPortalMessage({
      txType: "migrate",
      mint: "So11111111111111111111111111111111111111112",
      signature,
    });
    store.ingestEvent(event, 20, true);
    const migrationRecovery = store.claimMigrationRecoveryJob();
    assert.equal(migrationRecovery?.eventId, event.id);
    store.finishMigrationRecoveryJob(
      event.id,
      "FAILED",
      "MIGRATION_CREATION_EVIDENCE_UNAVAILABLE",
    );
    const initial = store.claimAnalysisJob();
    assert.equal(initial?.eventId, event.id);
    store.finishAnalysisJob(event.id);
    assert.equal(
      store.requeueLatestAnalysisForMint(
        event.mint,
        "coverage:migration:PARTIAL",
        0,
      ),
      true,
    );
    assert.equal(store.claimAnalysisJob()?.eventId, event.id);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
