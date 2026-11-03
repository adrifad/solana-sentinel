import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApiServer } from "@sentinel/api";
import { SentinelStore } from "@sentinel/storage";

test("read-only API serves health and token list, rejects writes and unknown paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentinel-api-"));
  const store = new SentinelStore(join(dir, "sentinel.db"));
  await store.open();
  const server = createApiServer({
    store,
    mode: "DRY_RUN",
    staleFeedSeconds: 30,
    tradeStreamEnabled: false,
    automaticEntriesEnabled: false,
    paperWalletId: "test-paper",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { mode: string }).mode, "DRY_RUN");
    assert.equal((await fetch(`${baseUrl}/api/tokens`)).status, 200);
    const completenessResponse = await fetch(`${baseUrl}/api/completeness`);
    assert.equal(completenessResponse.status, 200);
    const completeness = (await completenessResponse.json()) as {
      historyComplete: boolean;
      coverageStatus: string;
    };
    assert.equal(completeness.historyComplete, false);
    assert.equal(completeness.coverageStatus, "UNKNOWN");
    assert.equal((await fetch(`${baseUrl}/ready`)).status, 503);
    store.setProviderHealth({
      provider: "pumpportal",
      state: "HEALTHY",
      checkedAtUtc: new Date(Date.now() - 60000).toISOString(),
      lastEventAtUtc: null,
      reconnectCount: 0,
      errorCode: null,
    });
    assert.equal((await fetch(`${baseUrl}/ready`)).status, 503);
    store.setProviderHealth({
      provider: "pumpportal",
      state: "HEALTHY",
      checkedAtUtc: new Date().toISOString(),
      lastEventAtUtc: null,
      reconnectCount: 0,
      errorCode: null,
    });
    assert.equal((await fetch(`${baseUrl}/ready`)).status, 200);
    assert.equal(
      (await fetch(`${baseUrl}/api/tokens`, { method: "POST" })).status,
      405,
    );
    assert.equal(
      (await fetch(`${baseUrl}/api/settings`, { method: "PATCH" })).status,
      405,
    );
    assert.equal((await fetch(`${baseUrl}/missing`)).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("daily metrics endpoint returns a validated Jakarta date summary without writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentinel-api-summary-"));
  const store = new SentinelStore(join(dir, "sentinel.db"));
  await store.open();
  store.initializePaperAccount(
    "summary-wallet",
    "10000000000",
    "2026-11-03T00:00:00.000Z",
  );
  const server = createApiServer({
    store,
    mode: "PAPER",
    staleFeedSeconds: 30,
    tradeStreamEnabled: false,
    automaticEntriesEnabled: false,
    paperWalletId: "summary-wallet",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/metrics/daily-summary?date=2026-11-03`,
    );
    assert.equal(response.status, 200);
    const summary = (await response.json()) as {
      dateAsiaJakarta: string;
      summary: { realizedPnlLamports: string; openPositions: number };
    };
    assert.equal(summary.dateAsiaJakarta, "2026-11-03");
    assert.equal(summary.summary.realizedPnlLamports, "0");
    assert.equal(summary.summary.openPositions, 0);
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${address.port}/api/metrics/daily-summary?date=2026-02-30`,
        )
      ).status,
      400,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
