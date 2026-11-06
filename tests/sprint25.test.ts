import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  analyzeLaunchBehavior,
  detectWalletTokenOutflows,
} from "@sentinel/intelligence";
import {
  JupiterQuoteClient,
  PumpCurveQuoteEngine,
  PumpCurveStateLoader,
  PumpSwapQuoteEngine,
  PumpSwapStateLoader,
  type PumpCurveQuoteState,
  type WalletTransaction,
} from "@sentinel/providers";
import type {
  LaunchTradeObservation,
  MarketSnapshot,
  QuoteRequest,
} from "@sentinel/domain";
import { SentinelStore } from "@sentinel/storage";

const mint = "So11111111111111111111111111111111111111112";
const otherMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const utc = "2026-11-01T00:00:00.000Z";

function trade(
  input: Partial<LaunchTradeObservation> = {},
): LaunchTradeObservation {
  return {
    id: input.id ?? "trade-1",
    eventIndex: input.eventIndex ?? 0,
    mint,
    signature: input.signature ?? "sig-1",
    slot: input.slot ?? 100,
    blockTimeUtc: input.blockTimeUtc ?? utc,
    eventTimeUtc: input.eventTimeUtc ?? utc,
    eventTimeSource: input.eventTimeSource ?? "PUMP_TRADE_EVENT_TIMESTAMP",
    receivedAtUtc: input.receivedAtUtc ?? utc,
    ingestedAtUtc: input.ingestedAtUtc ?? input.receivedAtUtc ?? utc,
    side: input.side ?? "BUY",
    traderWallet: input.traderWallet ?? otherMint,
    tokenAmountRaw: input.tokenAmountRaw ?? "1000",
    quoteAmountRaw: input.quoteAmountRaw ?? "100",
    quoteMint: input.quoteMint ?? "So11111111111111111111111111111111111111112",
    venue: input.venue ?? "PUMP_BONDING_CURVE",
    source: input.source ?? "SANITIZED_FIXTURE",
    validationStatus: input.validationStatus ?? "VERIFIED",
    validationConfidenceBps: input.validationConfidenceBps ?? 10000,
    decoderVersion: input.decoderVersion ?? "SYNTHETIC_TEST_IDL",
    payloadRef: input.payloadRef ?? `sha256:${"a".repeat(64)}`,
  };
}

test("Jupiter quote-only request never sends a taker or accepts a transaction", async () => {
  let requestedUrl = "";
  const client = new JupiterQuoteClient({
    timeoutMs: 1000,
    now: () => Date.parse(utc),
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          transaction: null,
          requestId: "read-only-fixture",
          inAmount: "1000000000",
          outAmount: "123456",
          router: "metis",
          mode: "ultra",
          feeBps: 0,
          feeMint: mint,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const request: QuoteRequest = {
    mint: otherMint,
    direction: "BUY",
    exactInputAmountRaw: "1000000000",
    inputMint: mint,
    outputMint: otherMint,
    maxAgeMs: 1000,
    requestedAtUtc: utc,
  };
  const quote = await client.quote(request);
  assert.equal(new URL(requestedUrl).searchParams.has("taker"), false);
  assert.equal(new URL(requestedUrl).pathname, "/swap/v2/order");
  assert.equal(quote.expectedOutputAmountRaw, "123456");
  assert.equal(quote.snapshotSlot, null);
  assert.equal(quote.validationStatus, "UNKNOWN");
  assert.equal(quote.failureReason, "PRICE_IMPACT_UNKNOWN");
});

test("Jupiter response with a transaction payload is rejected", async () => {
  const client = new JupiterQuoteClient({
    timeoutMs: 1000,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          transaction: "unsigned-transaction-must-not-be-used",
          requestId: "fixture",
          outAmount: "1",
          router: "metis",
          mode: "ultra",
          feeBps: 0,
          feeMint: mint,
        }),
        { status: 200 },
      ),
  });
  const quote = await client.quote({
    mint: otherMint,
    direction: "BUY",
    exactInputAmountRaw: "1",
    inputMint: mint,
    outputMint: otherMint,
    maxAgeMs: 1000,
    requestedAtUtc: utc,
  });
  assert.equal(quote.validationStatus, "FAIL");
  assert.equal(quote.expectedOutputAmountRaw, null);
  assert.equal(quote.failureReason, "MALFORMED_PROVIDER_DATA");
});

test("Jupiter persistent request budget rejects before network access", async () => {
  let fetchCount = 0;
  const client = new JupiterQuoteClient({
    timeoutMs: 1000,
    consumeRequestBudget: () => false,
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("must not fetch");
    },
  });
  const quote = await client.quote({
    mint: otherMint,
    direction: "BUY",
    exactInputAmountRaw: "1",
    inputMint: mint,
    outputMint: otherMint,
    maxAgeMs: 1000,
    requestedAtUtc: utc,
  });
  assert.equal(quote.failureReason, "PROVIDER_BUDGET_EXHAUSTED");
  assert.equal(fetchCount, 0);
});

test("Pump curve quote engine rejects migrated venue and stale snapshots", () => {
  const engine = new PumpCurveQuoteEngine();
  const request: QuoteRequest = {
    mint: otherMint,
    direction: "BUY",
    exactInputAmountRaw: "1000000000",
    inputMint: mint,
    outputMint: otherMint,
    maxAgeMs: 100,
    requestedAtUtc: utc,
  };
  const snapshot: MarketSnapshot = {
    mint: otherMint,
    venue: "PUMPSWAP",
    slot: 100,
    observedAtUtc: utc,
    source: "HELIUS_RPC",
    stateRef: "pool:fixture",
    baseReserveRaw: "1000",
    quoteReserveRaw: "1000",
    liquidityQuoteRaw: "1000",
    confidenceBps: 10000,
  };
  const unsupported = engine.quote(request, {
    snapshot,
  } as unknown as PumpCurveQuoteState);
  assert.equal(unsupported.failureReason, "VENUE_UNSUPPORTED");

  const stale = engine.quote(request, {
    snapshot: {
      ...snapshot,
      venue: "PUMP_BONDING_CURVE",
      observedAtUtc: "2026-10-31T23:59:59.000Z",
    },
  } as unknown as PumpCurveQuoteState);
  assert.equal(stale.failureReason, "STALE_SNAPSHOT");
  assert.equal(stale.validationStatus, "FAIL");
});

test("Helius captured Pump curve state produces deterministic SDK buy and sell quotes", async () => {
  const capture = JSON.parse(
    await readFile(
      "tests/fixtures/captures/pump-curve-state-2026-11-01.json",
      "utf8",
    ),
  ) as {
    mint: string;
    slot: number;
    capturedAtUtc: string;
    accounts: Array<{
      address: string;
      owner: string;
      dataBase64: string;
      executable: boolean;
    } | null>;
  };
  const fakeHelius = {
    async getMultipleAccounts(addresses: string[]) {
      return {
        slot: capture.slot,
        accounts: addresses.map(
          (address) =>
            capture.accounts.find((account) => account?.address === address) ??
            null,
        ),
      };
    },
  };
  const capturedAtMs = Date.parse(capture.capturedAtUtc);
  const loaded = await new PumpCurveStateLoader({
    helius: fakeHelius as never,
    now: () => capturedAtMs,
  }).load(capture.mint);
  assert.equal(loaded.status, "SUPPORTED");
  if (loaded.status !== "SUPPORTED") return;
  assert.equal(loaded.state.snapshot.slot, 464003571);
  assert.equal(
    loaded.mintProgramId,
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  );

  const engine = new PumpCurveQuoteEngine();
  const requestedAtUtc = new Date(capturedAtMs).toISOString();
  const quoteBase = {
    mint: capture.mint,
    inputMint: mint,
    outputMint: capture.mint,
    maxAgeMs: 0,
    requestedAtUtc,
  };
  const buy = engine.quote(
    {
      ...quoteBase,
      direction: "BUY",
      exactInputAmountRaw: "50000000",
    },
    loaded.state,
  );
  assert.equal(buy.validationStatus, "PASS");
  assert.equal(buy.expectedOutputAmountRaw, "735339457766082");
  assert.equal(buy.feeAmountRaw, "617285");
  assert.deepEqual(buy.feeBreakdownRaw, {
    protocol: "469136",
    creator: "148149",
    liquidityProvider: "0",
    unallocated: "0",
  });
  assert.equal(buy.priceImpactBps, 5682);
  assert.equal(buy.snapshotSlot, 464003571);

  const sell = engine.quote(
    {
      ...quoteBase,
      direction: "SELL",
      exactInputAmountRaw: buy.expectedOutputAmountRaw!,
      inputMint: capture.mint,
      outputMint: mint,
    },
    loaded.state,
  );
  assert.equal(sell.validationStatus, "PASS");
  assert.equal(sell.expectedOutputAmountRaw, "13639617");
  assert.equal(sell.feeAmountRaw, "172654");
  assert.deepEqual(sell.feeBreakdownRaw, {
    protocol: "131217",
    creator: "41437",
    liquidityProvider: "0",
    unallocated: "0",
  });
  assert.equal(sell.snapshotSlot, 464003571);

  const stale = engine.quote(
    {
      ...quoteBase,
      direction: "BUY",
      exactInputAmountRaw: "50000000",
      requestedAtUtc: new Date(capturedAtMs + 1).toISOString(),
      maxAgeMs: 0,
    },
    loaded.state,
  );
  assert.equal(stale.failureReason, "STALE_SNAPSHOT");
  assert.equal(stale.validationStatus, "FAIL");
});

test("Helius captured PumpSwap state produces exact-input buy and sell SDK quotes", async () => {
  const capture = JSON.parse(
    await readFile(
      "tests/fixtures/captures/pumpswap-state-2026-11-01.json",
      "utf8",
    ),
  ) as {
    mint: string;
    poolAddress: string;
    slot: number;
    capturedAtUtc: string;
    accounts: Array<{
      address: string;
      owner: string;
      dataBase64: string;
      executable: boolean;
    } | null>;
  };
  const fakeHelius = {
    async getMultipleAccounts(addresses: string[]) {
      return {
        slot: capture.slot,
        accounts: addresses.map(
          (address) =>
            capture.accounts.find((account) => account?.address === address) ??
            null,
        ),
      };
    },
  };
  const capturedAtMs = Date.parse(capture.capturedAtUtc);
  const loaded = await new PumpSwapStateLoader({
    helius: fakeHelius as never,
    now: () => capturedAtMs,
  }).load(capture.mint);
  assert.equal(loaded.status, "SUPPORTED");
  if (loaded.status !== "SUPPORTED") return;
  assert.equal(loaded.poolAddress, capture.poolAddress);
  assert.equal(loaded.slotSkew, 0);
  assert.equal(loaded.state.snapshot.slot, 464004463);
  assert.equal(loaded.state.pool.virtualQuoteReserves.toString(), "-692519");
  assert.equal(loaded.state.snapshot.quoteReserveRaw, "122752236748");
  assert.equal(loaded.state.snapshot.liquidityQuoteRaw, "122752236748");

  const engine = new PumpSwapQuoteEngine();
  const requestedAtUtc = new Date(capturedAtMs).toISOString();
  const quoteBase = {
    mint: capture.mint,
    inputMint: mint,
    outputMint: capture.mint,
    maxAgeMs: 0,
    requestedAtUtc,
  };
  const buy = engine.quote(
    {
      ...quoteBase,
      direction: "BUY",
      exactInputAmountRaw: "50000000",
    },
    loaded.state,
  );
  assert.equal(buy.validationStatus, "PASS");
  assert.equal(buy.expectedOutputAmountRaw, "271345233855");
  assert.equal(buy.feeAmountRaw, "617286");
  assert.deepEqual(buy.feeBreakdownRaw, {
    protocol: "459260",
    creator: "148149",
    liquidityProvider: "9877",
    unallocated: "0",
  });
  assert.equal(buy.priceImpactBps, 127);

  const sell = engine.quote(
    {
      ...quoteBase,
      direction: "SELL",
      exactInputAmountRaw: buy.expectedOutputAmountRaw!,
      inputMint: capture.mint,
      outputMint: mint,
    },
    loaded.state,
  );
  assert.equal(sell.validationStatus, "PASS");
  assert.equal(sell.expectedOutputAmountRaw, "48726222");
  assert.equal(sell.feeAmountRaw, "616790");
  assert.deepEqual(sell.feeBreakdownRaw, {
    protocol: "458891",
    creator: "148030",
    liquidityProvider: "9869",
    unallocated: "0",
  });
  assert.equal(sell.priceImpactBps, 128);

  const stale = engine.quote(
    {
      ...quoteBase,
      direction: "BUY",
      exactInputAmountRaw: "50000000",
      requestedAtUtc: new Date(capturedAtMs + 1).toISOString(),
      maxAgeMs: 0,
    },
    loaded.state,
  );
  assert.equal(stale.failureReason, "STALE_SNAPSHOT");
  const impossibleSell = engine.quote(
    {
      ...quoteBase,
      direction: "SELL",
      exactInputAmountRaw: "1000000000000000000",
      inputMint: capture.mint,
      outputMint: mint,
    },
    loaded.state,
  );
  assert.equal(impossibleSell.validationStatus, "FAIL");
  assert.equal(impossibleSell.failureReason, "INSUFFICIENT_LIQUIDITY");
});

test("launch behavior excludes trades observed after the decision timestamp", () => {
  const observedAt = "2026-11-01T00:00:30.000Z";
  const snapshot = analyzeLaunchBehavior({
    mint,
    observations: [
      trade({ id: "a", traderWallet: otherMint }),
      trade({
        id: "future",
        signature: "sig-future",
        traderWallet: "11111111111111111111111111111111",
        blockTimeUtc: "2026-11-01T00:00:31.000Z",
        receivedAtUtc: "2026-11-01T00:00:31.000Z",
      }),
    ],
    creatorWallets: [],
    linkedWallets: [],
    windowStartedAtUtc: utc,
    observedAtUtc: observedAt,
    windowSeconds: 30,
    throughSlot: 100,
    complete: true,
    gapReason: null,
    minIndependentBuyers: 2,
  });
  assert.equal(snapshot.buyCount, 1);
  assert.equal(snapshot.classification, "UNKNOWN");
  assert.equal(snapshot.independentBuyerEstimate, 1);
});

test("later reconciliation ingestion cannot rewrite an earlier behavior snapshot", () => {
  const snapshot = analyzeLaunchBehavior({
    mint,
    observations: [
      trade({
        id: "late-reconciliation",
        blockTimeUtc: utc,
        receivedAtUtc: utc,
        ingestedAtUtc: "2026-11-01T00:00:31.000Z",
      }),
    ],
    creatorWallets: [],
    linkedWallets: [],
    windowStartedAtUtc: utc,
    observedAtUtc: "2026-11-01T00:00:30.000Z",
    windowSeconds: 30,
    throughSlot: 100,
    complete: true,
    gapReason: null,
    minIndependentBuyers: 1,
  });
  assert.equal(snapshot.buyCount, 0);
  assert.equal(snapshot.independentBuyerEstimate, 0);
  assert.equal(snapshot.classification, "UNKNOWN");
});

test("mixed market phases retain per-venue metrics and do not classify a pooled window", () => {
  const snapshot = analyzeLaunchBehavior({
    mint,
    observations: [
      trade({ id: "curve", quoteAmountRaw: "70" }),
      trade({
        id: "pool",
        signature: "pool-sig",
        venue: "PUMPSWAP",
        quoteAmountRaw: "30",
      }),
    ],
    creatorWallets: [],
    linkedWallets: [],
    windowStartedAtUtc: utc,
    observedAtUtc: utc,
    windowSeconds: 30,
    throughSlot: 100,
    complete: true,
    gapReason: null,
    minIndependentBuyers: 1,
  });
  assert.equal(snapshot.venueMetrics.PUMP_BONDING_CURVE.buyVolumeRaw, "70");
  assert.equal(snapshot.venueMetrics.PUMPSWAP.buyVolumeRaw, "30");
  assert.equal(snapshot.classification, "UNKNOWN");
  assert.ok(
    snapshot.reasonCodes.includes(
      "MULTI_VENUE_WINDOW_REQUIRES_SEPARATE_ANALYSIS",
    ),
  );
});

test("launch behavior marks a complete independent-buyer window as candidate", () => {
  const snapshot = analyzeLaunchBehavior({
    mint,
    observations: [
      trade({ id: "buyer-a", traderWallet: otherMint }),
      trade({
        id: "buyer-b",
        signature: "sig-b",
        traderWallet: "11111111111111111111111111111111",
      }),
    ],
    creatorWallets: [],
    linkedWallets: [],
    windowStartedAtUtc: utc,
    observedAtUtc: utc,
    windowSeconds: 30,
    throughSlot: 100,
    complete: true,
    gapReason: null,
    minIndependentBuyers: 2,
  });
  assert.equal(snapshot.classification, "ORGANIC_CANDIDATE");
  assert.equal(snapshot.independentBuyerEstimate, 2);
});

test("repeated same-wallet two-way trading stays unknown as a possible wash pattern", () => {
  const snapshot = analyzeLaunchBehavior({
    mint,
    observations: [
      trade({ id: "loop-1", traderWallet: otherMint }),
      trade({
        id: "loop-2",
        signature: "sig-loop-2",
        traderWallet: otherMint,
      }),
      trade({
        id: "loop-3",
        signature: "sig-loop-3",
        traderWallet: otherMint,
        side: "SELL",
      }),
      trade({
        id: "other-buyer",
        signature: "sig-other",
        traderWallet: "11111111111111111111111111111111",
      }),
    ],
    creatorWallets: [],
    linkedWallets: [],
    windowStartedAtUtc: utc,
    observedAtUtc: utc,
    windowSeconds: 30,
    throughSlot: 100,
    complete: true,
    gapReason: null,
    minIndependentBuyers: 2,
  });
  assert.equal(snapshot.classification, "UNKNOWN");
  assert.equal(
    snapshot.reasonCodes.includes("POSSIBLE_WASH_TRADING_PATTERN"),
    true,
  );
});

test("wallet outflow evidence is an indicator and does not assert a sell", () => {
  const tx: WalletTransaction = {
    signature: "signature",
    slot: 50,
    blockTime: 1_798_000_000,
    succeeded: true,
    feeLamports: 5000,
    accountKeys: [],
    instructions: [],
    logMessages: [],
    preBalances: [],
    postBalances: [],
    preTokenBalances: [
      { accountIndex: 1, mint: otherMint, owner: mint, amountRaw: "1000" },
    ],
    postTokenBalances: [
      { accountIndex: 1, mint: otherMint, owner: mint, amountRaw: "400" },
    ],
  };
  const outflows = detectWalletTokenOutflows(mint, tx);
  assert.equal(outflows.length, 1);
  assert.equal(outflows[0]?.reasonCode, "WALLET_ASSOCIATED_TOKEN_OUTFLOW");
  assert.equal(outflows[0]?.afterAmountRaw, "400");
});

test("migration 010 persists trade evidence and prior state reopens cleanly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentinel-sprint25-"));
  const path = join(dir, "state.db");
  const store = new SentinelStore(path);
  await store.open();
  try {
    const snapshot = analyzeLaunchBehavior({
      mint,
      observations: [trade()],
      creatorWallets: [],
      linkedWallets: [],
      windowStartedAtUtc: utc,
      observedAtUtc: utc,
      windowSeconds: 30,
      throughSlot: 100,
      complete: false,
      gapReason: "STREAM_GAP",
      minIndependentBuyers: 1,
    });
    store.saveLaunchBehaviorSnapshot(snapshot);
    assert.equal(
      store.listLaunchBehaviorSnapshots(mint)[0]?.gapReason,
      "STREAM_GAP",
    );
    store.saveQuoteResult({
      id: "stored-quote",
      mint: otherMint,
      direction: "BUY",
      exactInputAmountRaw: "1000000000",
      expectedOutputAmountRaw: "123456",
      inputMint: mint,
      outputMint: otherMint,
      venue: "JUPITER",
      source: "JUPITER_ORDER_QUOTE_ONLY",
      snapshotSlot: null,
      snapshotAtUtc: null,
      feeAmountRaw: null,
      feeMint: null,
      feeModel: "UNKNOWN",
      priceImpactBps: null,
      liquidityQuoteRaw: null,
      freshnessMs: null,
      validationStatus: "UNKNOWN",
      failureReason: "STATE_MISSING",
      evidenceRefs: [],
      provenance: { provider: "Jupiter Swap V2" },
      observedAtUtc: utc,
    });
    assert.equal(store.listQuoteResults(otherMint)[0]?.id, "stored-quote");
    const migrations = store.listAppliedMigrations();
    assert.equal(
      migrations.some((item) => item.version === 6),
      true,
    );
    assert.equal(migrations.at(-1)?.version, 15);
    assert.equal(store.tryConsumeJupiterRequest(1), true);
    assert.equal(store.tryConsumeJupiterRequest(1), false);
  } finally {
    store.close();
    const reopened = new SentinelStore(path);
    await reopened.open();
    assert.equal(reopened.tryConsumeJupiterRequest(1), false);
    reopened.close();
    await rm(dir, { recursive: true, force: true });
  }
});
