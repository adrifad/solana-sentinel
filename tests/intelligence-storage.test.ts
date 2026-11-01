import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CreatorReputation } from "@sentinel/domain";
import { parsePumpPortalMessage } from "@sentinel/providers";
import { SentinelStore } from "@sentinel/storage";

const capture = JSON.parse(
  await readFile("tests/fixtures/pumpportal-created.synthetic.json", "utf8"),
) as Record<string, unknown>;

test("migration 005 persists launch analysis jobs and recovers interrupted work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-intelligence-"));
  const database = join(directory, "sentinel.db");
  let store = new SentinelStore(database);
  await store.open();
  const event = parsePumpPortalMessage(capture, Date.now());
  try {
    assert.equal(store.ingestEvent(event, 10, true).inserted, true);
    const firstJob = store.claimAnalysisJob();
    assert.ok(firstJob);
    assert.equal(
      store.getMarketEventSummary(firstJob.eventId)?.monitoringEligible,
      true,
    );
    store.close();

    store = new SentinelStore(database);
    await store.open();
    assert.equal(store.recoverInterruptedAnalysisJobs(), 1);
    const recovered = store.claimAnalysisJob();
    assert.equal(recovered?.eventId, firstJob.eventId);
    assert.equal(store.getCreatorReputation(event.mint), null);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("direct funding evidence is retained without promoting a wallet cluster", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-wallet-links-"));
  const store = new SentinelStore(join(directory, "sentinel.db"));
  await store.open();
  try {
    const source = "11111111111111111111111111111111";
    const destination = "So11111111111111111111111111111111111111112";
    store.saveWalletLink({
      id: "direct-funding-evidence",
      sourceWallet: source,
      destinationWallet: destination,
      relationType: "DIRECT_FUNDING",
      signature: "funding-signature",
      slot: 10,
      observedAtUtc: new Date().toISOString(),
      amountLamportsRaw: "1000000",
      confidenceBps: 3500,
      reasonCode: "OBSERVED_DIRECT_SYSTEM_TRANSFER_NO_OWNERSHIP_CLAIM",
    });
    assert.deepEqual(store.listLinkedWallets(source, 10), []);
    assert.equal(store.getWalletLinks(source).length, 1);
    assert.equal(store.walletTransactionCount(source, 10), 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("creator reputation refresh is incremental and as-of snapshots exclude later observations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-reputation-asof-"));
  const store = new SentinelStore(join(directory, "sentinel.db"));
  await store.open();
  try {
    const wallet = "11111111111111111111111111111111";
    const makeReputation = (
      asOfSlot: number,
      historyComplete: boolean,
      launchesObserved: number,
    ): CreatorReputation => ({
      wallet,
      status: launchesObserved > 0 ? "KNOWN" : "UNKNOWN",
      launchesObserved,
      suspiciousIndicators: [],
      confidenceBps: historyComplete ? 8500 : 5000,
      historyComplete,
      asOfSlot,
      computedAtUtc: new Date().toISOString(),
      freshUntilUtc: new Date(Date.now() + 60000).toISOString(),
      evidenceRefs: [`slot:${asOfSlot}`],
    });
    store.saveCreatorReputation(makeReputation(10, false, 1));
    store.saveCreatorReputation(makeReputation(10, true, 2));
    store.saveCreatorReputation(makeReputation(20, true, 3));
    store.saveCreatorReputation(makeReputation(15, true, 99));
    assert.equal(store.getCreatorReputation(wallet, 10)?.historyComplete, true);
    assert.equal(store.getCreatorReputation(wallet, 14)?.launchesObserved, 2);
    assert.equal(store.getCreatorReputation(wallet, 19)?.launchesObserved, 99);
    assert.equal(store.getCreatorReputation(wallet, 20)?.launchesObserved, 3);
    assert.equal(store.getCreatorReputation(wallet)?.launchesObserved, 3);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
