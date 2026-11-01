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
