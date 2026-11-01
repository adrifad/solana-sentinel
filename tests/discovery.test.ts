import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { parsePumpPortalMessage, PumpPortalClient } from "@sentinel/providers";
import { SentinelStore } from "@sentinel/storage";
import type WebSocket from "ws";

const created = JSON.parse(
  await readFile("tests/fixtures/pumpportal-created.synthetic.json", "utf8"),
) as unknown;
const migration = JSON.parse(
  await readFile("tests/fixtures/pumpportal-migration.synthetic.json", "utf8"),
) as unknown;

test("normalizes launch and migration fixtures with deterministic UTC identity", () => {
  const first = parsePumpPortalMessage(created, 1793500000000);
  const duplicate = parsePumpPortalMessage(created, 1793500005000);
  assert.equal(first.kind, "TOKEN_CREATED");
  assert.equal(first.receivedAtUtc, "2026-11-01T02:26:40.000Z");
  assert.equal(first.idempotencyKey, duplicate.idempotencyKey);
  assert.equal(parsePumpPortalMessage(migration).kind, "TOKEN_MIGRATED");
  assert.doesNotMatch(
    first.sanitizedPayload,
    /fixture-secret-must-not-persist/,
  );
});

test("rejects malformed messages and unknown provider discriminators", () => {
  assert.throws(() =>
    parsePumpPortalMessage({ txType: "create", mint: "not-a-public-key" }),
  );
  assert.throws(
    () =>
      parsePumpPortalMessage({
        txType: "future-event",
        mint: "So11111111111111111111111111111111111111112",
      }),
    /UNSUPPORTED_EVENT_KIND/,
  );
  assert.throws(
    () => parsePumpPortalMessage({ txType: "create" }),
    /MALFORMED_EVENT/,
  );
});

test("persists unique events, preserves migration phase on out-of-order launch, and caps monitoring", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentinel-db-"));
  const store = new SentinelStore(join(dir, "sentinel.db"));
  let currentStore: SentinelStore | undefined = store;
  await store.open();
  try {
    const migrated = parsePumpPortalMessage(migration, 1793500005000);
    const launch = parsePumpPortalMessage(created, 1793500000000);
    assert.equal(store.ingestEvent(migrated, 1).inserted, true);
    assert.equal(store.ingestEvent(launch, 1).inserted, true);
    assert.equal(
      store.ingestEvent(parsePumpPortalMessage(created, 1793500010000), 1)
        .inserted,
      false,
    );
    assert.equal(store.eventCount(), 2);
    assert.equal(
      store.getToken(launch.mint)?.marketPhase,
      "MIGRATED_UNKNOWN_VENUE",
    );
    assert.equal(store.getToken(launch.mint)?.eventCount, 2);

    const secondMint = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const second = parsePumpPortalMessage(
      { txType: "create", mint: secondMint },
      1793500020000,
    );
    const outcome = store.ingestEvent(second, 1);
    assert.equal(outcome.inserted, true);
    assert.equal(outcome.monitoringEligible, false);
    store.close();
    currentStore = undefined;
    const reopened = new SentinelStore(join(dir, "sentinel.db"));
    currentStore = reopened;
    await reopened.open();
    assert.equal(reopened.eventCount(), 3);
    assert.equal(
      reopened.getToken(launch.mint)?.marketPhase,
      "MIGRATED_UNKNOWN_VENUE",
    );
    reopened.close();
    currentStore = undefined;
  } finally {
    currentStore?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("applies the mint-state migration to an existing version-one database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentinel-upgrade-"));
  const dbPath = join(dir, "legacy.db");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at_utc TEXT NOT NULL)",
  );
  legacy.exec(
    await readFile("packages/storage/migrations/001-initial.sql", "utf8"),
  );
  legacy
    .prepare(
      "INSERT INTO schema_migrations(version, applied_at_utc) VALUES (1, ?)",
    )
    .run(new Date().toISOString());
  legacy
    .prepare(
      `INSERT INTO tokens
      (mint, first_seen_at_utc, last_seen_at_utc, market_phase, monitoring_eligible, event_count)
      VALUES (?, ?, ?, 'PUMP_CURVE', 1, 1)`,
    )
    .run(
      "So11111111111111111111111111111111111111112",
      new Date().toISOString(),
      new Date().toISOString(),
    );
  legacy.close();

  const store = new SentinelStore(dbPath);
  await store.open();
  try {
    assert.equal(
      store.getToken("So11111111111111111111111111111111111111112")
        ?.mintStateStatus,
      "UNKNOWN",
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("skips columns already present in a partially migrated version-one database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentinel-partial-upgrade-"));
  const dbPath = join(dir, "partial.db");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at_utc TEXT NOT NULL)",
  );
  legacy.exec(
    await readFile("packages/storage/migrations/001-initial.sql", "utf8"),
  );
  legacy
    .prepare(
      "INSERT INTO schema_migrations(version, applied_at_utc) VALUES (1, ?)",
    )
    .run(new Date().toISOString());
  legacy.exec(
    await readFile(
      "packages/storage/migrations/002-mint-state-and-provenance.sql",
      "utf8",
    ),
  );
  legacy.close();

  const store = new SentinelStore(dbPath);
  await store.open();
  try {
    assert.equal(store.eventCount(), 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("uses one socket, re-subscribes after disconnect, consumes events, and stops cleanly", async () => {
  class FakeSocket extends EventEmitter {
    sent: string[] = [];
    send(value: string): void {
      this.sent.push(value);
    }
    close(): void {
      this.emit("close");
    }
    ping(): void {
      this.emit("pong");
    }
    terminate(): void {
      this.emit("close");
    }
  }
  const sockets: FakeSocket[] = [];
  const received: string[] = [];
  const healthStates: string[] = [];
  const client = new PumpPortalClient({
    apiKey: "test-key",
    enableNewTokens: true,
    enableMigrations: true,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      setImmediate(() => socket.emit("open"));
      return socket as unknown as WebSocket;
    },
    onEvent: async (event) => {
      received.push(event.kind);
    },
    onHealth: (state) => {
      healthStates.push(state);
    },
    minBackoffMs: 1,
    maxBackoffMs: 1,
    heartbeatMs: 60000,
    random: () => 0,
  });
  const running = client.start();
  while (sockets.length < 1 || !sockets[0]?.sent.length)
    await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    sockets[0]?.sent.map(
      (item) => (JSON.parse(item) as { method: string }).method,
    ),
    ["subscribeNewToken", "subscribeMigration"],
  );
  sockets[0]?.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        txType: "create",
        mint: "So11111111111111111111111111111111111111112",
      }),
    ),
  );
  while (received.length < 1)
    await new Promise((resolve) => setImmediate(resolve));
  sockets[0]?.close();
  while (sockets.length < 2 || !sockets[1]?.sent.length)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.reconnectCount, 1);
  assert.equal(sockets.length, 2);
  await client.stop();
  await running;
  assert.equal(healthStates.at(-1), "STOPPED");
});
