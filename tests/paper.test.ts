import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { base58Encode } from "@sentinel/domain";
import type { PaperOrderIntent, QuoteResult } from "@sentinel/domain";
import {
  PaperExitStrategy,
  PaperRiskManager,
  PaperTradingEngine,
  paperExecutionConfigFromAppConfig,
  paperInitialBalanceLamports,
  solToLamports,
} from "@sentinel/paper";
import type {
  PaperClock,
  PaperExecutionConfig,
  PaperQuoteProvider,
} from "@sentinel/paper";
import { loadConfig } from "@sentinel/config";
import { SentinelStore } from "@sentinel/storage";

const mint = base58Encode(Buffer.alloc(32, 8));
const sol = "So11111111111111111111111111111111111111112";
let quoteSequence = 0;

class TestClock implements PaperClock {
  current: number;
  constructor(current = Date.parse("2026-11-01T00:00:00.000Z")) {
    this.current = current;
  }
  now = () => this.current;
  wait = async (milliseconds: number) => {
    this.current += milliseconds;
  };
}

class TestQuotes implements PaperQuoteProvider {
  calls: Array<{ side: string; at: string; venue: string }> = [];
  venue: "PUMP_BONDING_CURVE" | "PUMPSWAP" = "PUMP_BONDING_CURVE";
  fail = false;
  staleMs = 0;
  futureSnapshot = false;
  sellOutput: bigint | null = null;
  providerLatencyMs = 0;
  clock: TestClock | null = null;

  async quoteAtArrival(request: {
    mint: string;
    side: "BUY" | "SELL";
    exactInputAmountRaw: string;
    requestedAtUtc: string;
    maxAgeMs: number;
  }): Promise<QuoteResult | null> {
    this.calls.push({
      side: request.side,
      at: request.requestedAtUtc,
      venue: this.venue,
    });
    if (this.fail) return null;
    if (this.clock) this.clock.current += this.providerLatencyMs;
    const requested = Math.max(
      Date.parse(request.requestedAtUtc),
      this.clock?.now() ?? 0,
    );
    const snapshot = requested - this.staleMs + (this.futureSnapshot ? 500 : 0);
    const sellOutput =
      this.sellOutput ?? BigInt(request.exactInputAmountRaw) * 5000n;
    const direction = request.side;
    return {
      id: `quote:${++quoteSequence}`,
      mint: request.mint,
      direction,
      exactInputAmountRaw: request.exactInputAmountRaw,
      expectedOutputAmountRaw:
        direction === "BUY" ? "100000" : sellOutput.toString(),
      inputMint: direction === "BUY" ? sol : request.mint,
      outputMint: direction === "BUY" ? request.mint : sol,
      venue: this.venue,
      source: "deterministic-test-quote-provider",
      snapshotSlot: 900 + this.calls.length,
      snapshotAtUtc: new Date(snapshot).toISOString(),
      feeAmountRaw: direction === "BUY" ? "10000" : "2000",
      feeMint: direction === "BUY" ? sol : sol,
      feeModel: "deterministic-test-fee",
      priceImpactBps: 20,
      liquidityQuoteRaw: "100000000000",
      freshnessMs: Math.max(0, requested - snapshot),
      validationStatus: "PASS",
      failureReason: null,
      evidenceRefs: [`test_state:${this.calls.length}`],
      provenance: { fixture: "deterministic-paper-test" },
      observedAtUtc: new Date(requested).toISOString(),
    };
  }
}

function config(
  overrides: Partial<PaperExecutionConfig> = {},
): PaperExecutionConfig {
  return {
    executionLatencyMs: 250,
    maxQuoteAgeMs: 1000,
    maxIntentAgeMs: 3000,
    conservativeExtraSlippageBps: 50,
    modeledNetworkFeeLamports: "10000",
    risk: {
      maxTradeInputRaw: "1500000000",
      maxExposureLamports: "5000000000",
      maxOpenPositions: 3,
      maxDailyLossLamports: "100000000",
      maxDrawdownBps: 9000,
      maxPriceImpactBps: 300,
      maxSlippageBps: 200,
      pauseNewEntries: false,
    },
    ...overrides,
  };
}

function intent(input: Partial<PaperOrderIntent> = {}): PaperOrderIntent {
  const id = input.id ?? "paper-order-1";
  return {
    id,
    idempotencyKey: input.idempotencyKey ?? `idempotency:${id}`,
    walletId: input.walletId ?? "paper-wallet",
    mode: "PAPER",
    mint: input.mint ?? mint,
    side: input.side ?? "BUY",
    exactInputAmountRaw: input.exactInputAmountRaw ?? "1000000000",
    decisionId: input.decisionId ?? "decision-test-1",
    reasonCodes: input.reasonCodes ?? ["TEST_SIGNAL"],
    createdAtUtc: input.createdAtUtc ?? "2026-11-01T00:00:00.000Z",
    signalQuoteId: input.signalQuoteId ?? null,
  };
}

async function withStore(
  run: (store: SentinelStore) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-paper-"));
  const store = new SentinelStore(join(directory, "paper.sqlite"));
  await store.open();
  try {
    await run(store);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("SOL conversion uses exact lamports and rejects more than nine decimals", () => {
  assert.equal(solToLamports("10.000000001"), "10000000001");
  assert.throws(() => solToLamports("0.0000000001"), /PRECISION_INVALID/);
});

test("paper buy uses a quote after arrival, applies costs, and deduplicates fills", async () => {
  await withStore(async (store) => {
    const clock = new TestClock();
    const quoteProvider = new TestQuotes();
    const engine = new PaperTradingEngine({
      repository: store,
      quotes: quoteProvider,
      config: config(),
      clock,
    });
    engine.initializeWallet("paper-wallet", "2");
    engine.initializeWallet("paper-wallet", "90");
    const order = intent();
    const result = await engine.execute(order);
    assert.equal(result.order.status, "SIMULATED_FILLED");
    assert.equal(result.fill?.["outputAmountRaw"], "99500");
    assert.equal(result.fill?.["networkFeeLamports"], "10000");
    assert.equal(result.fill?.["venueFeeRaw"], "10000");
    assert.equal(quoteProvider.calls[0]?.at, "2026-11-01T00:00:00.250Z");
    const state = store.getPaperPortfolioState("paper-wallet");
    assert.equal(store.listAppliedMigrations().at(-1)?.version, 11);
    assert.equal(state.solBalanceRaw, "999990000");
    assert.equal(state.positions[0]?.tokenAmountRaw, "99500");
    const quoteCount = quoteProvider.calls.length;
    const duplicate = await engine.execute(order);
    assert.equal(duplicate.order.status, "SIMULATED_FILLED");
    assert.equal(quoteProvider.calls.length, quoteCount);
    const entries = store.listPaperLedgerEntries("paper-wallet");
    const journals = new Map<string, bigint>();
    for (const entry of entries) {
      const key = `${entry.journalId}:${entry.assetMint}`;
      journals.set(key, (journals.get(key) ?? 0n) + BigInt(entry.deltaRaw));
    }
    assert.equal(
      [...journals.values()].every((sum) => sum === 0n),
      true,
    );
    const directDatabase = new DatabaseSync(store.path);
    assert.throws(
      () =>
        directDatabase
          .prepare("UPDATE paper_ledger_entries SET delta_raw = '1'")
          .run(),
      /paper ledger entries are immutable/,
    );
    directDatabase.close();
  });
});

test("quote snapshots fetched during RPC are validated at quote-ready time", async () => {
  await withStore(async (store) => {
    const clock = new TestClock();
    const quotes = new TestQuotes();
    quotes.clock = clock;
    quotes.providerLatencyMs = 300;
    const engine = new PaperTradingEngine({
      repository: store,
      quotes,
      config: config(),
      clock,
    });
    engine.initializeWallet("paper-wallet", "2");
    const result = await engine.execute(intent({ id: "paper-rpc-latency" }));
    assert.equal(result.order.status, "SIMULATED_FILLED");
    assert.equal(result.fill?.["arrivalAtUtc"], "2026-11-01T00:00:00.250Z");
    assert.equal(result.fill?.["snapshotAtUtc"], "2026-11-01T00:00:00.550Z");
    assert.equal(result.fill?.["filledAtUtc"], "2026-11-01T00:00:00.550Z");
  });
});

test("BUY size limit does not reject larger profitable or losing SELL proceeds", async () => {
  await withStore(async (store) => {
    const base = config();
    const risk = { ...base.risk, maxTradeInputRaw: "50000000" };
    const clock = new TestClock();
    const quotes = new TestQuotes();
    const engine = new PaperTradingEngine({
      repository: store,
      quotes,
      config: { ...base, risk },
      clock,
    });
    engine.initializeWallet("paper-wallet", "1");
    const buy = await engine.execute(
      intent({ id: "sell-cap-buy", exactInputAmountRaw: "50000000" }),
    );
    assert.equal(buy.order.status, "SIMULATED_FILLED");

    quotes.sellOutput = 100000000n;
    const profitable = await engine.execute(
      intent({
        id: "sell-cap-profit",
        side: "SELL",
        exactInputAmountRaw: "99500",
      }),
    );
    assert.equal(profitable.order.status, "SIMULATED_FILLED");
    assert.equal(
      store.getPaperPortfolioState("paper-wallet").positions.length,
      0,
    );
    assert.ok(
      BigInt(store.getPaperPortfolioState("paper-wallet").solBalanceRaw) >
        1000000000n,
    );
  });

  await withStore(async (store) => {
    const base = config();
    const clock = new TestClock();
    const quotes = new TestQuotes();
    const engine = new PaperTradingEngine({
      repository: store,
      quotes,
      config: { ...base, risk: { ...base.risk, maxTradeInputRaw: "50000000" } },
      clock,
    });
    engine.initializeWallet("paper-wallet", "1");
    await engine.execute(
      intent({ id: "sell-loss-buy", exactInputAmountRaw: "50000000" }),
    );
    quotes.sellOutput = 20000000n;
    const losing = await engine.execute(
      intent({
        id: "sell-loss-exit",
        side: "SELL",
        exactInputAmountRaw: "99500",
      }),
    );
    assert.equal(losing.order.status, "SIMULATED_FILLED");
  });
});

test("partial SELL and SELL during entry pause remain risk reducing", async () => {
  await withStore(async (store) => {
    const clock = new TestClock();
    const quotes = new TestQuotes();
    const base = config();
    const active = new PaperTradingEngine({
      repository: store,
      quotes,
      config: base,
      clock,
    });
    active.initializeWallet("paper-wallet", "1");
    await active.execute(
      intent({ id: "pause-buy", exactInputAmountRaw: "50000000" }),
    );

    store.recordPaperEquityMark(
      "paper-wallet",
      "2000000000",
      0,
      "2026-11-01T00:00:01.000Z",
    );
    store.recordPaperEquityMark(
      "paper-wallet",
      "1000000",
      0,
      "2026-11-01T00:00:02.000Z",
    );
    const paused = new PaperTradingEngine({
      repository: store,
      quotes,
      config: {
        ...base,
        risk: { ...base.risk, pauseNewEntries: true, maxTradeInputRaw: "1" },
      },
      clock,
    });
    const stateBefore = store.getPaperPortfolioState("paper-wallet");
    const partial = await paused.execute(
      intent({
        id: "pause-partial-sell",
        side: "SELL",
        exactInputAmountRaw: "40000",
      }),
    );
    assert.equal(partial.order.status, "SIMULATED_FILLED");
    assert.equal(
      store.getPaperPortfolioState("paper-wallet").positions[0]?.tokenAmountRaw,
      "59500",
    );
    assert.notEqual(
      store.getPaperPortfolioState("paper-wallet").solBalanceRaw,
      stateBefore.solBalanceRaw,
    );

    const buyCalls = quotes.calls.filter((call) => call.side === "BUY").length;
    const blockedBuy = await paused.execute(
      intent({ id: "pause-new-buy", exactInputAmountRaw: "1000000" }),
    );
    assert.equal(blockedBuy.order.status, "REJECTED");
    assert.equal(blockedBuy.reasonCode, "PAPER_NEW_ENTRIES_PAUSED");
    assert.equal(
      quotes.calls.filter((call) => call.side === "BUY").length,
      buyCalls,
    );
  });
});

test("SELL cannot exceed verified held tokens and rejection preserves balances", async () => {
  await withStore(async (store) => {
    const clock = new TestClock();
    const quotes = new TestQuotes();
    const engine = new PaperTradingEngine({
      repository: store,
      quotes,
      config: config(),
      clock,
    });
    engine.initializeWallet("paper-wallet", "1");
    await engine.execute(intent({ id: "oversell-buy" }));
    const before = store.getPaperPortfolioState("paper-wallet");
    const result = await engine.execute(
      intent({ id: "oversell", side: "SELL", exactInputAmountRaw: "99501" }),
    );
    assert.equal(result.order.status, "REJECTED");
    assert.equal(result.reasonCode, "PAPER_INSUFFICIENT_TOKEN_BALANCE");
    const after = store.getPaperPortfolioState("paper-wallet");
    assert.equal(after.solBalanceRaw, before.solBalanceRaw);
    assert.equal(
      after.positions[0]?.tokenAmountRaw,
      before.positions[0]?.tokenAmountRaw,
    );
  });
});

test("concurrent duplicate intents result in one immutable settlement", async () => {
  await withStore(async (store) => {
    const engine = new PaperTradingEngine({
      repository: store,
      quotes: new TestQuotes(),
      config: config(),
      clock: new TestClock(),
    });
    engine.initializeWallet("paper-wallet", "2");
    const sameIntent = intent({ id: "paper-concurrent" });
    const results = await Promise.all([
      engine.execute(sameIntent),
      engine.execute(sameIntent),
    ]);
    assert.equal(
      results.every((result) => result.order.status === "SIMULATED_FILLED"),
      true,
    );
    const state = store.getPaperPortfolioState("paper-wallet");
    assert.equal(state.solBalanceRaw, "999990000");
    assert.equal(state.positions[0]?.tokenAmountRaw, "99500");
    const fill = store.getPaperFill(sameIntent.id);
    assert.equal(fill?.["inputAmountRaw"], "1000000000");
  });
});

test("partial sell debits only sold tokens and realizes PnL from net proceeds", async () => {
  await withStore(async (store) => {
    const clock = new TestClock();
    const quotes = new TestQuotes();
    const engine = new PaperTradingEngine({
      repository: store,
      quotes,
      config: config(),
      clock,
    });
    engine.initializeWallet("paper-wallet", "2");
    await engine.execute(intent());
    const before = store.getPaperPortfolioState("paper-wallet");
    const sell = await engine.execute(
      intent({
        id: "paper-sell-partial",
        side: "SELL",
        exactInputAmountRaw: "40000",
      }),
    );
    assert.equal(sell.order.status, "SIMULATED_FILLED");
    assert.equal(sell.fill?.["outputAmountRaw"], "199000000");
    const after = store.getPaperPortfolioState("paper-wallet");
    assert.equal(after.positions[0]?.tokenAmountRaw, "59500");
    assert.equal(
      BigInt(after.solBalanceRaw) > BigInt(before.solBalanceRaw),
      true,
    );
    assert.equal(after.realizedPnl.length, 1);
    assert.equal(BigInt(after.realizedPnl[0]!.pnlLamports) < 0n, true);
  });
});

test("missing or stale sell quote leaves token position and SOL untouched", async () => {
  await withStore(async (store) => {
    const clock = new TestClock();
    const quotes = new TestQuotes();
    const engine = new PaperTradingEngine({
      repository: store,
      quotes,
      config: config(),
      clock,
    });
    engine.initializeWallet("paper-wallet", "2");
    await engine.execute(intent());
    const before = store.getPaperPortfolioState("paper-wallet");
    quotes.fail = true;
    const failed = await engine.execute(
      intent({
        id: "paper-sell-unavailable",
        side: "SELL",
        exactInputAmountRaw: "10000",
      }),
    );
    assert.equal(failed.order.status, "UNFILLABLE");
    assert.equal(failed.fill, null);
    const after = store.getPaperPortfolioState("paper-wallet");
    assert.equal(after.solBalanceRaw, before.solBalanceRaw);
    assert.equal(
      after.positions[0]?.tokenAmountRaw,
      before.positions[0]?.tokenAmountRaw,
    );
  });
});

test("insufficient virtual SOL and stale or future quotes never create fills", async () => {
  await withStore(async (store) => {
    const clock = new TestClock();
    const quotes = new TestQuotes();
    const engine = new PaperTradingEngine({
      repository: store,
      quotes,
      config: config(),
      clock,
    });
    engine.initializeWallet("paper-wallet", "0.5");
    const insufficient = await engine.execute(intent());
    assert.equal(insufficient.order.status, "REJECTED");
    assert.equal(insufficient.reasonCode, "PAPER_INSUFFICIENT_SOL");
    assert.equal(insufficient.fill, null);

    quotes.staleMs = 2000;
    const stale = await engine.execute(intent({ id: "paper-stale" }));
    assert.equal(stale.order.status, "UNFILLABLE");
    assert.equal(stale.reasonCode, "PAPER_QUOTE_STALE_OR_UNSTAMPED");
    assert.equal(
      store.getPaperPortfolioState("paper-wallet").positions.length,
      0,
    );

    quotes.staleMs = 0;
    quotes.futureSnapshot = true;
    const future = await engine.execute(intent({ id: "paper-future" }));
    assert.equal(future.order.status, "UNFILLABLE");
    assert.equal(future.fill, null);
  });
});

test("pending order can resume after restart and observes migration at arrival", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-paper-restart-"));
  const dbPath = join(directory, "paper.sqlite");
  const firstStore = new SentinelStore(dbPath);
  await firstStore.open();
  const clock = new TestClock();
  const pendingIntent = intent({ id: "paper-recovered" });
  firstStore.initializePaperAccount(
    "paper-wallet",
    "2000000000",
    new Date(clock.now()).toISOString(),
  );
  firstStore.createPaperOrder(pendingIntent);
  assert.equal(
    firstStore.getPaperPortfolioState("paper-wallet").solBalanceRaw,
    "2000000000",
  );
  firstStore.close();
  const store = new SentinelStore(dbPath);
  await store.open();
  try {
    assert.equal(
      store.getPaperPortfolioState("paper-wallet").solBalanceRaw,
      "2000000000",
    );
    const quotes = new TestQuotes();
    const engine = new PaperTradingEngine({
      repository: store,
      quotes,
      config: config(),
      clock,
    });
    const [recovered] = await engine.recoverPendingOrders();
    assert.ok(recovered);
    assert.equal(
      recovered.order.status,
      "SIMULATED_FILLED",
      recovered.reasonCode ?? "no rejection reason",
    );

    const migratingClock = new TestClock();
    let phase: "PUMP_CURVE" | "MIGRATED_PUMPSWAP" = "PUMP_CURVE";
    const quotesForPhase = new TestQuotes();
    const migrationQuotes: PaperQuoteProvider = {
      quoteAtArrival: async (request) => {
        assert.equal(phase, "MIGRATED_PUMPSWAP");
        quotesForPhase.venue = "PUMPSWAP";
        return quotesForPhase.quoteAtArrival(request);
      },
    };
    const migrationEngine = new PaperTradingEngine({
      repository: store,
      quotes: migrationQuotes,
      config: config(),
      clock: {
        ...migratingClock,
        wait: async (ms) => {
          phase = "MIGRATED_PUMPSWAP";
          await migratingClock.wait(ms);
        },
      },
    });
    const migrated = await migrationEngine.execute(
      intent({ id: "paper-after-migration", exactInputAmountRaw: "500000000" }),
    );
    assert.equal(
      migrated.order.status,
      "SIMULATED_FILLED",
      migrated.reasonCode ?? "no rejection reason",
    );
    assert.equal(migrated.fill?.["venue"], "PUMPSWAP");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired or future-dated recovered intents cannot become fills", async () => {
  await withStore(async (store) => {
    const clock = new TestClock();
    const quotes = new TestQuotes();
    const engine = new PaperTradingEngine({
      repository: store,
      quotes,
      config: config({ maxIntentAgeMs: 1000 }),
      clock,
    });
    engine.initializeWallet("paper-wallet", "2");
    const expired = await engine.execute(
      intent({ id: "paper-expired", createdAtUtc: "2026-10-31T23:59:58.000Z" }),
    );
    assert.equal(expired.order.status, "EXPIRED");
    assert.equal(expired.reasonCode, "PAPER_INTENT_EXPIRED");
    assert.equal(expired.fill, null);
    const future = await engine.execute(
      intent({
        id: "paper-future-intent",
        createdAtUtc: "2026-11-01T00:00:01.000Z",
      }),
    );
    assert.equal(future.order.status, "EXPIRED");
    assert.equal(quotes.calls.length, 0);
  });
});

test("drawdown and daily realized loss gate new buys while exit policy uses current sell quote", async () => {
  await withStore(async (store) => {
    const clock = new TestClock();
    const quotes = new TestQuotes();
    quotes.sellOutput = 10_001n;
    const engine = new PaperTradingEngine({
      repository: store,
      quotes,
      config: config({
        risk: {
          ...config().risk,
          maxDrawdownBps: 100,
          maxDailyLossLamports: "1000",
        },
      }),
      clock,
    });
    engine.initializeWallet("paper-wallet", "3");
    await engine.execute(intent());
    const risk = new PaperRiskManager();
    const report = await engine.refreshPortfolio("paper-wallet");
    assert.equal(
      risk.canOpenRisk({
        report,
        maxDrawdownBps: 100,
        maxDailyLossLamports: "1000",
      }).allowed,
      false,
    );
    const buyAfterDrawdown = await engine.execute(
      intent({ id: "paper-drawdown-block" }),
    );
    assert.equal(buyAfterDrawdown.order.status, "REJECTED");
    assert.equal(buyAfterDrawdown.reasonCode, "PAPER_DRAWDOWN_LIMIT");

    const exit = new PaperExitStrategy().evaluate({
      mint,
      costBasisLamports: "1000000000",
      positionTokenAmountRaw: "100000",
      positionOpenedAtUtc: "2026-11-01T00:00:00.000Z",
      observedAtUtc: "2026-11-01T00:00:02.000Z",
      sellQuote: await quotes.quoteAtArrival({
        mint,
        side: "SELL",
        exactInputAmountRaw: "100000",
        requestedAtUtc: "2026-11-01T00:00:02.000Z",
        maxAgeMs: 1000,
      }),
      maxQuoteAgeMs: 1000,
      maxPriceImpactBps: 300,
      extraSlippageBps: 50,
      networkFeeLamports: "10000",
      stopLossBps: 500,
      takeProfitBps: 1000,
      maxHoldSeconds: 60,
    });
    assert.equal(exit.action, "EXIT");
    assert.equal(exit.reasonCode, "STOP_LOSS_REACHED");
  });
});

test("daily realized loss limit blocks new exposure after a losing close", async () => {
  await withStore(async (store) => {
    const clock = new TestClock();
    const quotes = new TestQuotes();
    quotes.sellOutput = 1_000_000n;
    const engine = new PaperTradingEngine({
      repository: store,
      quotes,
      config: config({
        risk: {
          ...config().risk,
          maxDailyLossLamports: "1000",
        },
      }),
      clock,
    });
    engine.initializeWallet("paper-wallet", "3");
    await engine.execute(intent());
    const closed = await engine.execute(
      intent({
        id: "paper-daily-loss-sell",
        side: "SELL",
        exactInputAmountRaw: "99500",
      }),
    );
    assert.equal(closed.order.status, "SIMULATED_FILLED");
    const state = store.getPaperPortfolioState("paper-wallet");
    assert.equal(state.realizedPnl.length, 1);
    assert.equal(BigInt(state.realizedPnl[0]!.pnlLamports) < -1000n, true);
    const blocked = await engine.execute(
      intent({ id: "paper-daily-loss-block" }),
    );
    assert.equal(blocked.order.status, "REJECTED");
    assert.equal(blocked.reasonCode, "PAPER_DAILY_LOSS_LIMIT");
  });
});

test("PAPER mode is explicit and PAPER library remains isolated from signing", async () => {
  const loaded = await loadConfig({});
  assert.equal(loaded.config.mode, "DRY_RUN");
  const paperConfig = paperExecutionConfigFromAppConfig(loaded.config);
  assert.equal(paperConfig.risk.maxTradeInputRaw, "50000000");
  assert.equal(paperInitialBalanceLamports(loaded.config), "10000000000");
  assert.equal((await loadConfig({ APP_MODE: "PAPER" })).config.mode, "PAPER");
  await assert.rejects(loadConfig({ APP_MODE: "LIVE" }), /LIVE is unsupported/);
  const paperSource = await readFile("packages/paper/src/index.ts", "utf8");
  assert.doesNotMatch(
    paperSource,
    /Keypair|signTransaction|sendTransaction|VersionedTransaction|@solana\/web3\.js/,
  );
});
