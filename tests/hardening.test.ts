import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isSolanaPubkey } from "@sentinel/domain";
import {
  HeliusRpcClient,
  classifyPumpPortalFrame,
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

test("Helius daily budget reserves capacity for exit quotes and reports method usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-helius-priority-"));
  const store = new SentinelStore(join(directory, "sentinel.db"));
  await store.open();
  try {
    for (let index = 0; index < 8; index += 1)
      assert.equal(store.tryConsumeHeliusRequest(10, 2, "BACKGROUND"), true);
    assert.equal(store.tryConsumeHeliusRequest(10, 2, "CANDIDATE"), false);
    assert.equal(store.tryConsumeHeliusRequest(10, 2, "EXIT"), true);
    store.recordHeliusRequestOutcome({
      method: "getMultipleAccounts",
      priority: "EXIT",
      component: "paper_position_monitor",
      purpose: "risk_reducing_exit_quote",
      subjectMint: "So11111111111111111111111111111111111111112",
      attempt: 1,
      outcome: "SUCCEEDED",
      errorCode: null,
    });
    assert.equal(store.tryConsumeHeliusRequest(10, 2, "EXIT"), true);
    assert.equal(store.tryConsumeHeliusRequest(10, 2, "EXIT"), false);
    const budget = store.getHeliusRequestBudget(10, 2);
    assert.equal(budget.used, 10);
    assert.equal(budget.remaining, 0);
    assert.equal(budget.exitRequestsUsed, 2);
    assert.deepEqual(budget.byMethod, [
      { method: "UNKNOWN", requests: 10, failures: 0 },
    ]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Helius rolling limits are atomic across store instances and reserve exit capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-helius-rolling-"));
  const path = join(directory, "sentinel.db");
  const first = new SentinelStore(path);
  const second = new SentinelStore(path);
  await first.open();
  await second.open();
  const nowMs = Date.now();
  const consume = (store: SentinelStore, priority: "EXIT" | "CANDIDATE") =>
    store.consumeHeliusRequest({
      maxRequestsPerUtcDay: 10,
      exitReservedRequestsPerUtcDay: 2,
      maxRequestsPerWindow: 4,
      requestWindowSeconds: 300,
      maxRequestsPerSecond: 10,
      priority,
      method: "getAccountInfo",
      nowMs,
    });
  try {
    const candidates = Array.from({ length: 8 }, (_, index) =>
      consume(index % 2 === 0 ? first : second, "CANDIDATE"),
    );
    assert.equal(candidates.filter((item) => item.allowed).length, 3);
    assert.equal(candidates[3]?.reasonCode, "REQUEST_WINDOW_BUDGET_EXHAUSTED");
    assert.equal(consume(first, "EXIT").allowed, true);
    assert.equal(
      consume(second, "EXIT").reasonCode,
      "REQUEST_WINDOW_BUDGET_EXHAUSTED",
    );
    const budget = first.getHeliusRequestBudget(10, 2, {
      maxRequestsPerWindow: 4,
      requestWindowSeconds: 300,
    });
    assert.equal(budget.rollingUsed, 4);
    assert.equal(budget.rollingRemaining, 0);
    assert.equal(budget.reservedForExitsWindow, 1);
    assert.equal(budget.exitRequestsUsed, 1);
  } finally {
    second.close();
    first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Helius rolling request reservations persist across store restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-helius-restart-"));
  const path = join(directory, "sentinel.db");
  const policy = {
    maxRequestsPerUtcDay: 10,
    exitReservedRequestsPerUtcDay: 0,
    maxRequestsPerWindow: 2,
    requestWindowSeconds: 300,
    maxRequestsPerSecond: 10,
    priority: "CANDIDATE" as const,
    nowMs: Date.now(),
  };
  const first = new SentinelStore(path);
  await first.open();
  try {
    assert.equal(first.consumeHeliusRequest(policy).allowed, true);
  } finally {
    first.close();
  }
  const restarted = new SentinelStore(path);
  await restarted.open();
  try {
    assert.equal(restarted.consumeHeliusRequest(policy).allowed, true);
    assert.equal(
      restarted.consumeHeliusRequest(policy).reasonCode,
      "REQUEST_WINDOW_BUDGET_EXHAUSTED",
    );
    assert.equal(
      restarted.getHeliusRequestBudget(10, 0, {
        maxRequestsPerWindow: 2,
        requestWindowSeconds: 300,
      }).rollingUsed,
      2,
    );
  } finally {
    restarted.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Helius counts every failed outbound retry against persisted rolling and daily budgets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-helius-retries-"));
  const store = new SentinelStore(join(directory, "sentinel.db"));
  await store.open();
  let attempts = 0;
  const config = {
    maxRequestsPerUtcDay: 10,
    exitReservedRequestsPerUtcDay: 2,
    maxRequestsPerWindow: 10,
    requestWindowSeconds: 300,
    maxRequestsPerSecond: 100,
  };
  const client = new HeliusRpcClient({
    apiKey: "test",
    requestTimeoutMs: 1000,
    maxRequestsPerSecond: 100,
    consumeRequestBudget: (request) =>
      store.consumeHeliusRequest({ ...config, ...request }),
    recordRequestOutcome: (request) =>
      store.recordHeliusRequestOutcome(request),
    fetchImpl: async () => {
      attempts += 1;
      return new Response("", { status: 503 });
    },
  });
  try {
    await assert.rejects(
      () =>
        client.getAccountInfo("So11111111111111111111111111111111111111112"),
      /PROVIDER_UNAVAILABLE/,
    );
    assert.equal(attempts, 3);
    const budget = store.getHeliusRequestBudget(10, 2, {
      maxRequestsPerWindow: 10,
      requestWindowSeconds: 300,
    });
    assert.equal(budget.used, 3);
    assert.equal(budget.rollingUsed, 3);
    assert.equal(budget.byMethod[0]?.requests, 3);
    assert.equal(budget.byMethod[0]?.failures, 3);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("PumpPortal frame classes persist bounded sanitized provider errors", async () => {
  const event = classifyPumpPortalFrame({
    txType: "create",
    mint: "So11111111111111111111111111111111111111112",
  });
  assert.equal(event.classification, "TOKEN_EVENT");
  assert.equal(
    classifyPumpPortalFrame({ errors: [{ code: "RATE_LIMIT" }] })
      .classification,
    "PROVIDER_ERROR",
  );
  assert.equal(
    classifyPumpPortalFrame({
      message: "Successfully subscribed to migrations",
    }).classification,
    "PROVIDER_CONTROL",
  );
  const unknownMessage = classifyPumpPortalFrame({
    message: "unknown response",
  });
  assert.equal(unknownMessage.classification, "PROVIDER_ERROR");
  assert.equal(
    classifyPumpPortalFrame({ type: "new-protocol-frame" }).classification,
    "UNSUPPORTED_FRAME",
  );
  assert.equal(
    classifyPumpPortalFrame({ txType: "create", mint: "not-a-mint" })
      .classification,
    "MALFORMED_FRAME",
  );
  const directory = await mkdtemp(join(tmpdir(), "sentinel-provider-frame-"));
  const store = new SentinelStore(join(directory, "sentinel.db"));
  await store.open();
  try {
    const errorFrame = classifyPumpPortalFrame({
      errors: [{ code: "RATE_LIMIT", apiKey: "never-store-this" }],
    });
    assert.equal(errorFrame.classification, "PROVIDER_ERROR");
    store.recordProviderFrameDiagnostic({
      ...errorFrame,
      observedAtUtc: "2026-11-01T00:00:00.000Z",
    });
    const persisted = store.listProviderFrameDiagnostics()[0];
    assert.equal(persisted?.["classification"], "PROVIDER_ERROR");
    assert.equal(
      String(persisted?.["sanitizedPayload"]).includes("never-store-this"),
      false,
    );
    assert.equal(
      String(persisted?.["sanitizedPayload"]).includes("[REDACTED]"),
      true,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration-first events resolve by signature and enqueue analysis without inventing a creator", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "sentinel-migration-recovery-"),
  );
  const store = new SentinelStore(join(directory, "sentinel.db"));
  await store.open();
  const signature = "1".repeat(64);
  const event = parsePumpPortalMessage({
    txType: "migrate",
    mint: "So11111111111111111111111111111111111111112",
    signature,
    traderPublicKey: "11111111111111111111111111111111",
  });
  store.ingestEvent(event, 10, true);
  const helius = {
    getTransaction: async (requested: string) => ({
      signature: requested,
      slot: 464027585,
      blockTime: 1793522301,
      succeeded: true,
      feeLamports: 5000,
      accountKeys: [{ pubkey: event.mint, signer: false, writable: true }],
      instructions: [],
      logMessages: [],
      preBalances: [],
      postBalances: [],
    }),
  } as unknown as HeliusRpcClient;
  const scheduler = new EnrichmentScheduler(store, helius, 1);
  const pause = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  try {
    assert.equal(store.getToken(event.mint)?.migrationSlot, null);
    assert.equal(store.claimAnalysisJob(), null);
    scheduler.start();
    for (
      let attempt = 0;
      attempt < 200 &&
      store.getMigrationRecoveryStatus(event.mint)[0]?.["status"] !==
        "COMPLETE";
      attempt += 1
    )
      await pause(10);
    assert.equal(
      store.getMigrationRecoveryStatus(event.mint)[0]?.["status"],
      "COMPLETE",
    );
    assert.equal(store.getToken(event.mint)?.migrationSlot, 464027585);
    assert.equal(
      store.getToken(event.mint)?.marketPhase,
      "MIGRATED_UNKNOWN_VENUE",
    );
    assert.equal(store.getToken(event.mint)?.creator, null);
    assert.equal(store.getToken(event.mint)?.launchInitiator, null);
    assert.equal(store.getMarketEventSummary(event.id)?.slot, 464027585);
    assert.equal(store.getDiscoveryCheckpoint()?.lastSlot, 464027585);
    assert.equal(store.claimAnalysisJob()?.eventId, event.id);
  } finally {
    await scheduler.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("interrupted migration recovery jobs are reclaimed after restart", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "sentinel-migration-restart-"),
  );
  const dbPath = join(directory, "sentinel.db");
  let store = new SentinelStore(dbPath);
  await store.open();
  const event = parsePumpPortalMessage({
    txType: "migrate",
    mint: "So11111111111111111111111111111111111111112",
    signature: "1".repeat(64),
  });
  store.ingestEvent(event, 10, true);
  assert.equal(store.claimMigrationRecoveryJob()?.eventId, event.id);
  store.close();
  store = new SentinelStore(dbPath);
  await store.open();
  try {
    assert.equal(store.recoverInterruptedMigrationJobs(), 1);
    assert.equal(store.claimMigrationRecoveryJob()?.eventId, event.id);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration recovery rejects failed transactions, mismatched slots, and unrelated mints", async () => {
  const cases = [
    {
      name: "failed",
      providerSlot: undefined,
      txSlot: 100,
      succeeded: false,
      txMint: "So11111111111111111111111111111111111111112",
      reason: "MIGRATION_TRANSACTION_FAILED",
    },
    {
      name: "slot",
      providerSlot: 99,
      txSlot: 100,
      succeeded: true,
      txMint: "So11111111111111111111111111111111111111112",
      reason: "MIGRATION_SLOT_MISMATCH",
    },
    {
      name: "mint",
      providerSlot: undefined,
      txSlot: 100,
      succeeded: true,
      txMint: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      reason: "MIGRATION_MINT_NOT_IN_TRANSACTION",
    },
  ] as const;
  for (const [index, item] of cases.entries()) {
    const directory = await mkdtemp(
      join(tmpdir(), `sentinel-migration-${item.name}-`),
    );
    const store = new SentinelStore(join(directory, "sentinel.db"));
    await store.open();
    const event = parsePumpPortalMessage({
      txType: "migrate",
      mint: "So11111111111111111111111111111111111111112",
      signature: "1".repeat(64),
      ...(item.providerSlot === undefined ? {} : { slot: item.providerSlot }),
    });
    store.ingestEvent(event, 10, true);
    const helius = {
      getTransaction: async (signature: string) => ({
        signature,
        slot: item.txSlot,
        blockTime: null,
        succeeded: item.succeeded,
        feeLamports: 5000,
        accountKeys: [{ pubkey: item.txMint, signer: false, writable: true }],
        instructions: [],
        logMessages: [],
        preBalances: [],
        postBalances: [],
      }),
    } as unknown as HeliusRpcClient;
    const scheduler = new EnrichmentScheduler(store, helius, 1);
    try {
      scheduler.start();
      for (
        let attempt = 0;
        attempt < 200 &&
        store.getMigrationRecoveryStatus(event.mint)[0]?.["status"] !==
          "FAILED";
        attempt += 1
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      const outcome = store.getMigrationRecoveryStatus(event.mint)[0];
      assert.equal(
        outcome?.["status"],
        "FAILED",
        `case ${index}: ${item.name}`,
      );
      assert.equal(outcome?.["errorCode"], item.reason);
      assert.equal(store.getToken(event.mint)?.migrationSlot, null);
      assert.equal(store.claimAnalysisJob()?.eventId, event.id);
    } finally {
      await scheduler.stop();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
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
  let resolveSocketOpened!: () => void;
  const socketOpened = new Promise<void>(
    (resolve) => (resolveSocketOpened = resolve),
  );
  const client = new PumpPortalClient({
    apiKey: "test",
    enableNewTokens: true,
    enableMigrations: false,
    persistEvent: () => {
      persisted += 1;
    },
    socketFactory: () => {
      setImmediate(() => {
        socket.emit("open");
        resolveSocketOpened();
      });
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
    await socketOpened;
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
  let resolveFirstOpen!: () => void;
  let resolveSecondOpen!: () => void;
  const firstSocketOpened = new Promise<void>(
    (resolve) => (resolveFirstOpen = resolve),
  );
  const secondSocketOpened = new Promise<void>(
    (resolve) => (resolveSecondOpen = resolve),
  );
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
      setImmediate(() => {
        socket.emit("open");
        if (sockets.length === 1) resolveFirstOpen();
        if (sockets.length === 2) resolveSecondOpen();
      });
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
  try {
    await firstSocketOpened;
    const socket = sockets[0];
    assert.ok(socket);
    const mint = "So11111111111111111111111111111111111111112";
    for (const name of ["Burst A", "Burst B", "Burst C"])
      socket.emit(
        "message",
        Buffer.from(JSON.stringify({ txType: "create", mint, name })),
      );
    await secondSocketOpened;
    await client.waitForIdle();
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

test("a completed callback from a disconnected socket cannot restore HEALTHY", async () => {
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
  const sockets: Socket[] = [];
  let resolveFirstOpen!: () => void;
  let resolveSecondOpen!: () => void;
  let resolveHandlerStarted!: () => void;
  let releaseHandler!: () => void;
  const firstSocketOpened = new Promise<void>(
    (resolve) => (resolveFirstOpen = resolve),
  );
  const secondSocketOpened = new Promise<void>(
    (resolve) => (resolveSecondOpen = resolve),
  );
  const handlerStarted = new Promise<void>(
    (resolve) => (resolveHandlerStarted = resolve),
  );
  const heldHandler = new Promise<void>(
    (resolve) => (releaseHandler = resolve),
  );
  const health: Array<{ state: string; reconnectCount: number }> = [];
  const client = new PumpPortalClient({
    apiKey: "test",
    enableNewTokens: true,
    enableMigrations: false,
    minBackoffMs: 1,
    maxBackoffMs: 1,
    heartbeatMs: 60000,
    socketFactory: () => {
      const socket = new Socket();
      sockets.push(socket);
      setImmediate(() => {
        socket.emit("open");
        if (sockets.length === 1) resolveFirstOpen();
        if (sockets.length === 2) resolveSecondOpen();
      });
      return socket as unknown as WebSocket;
    },
    onEvent: () => {
      resolveHandlerStarted();
      return heldHandler;
    },
    onHealth: (state, reconnectCount) => health.push({ state, reconnectCount }),
  });
  const running = client.start();
  try {
    await firstSocketOpened;
    const firstSocket = sockets[0];
    assert.ok(firstSocket);
    firstSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          txType: "create",
          mint: "So11111111111111111111111111111111111111112",
        }),
      ),
    );
    await handlerStarted;
    firstSocket.terminate();
    await secondSocketOpened;

    const healthyAfterReconnect = () =>
      health.filter(
        (item) => item.state === "HEALTHY" && item.reconnectCount > 0,
      ).length;
    assert.equal(healthyAfterReconnect(), 1);

    releaseHandler();
    await client.waitForIdle();
    assert.equal(healthyAfterReconnect(), 1);
  } finally {
    releaseHandler();
    await client.stop();
    await running;
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
