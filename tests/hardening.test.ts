import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isSolanaPubkey } from "@sentinel/domain";
import {
  HeliusRpcClient,
  parsePumpPortalMessage,
  PumpPortalClient,
  pumpPortalHealth,
} from "@sentinel/providers";
import { SentinelStore } from "@sentinel/storage";
import { EnrichmentScheduler } from "../apps/worker/src/enrichment.ts";
import type WebSocket from "ws";

test("public key validation checks decoded byte length, not just alphabet and text length", () => {
  assert.equal(
    isSolanaPubkey("So11111111111111111111111111111111111111112"),
    true,
  );
  assert.equal(isSolanaPubkey("1".repeat(32)), true);
  assert.equal(isSolanaPubkey("A".repeat(32)), false);
  assert.equal(isSolanaPubkey("0".repeat(32)), false);
});

test("Helius request budget rejects before network access", async () => {
  let fetchCount = 0;
  const client = new HeliusRpcClient({
    apiKey: "test",
    requestTimeoutMs: 1000,
    consumeRequestBudget: () => false,
    fetchImpl: async () => {
      fetchCount += 1;
      return Response.json({ jsonrpc: "2.0", id: 1, result: null });
    },
  });
  await assert.rejects(
    () => client.getAccountInfo("So11111111111111111111111111111111111111112"),
    /REQUEST_BUDGET_EXHAUSTED/,
  );
  assert.equal(fetchCount, 0);
});

test("provider health distinguishes a socket from a protocol failure and exposes lag", () => {
  const health = pumpPortalHealth(
    "DEGRADED",
    2,
    "MALFORMED_EVENT",
    "2026-11-01T02:26:40.000Z",
    3,
    "2026-11-01T02:26:40.025Z",
  );
  assert.equal(health.connectionState, "CONNECTED");
  assert.equal(health.errorCode, "MALFORMED_EVENT");
  assert.equal(health.queueDepth, 3);
  assert.equal(health.processingLagMs, 25);
  assert.equal(
    pumpPortalHealth("DEGRADED", 2, "SOCKET_DISCONNECTED", null)
      .connectionState,
    "DISCONNECTED",
  );
});

test("interrupted enrichment jobs recover after a database restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-recovery-"));
  const dbPath = join(directory, "sentinel.db");
  let store = new SentinelStore(dbPath);
  await store.open();
  const event = parsePumpPortalMessage({
    txType: "create",
    mint: "So11111111111111111111111111111111111111112",
    slot: 341197053,
  });
  store.ingestEvent(event, 10, true);
  const claimed = store.claimEnrichmentJob();
  assert.equal(claimed?.eventId, event.id);
  store.close();
  store = new SentinelStore(dbPath);
  await store.open();
  try {
    assert.equal(store.recoverInterruptedEnrichmentJobs(), 1);
    assert.equal(store.claimEnrichmentJob()?.eventId, event.id);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mint validation survives an independent block-time provider failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-split-enrichment-"));
  const store = new SentinelStore(join(directory, "sentinel.db"));
  await store.open();
  const event = parsePumpPortalMessage({
    txType: "create",
    mint: "So11111111111111111111111111111111111111112",
    slot: 341197053,
  });
  store.ingestEvent(event, 10, true);
  let accountRequests = 0;
  let timeRequests = 0;
  const helius = new HeliusRpcClient({
    apiKey: "test",
    requestTimeoutMs: 1000,
    maxRequestsPerSecond: 1000,
    consumeRequestBudget: () => store.tryConsumeHeliusRequest(100),
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === "getAccountInfo") {
        accountRequests += 1;
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            context: { slot: 341197053 },
            value: {
              owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
              data: ["AQID", "base64"],
              executable: false,
            },
          },
        });
      }
      timeRequests += 1;
      return new Response("", { status: 400 });
    },
  });
  const scheduler = new EnrichmentScheduler(store, helius, 1);
  const pause = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  try {
    scheduler.start();
    for (
      let attempt = 0;
      attempt < 500 && store.getEnrichmentJobStatus(event.id) !== "FAILED";
      attempt += 1
    )
      await pause(10);
    assert.equal(store.getEnrichmentJobStatus(event.id), "FAILED");
    assert.equal(store.getToken(event.mint)?.mintStateStatus, "PRESENT");
    assert.equal(
      store.getEventTimestampStatus(event.id)?.status,
      "PROVIDER_ERROR",
    );
    assert.equal(
      store.getEventTimestampStatus(event.id)?.errorCode,
      "RPC_REJECTED",
    );
    assert.equal(accountRequests, 1);
    assert.equal(timeRequests, 3);
  } finally {
    await scheduler.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("PumpPortal event handling applies a pending-event bound and stop drains callbacks", async () => {
  class Socket extends EventEmitter {
    send(): void {}
    ping(): void {}
    close(): void {
      this.emit("close");
    }
    terminate(): void {
      this.emit("close");
    }
  }
  const socket = new Socket();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const healthErrors: string[] = [];
  const healthStates: string[] = [];
  let callbacks = 0;
  let persisted = 0;
  const client = new PumpPortalClient({
    apiKey: "test",
    enableNewTokens: true,
    enableMigrations: false,
    persistEvent: () => {
      persisted += 1;
    },
    socketFactory: () => {
      setImmediate(() => socket.emit("open"));
      return socket as unknown as WebSocket;
    },
    onEvent: async () => {
      callbacks += 1;
      await blocked;
    },
    onHealth: (_state, _count, errorCode) => {
      healthStates.push(_state);
      if (errorCode) healthErrors.push(errorCode);
    },
    maxPendingEvents: 1,
    eventProcessingConcurrency: 1,
    minBackoffMs: 100,
    maxBackoffMs: 100,
    heartbeatMs: 60000,
  });
  const running = client.start();
  try {
    while (!socket.listenerCount("message"))
      await new Promise((resolve) => setImmediate(resolve));
    const message = JSON.stringify({
      txType: "create",
      mint: "So11111111111111111111111111111111111111112",
    });
    socket.emit("message", Buffer.from(message));
    socket.emit("message", Buffer.from(message));
    socket.emit("message", Buffer.from(message));
    assert.deepEqual(healthErrors, ["EVENT_BACKPRESSURE"]);
    assert.equal(persisted, 3);
    assert.equal(callbacks, 0); // post-persist processing is scheduled separately
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(callbacks, 1);
    let stopped = false;
    const stopping = client.stop().then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(stopped, false);
    release();
    await stopping;
    await running;
    assert.equal(stopped, true);
    assert.deepEqual(healthStates.slice(-1), ["STOPPED"]);
    assert.equal(
      healthStates
        .slice(healthStates.lastIndexOf("STOPPED") + 1)
        .includes("HEALTHY"),
      false,
    );
    assert.equal(callbacks, 2);
  } finally {
    release();
    await client.stop();
  }
});

test("burst overflow is persisted, reconnect gaps are exposed, and completeness stays unclaimed", async () => {
  class Socket extends EventEmitter {
    send(): void {}
    ping(): void {}
    close(): void {
      this.emit("close");
    }
    terminate(): void {
      this.emit("close");
    }
  }
  const directory = await mkdtemp(join(tmpdir(), "sentinel-completeness-"));
  const store = new SentinelStore(join(directory, "sentinel.db"));
  await store.open();
  const sockets: Socket[] = [];
  const client = new PumpPortalClient({
    apiKey: "test",
    enableNewTokens: true,
    enableMigrations: true,
    eventProcessingConcurrency: 1,
    maxPendingEvents: 1,
    minBackoffMs: 1,
    maxBackoffMs: 1,
    heartbeatMs: 60000,
    socketFactory: () => {
      const socket = new Socket();
      sockets.push(socket);
      setImmediate(() => socket.emit("open"));
      return socket as unknown as WebSocket;
    },
    persistEvent: (event) => {
      store.ingestEvent(event, 10);
    },
    onEvent: async () => new Promise((resolve) => setTimeout(resolve, 10)),
    onHealth: (
      state,
      reconnectCount,
      errorCode,
      lastEventAtUtc,
      queueDepth,
      processedAt,
    ) => {
      const health = pumpPortalHealth(
        state,
        reconnectCount,
        errorCode,
        lastEventAtUtc,
        queueDepth,
        processedAt,
      );
      store.setProviderHealth(health);
      if (health.connectionState === "DISCONNECTED")
        store.recordStreamDisconnect(errorCode ?? "SOCKET_DISCONNECTED");
      if (state === "HEALTHY" && reconnectCount > 0)
        store.recordStreamReconnect();
      if (state === "DEGRADED" && errorCode)
        store.recordProviderIssue("pumpportal", errorCode);
    },
  });
  const running = client.start();
  const pause = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  try {
    for (let attempt = 0; attempt < 100 && sockets.length < 1; attempt += 1)
      await pause(5);
    const socket = sockets[0];
    assert.ok(socket);
    const mint = "So11111111111111111111111111111111111111112";
    for (const name of ["Burst A", "Burst B", "Burst C"])
      socket.emit(
        "message",
        Buffer.from(JSON.stringify({ txType: "create", mint, name })),
      );
    for (
      let attempt = 0;
      attempt < 100 &&
      !(
        store.getStreamCompleteness().coverageStatus === "GAPS_UNRECONCILED" &&
        store
          .listProviderHealth()
          .some(
            (health) =>
              health.provider === "pumpportal" &&
              health.reconnectCount > 0 &&
              health.state === "HEALTHY",
          )
      );
      attempt += 1
    )
      await pause(5);
    const completeness = store.getStreamCompleteness();
    assert.equal(store.eventCount(), 3);
    assert.equal(completeness.coverageStatus, "GAPS_UNRECONCILED");
    assert.equal(completeness.unreconciledGapCount, 1);
    assert.equal(completeness.historyComplete, false);
    assert.ok(completeness.providerIssueOccurrences > 0);
    assert.ok(sockets.length >= 2);
  } finally {
    await client.stop();
    await running;
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded enrichment drains an in-flight Helius request before database close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-drain-"));
  const store = new SentinelStore(join(directory, "sentinel.db"));
  await store.open();
  const mints = [
    "So11111111111111111111111111111111111111112",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "AArPXm8JatJiuyEffuC1un2Sc835SULa4uQqDcaGpAjV",
  ];
  for (let index = 0; index < mints.length; index += 1) {
    const event = parsePumpPortalMessage(
      {
        txType: "create",
        mint: mints[index],
        slot: 341197060 + index,
        traderPublicKey: "11111111111111111111111111111111",
      },
      1793500000000 + index,
    );
    store.ingestEvent(event, 10, true);
  }

  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  let currentRequests = 0;
  let peakRequests = 0;
  let accountRequests = 0;
  const helius = new HeliusRpcClient({
    apiKey: "test",
    requestTimeoutMs: 5000,
    maxRequestsPerSecond: 1000,
    consumeRequestBudget: () => store.tryConsumeHeliusRequest(100),
    fetchImpl: async (_url, init) => {
      currentRequests += 1;
      peakRequests = Math.max(peakRequests, currentRequests);
      const body = JSON.parse(String(init?.body)) as { method: string };
      try {
        if (body.method === "getAccountInfo") {
          accountRequests += 1;
          await blocked;
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: { context: { slot: 341197060 }, value: null },
          });
        }
        return Response.json({ jsonrpc: "2.0", id: 1, result: 1793500000 });
      } finally {
        currentRequests -= 1;
      }
    },
  });
  const scheduler = new EnrichmentScheduler(store, helius, 2);
  const pause = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  try {
    scheduler.start();
    for (let attempt = 0; attempt < 100 && accountRequests < 2; attempt += 1)
      await pause(5);
    assert.equal(accountRequests, 2);
    assert.equal(peakRequests, 2);
    let stopped = false;
    const stopping = scheduler.stop().then(() => (stopped = true));
    await pause(20);
    assert.equal(stopped, false);
    release();
    await stopping;
    assert.equal(stopped, true);
    assert.equal(peakRequests, 2);
    assert.equal(store.tryConsumeHeliusRequest(100), true);
  } finally {
    release();
    await scheduler.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
