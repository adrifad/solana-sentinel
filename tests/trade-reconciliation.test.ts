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
import { TradeReconciliationWorker } from "../apps/worker/src/trade-reconciliation.ts";

const created = JSON.parse(
  await readFile("tests/fixtures/pumpportal-created.synthetic.json", "utf8"),
) as Record<string, unknown>;

test("reconciliation checkpoint survives restart and empty finalized window is explicitly complete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentinel-reconcile-"));
  const path = join(dir, "test.sqlite");
  let store = new SentinelStore(path);
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
    assert.equal(store.listAppliedMigrations().at(-1)?.version, 17);
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
    const signature =
      "5TKad77QinBX7wpSJABiiH2w7FnSgseEHdjTzTHgT9bcYJAa9xrKyTTfVHifoXXqHZdy1wBfbFHmrVCebBBsfev2";
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
