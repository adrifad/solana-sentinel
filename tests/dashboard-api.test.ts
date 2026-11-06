import assert from "node:assert/strict";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApiServer } from "@sentinel/api";
import { parsePumpPortalMessage } from "@sentinel/providers";
import { SentinelStore } from "@sentinel/storage";

test("candidate diagnostics explain stored tokens and disabled PAPER entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-dashboard-api-"));
  const store = new SentinelStore(join(directory, "sentinel.db"));
  await store.open();
  const fixture = JSON.parse(
    await readFile("tests/fixtures/pumpportal-created.synthetic.json", "utf8"),
  ) as unknown;
  const event = parsePumpPortalMessage(fixture);
  store.ingestEvent(event, 20, true, 120);
  store.recordPaperEntryEvaluation({
    mint: event.mint,
    decisionId: null,
    decisionStatus: null,
    status: "NOT_ATTEMPTED",
    reasonCode: "AUTOMATIC_ENTRIES_DISABLED",
    evaluatedAtUtc: new Date().toISOString(),
  });
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
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/paper/candidates?limit=5`,
    );
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      totalDiscovered: number;
      automaticEntriesEnabled: boolean;
      candidates: Array<{
        token: { mint: string };
        entryEvaluation: { status: string; reasonCode: string | null };
      }>;
    };
    assert.equal(payload.totalDiscovered, 1);
    assert.equal(payload.automaticEntriesEnabled, false);
    assert.equal(payload.candidates[0]?.token.mint, event.mint);
    assert.equal(
      payload.candidates[0]?.entryEvaluation.status,
      "NOT_ATTEMPTED",
    );
    assert.equal(
      payload.candidates[0]?.entryEvaluation.reasonCode,
      "AUTOMATIC_ENTRIES_DISABLED",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
