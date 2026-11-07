import assert from "node:assert/strict";
import test from "node:test";
import { HeliusParsedEventsScanClient } from "@sentinel/providers";

const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const wsol = "So11111111111111111111111111111111111111112";
const signature =
  "5TKad77QinBX7wpSJABiiH2w7FnSgseEHdjTzTHgT9bcYJAa9xrKyTTfVHifoXXqHZdy1wBfbFHmrVCebBBsfev2";

test("Parsed Events Scan sends bounded finalized Pump/PumpSwap mint scan and accepts empty page with cursor", async () => {
  let body: Record<string, unknown> | undefined;
  let reserved = 0;
  let charged = 0;
  const client = new HeliusParsedEventsScanClient({
    apiKey: "private-key",
    timeoutMs: 1000,
    creditReservation: {
      reserve: (amount) => {
        reserved += amount;
        return "2026-11-07";
      },
      settle: (_day, amount) => {
        charged += amount;
      },
    },
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        data: [],
        paginationToken: "460903064:422",
        scan: {
          stoppedOn: "budget",
          scannedTransactions: 1000,
          matchedTransactions: 0,
          scannedThrough: { slot: 460903064, blockTime: 1792856105 },
          creditsCharged: 11,
        },
      });
    },
  });
  const page = await client.scanMintWindow({
    mint,
    fromUnixSeconds: 1792850000,
    toUnixSeconds: 1792850100,
    maxScannedTransactions: 1000,
  });
  assert.deepEqual(page.items, []);
  assert.equal(page.paginationToken, "460903064:422");
  assert.equal(page.stoppedOn, "budget");
  assert.equal(reserved, 11);
  assert.equal(charged, 11);
  assert.equal(body?.["address"], mint);
  assert.equal(body?.["returnShape"], "transactions");
  assert.equal(body?.["commitment"], "finalized");
  assert.equal((body?.["match"] as { programs: unknown[] }).programs.length, 2);
});

test("Parsed Events Scan classifies supported swap and leaves unknown program instructions unsupported", async () => {
  const response = {
    data: [
      {
        signature,
        parserStatus: "OK",
        parsed: {
          slot: 460869102,
          blockTime: 1792848886,
          transactionStatus: "OK",
          summary: {
            type: "swap",
            parsedData: {
              type: "swap",
              protocol: "pump_fun",
              kind: "buy",
              input_mint: wsol,
              output_mint: mint,
            },
          },
          instructions: [
            {
              programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
              instructionName: "buy_v3",
            },
          ],
        },
      },
      {
        signature:
          "5TKad77QinBX7wpSJABiiH2w7FnSgseEHdjTzTHgT9bcYJAa9xrKyTTfVHifoXXqHZdy1wBfbFHmrVCebBBsfev2",
        parserStatus: "OK",
        parsed: {
          slot: 460869103,
          blockTime: 1792848887,
          transactionStatus: "OK",
          summary: { type: "instruction", parsedData: null },
          instructions: [
            {
              programId: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
              instructionName: "some_future_trade",
            },
          ],
        },
      },
    ],
    scan: {
      stoppedOn: "windowEnd",
      scannedTransactions: 2,
      matchedTransactions: 2,
      scannedThrough: { slot: 460869103, blockTime: 1792848887 },
      creditsCharged: 11,
    },
  };
  const client = new HeliusParsedEventsScanClient({
    apiKey: "must-not-leak",
    timeoutMs: 1000,
    creditReservation: { reserve: () => "2026-11-07", settle: () => undefined },
    fetchImpl: async () => Response.json(response),
  });
  const page = await client.scanMintWindow({
    mint,
    fromUnixSeconds: 1792848886,
    toUnixSeconds: 1792848900,
    maxScannedTransactions: 1000,
  });
  assert.equal(page.items[0]?.classification, "TRADE_CANDIDATE");
  assert.equal(page.items[0]?.parsedMint, mint);
  assert.equal(page.items[0]?.expectedSide, "BUY");
  assert.equal(page.items[1]?.classification, "UNSUPPORTED");
});

test("Parsed Events Scan identifies SELL mint from input side when output is WSOL", async () => {
  const client = new HeliusParsedEventsScanClient({
    apiKey: "test",
    timeoutMs: 1000,
    creditReservation: { reserve: () => "2026-11-07", settle: () => undefined },
    fetchImpl: async () =>
      Response.json({
        data: [
          {
            signature,
            parserStatus: "OK",
            slot: 460869102,
            blockTime: 1792848886,
            parsed: {
              slot: 460869102,
              blockTime: 1792848886,
              transactionStatus: "OK",
              summary: {
                type: "swap",
                parsedData: {
                  protocol: "pump_amm",
                  kind: "sell",
                  input_mint: mint,
                  output_mint: wsol,
                },
              },
              instructions: [
                {
                  programId: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
                  instructionName: "sell",
                },
              ],
            },
          },
        ],
        scan: {
          stoppedOn: "windowEnd",
          scannedTransactions: 1,
          matchedTransactions: 1,
          scannedThrough: { slot: 460869102, blockTime: 1792848886 },
          creditsCharged: 10,
        },
      }),
  });
  const page = await client.scanMintWindow({
    mint,
    fromUnixSeconds: 1792848886,
    toUnixSeconds: 1792848887,
    maxScannedTransactions: 1000,
  });
  assert.equal(page.items[0]?.classification, "TRADE_CANDIDATE");
  assert.equal(page.items[0]?.parsedMint, mint);
  assert.equal(page.items[0]?.expectedSide, "SELL");
});

test("Parsed Events Scan rejects mint, direction, program, and metadata conflicts", async () => {
  const candidates = [
    {
      protocol: "pump_fun",
      kind: "buy",
      input_mint: mint,
      output_mint: wsol,
      programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      reason: "TRADE_SUMMARY_DIRECTION_MISMATCH",
    },
    {
      protocol: "pump_fun",
      kind: "buy",
      input_mint: "11111111111111111111111111111111",
      output_mint: mint,
      programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      reason: "TRADE_MINT_OR_WSOL_PAIR_AMBIGUOUS",
    },
    {
      protocol: "pump_fun",
      kind: "buy",
      input_mint: wsol,
      output_mint: mint,
      programId: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
      reason: "TRADE_PROTOCOL_PROGRAM_MISMATCH",
    },
  ];
  const client = new HeliusParsedEventsScanClient({
    apiKey: "test",
    timeoutMs: 1000,
    creditReservation: { reserve: () => "2026-11-07", settle: () => undefined },
    fetchImpl: async () =>
      Response.json({
        data: candidates.map((item, index) => ({
          signature,
          parserStatus: "OK",
          slot: 460869102 + index,
          blockTime: 1792848886 + index,
          parsed: {
            slot: 460869102 + index,
            blockTime: 1792848886 + index,
            transactionStatus: "OK",
            summary: {
              type: "swap",
              parsedData: {
                protocol: item.protocol,
                kind: item.kind,
                input_mint: item.input_mint,
                output_mint: item.output_mint,
              },
            },
            instructions: [
              { programId: item.programId, instructionName: "buy_v2" },
            ],
          },
        })),
        scan: {
          stoppedOn: "windowEnd",
          scannedTransactions: candidates.length,
          matchedTransactions: candidates.length,
          scannedThrough: { slot: 460869104, blockTime: 1792848888 },
          creditsCharged: 11,
        },
      }),
  });
  const page = await client.scanMintWindow({
    mint,
    fromUnixSeconds: 1792848886,
    toUnixSeconds: 1792848890,
    maxScannedTransactions: 1000,
  });
  assert.deepEqual(
    page.items.map((item) => item.reasonCode),
    candidates.map((item) => item.reason),
  );
  await assert.rejects(
    () =>
      new HeliusParsedEventsScanClient({
        apiKey: "test",
        timeoutMs: 1000,
        creditReservation: {
          reserve: () => "2026-11-07",
          settle: () => undefined,
        },
        fetchImpl: async () =>
          Response.json({
            data: [
              {
                signature,
                parserStatus: "OK",
                slot: 1,
                blockTime: 2,
                parsed: {
                  slot: 1,
                  blockTime: 3,
                  transactionStatus: "OK",
                  summary: { parsedData: null },
                },
              },
            ],
            scan: {
              stoppedOn: "windowEnd",
              scannedTransactions: 1,
              matchedTransactions: 1,
              scannedThrough: { slot: 1, blockTime: 2 },
              creditsCharged: 10,
            },
          }),
      }).scanMintWindow({
        mint,
        fromUnixSeconds: 1,
        toUnixSeconds: 3,
        maxScannedTransactions: 10,
      }),
    /CONFLICTING_PARSED_SCAN_TIME_METADATA/,
  );
});

test("Parsed Events Scan never treats an empty page as complete without windowEnd evidence", async () => {
  for (const scan of [
    {
      stoppedOn: "budget",
      scannedTransactions: 0,
      matchedTransactions: 0,
      scannedThrough: null,
      creditsCharged: 11,
    },
    {
      stoppedOn: "windowEnd",
      scannedTransactions: 0,
      matchedTransactions: 0,
      scannedThrough: null,
      creditsCharged: 11,
    },
  ]) {
    const client = new HeliusParsedEventsScanClient({
      apiKey: "test",
      timeoutMs: 1000,
      creditReservation: {
        reserve: () => "2026-11-07",
        settle: () => undefined,
      },
      fetchImpl: async () =>
        Response.json({
          data: [],
          paginationToken: scan.stoppedOn === "budget" ? "cursor" : undefined,
          scan,
        }),
    });
    const page = await client.scanMintWindow({
      mint,
      fromUnixSeconds: 1,
      toUnixSeconds: 2,
      maxScannedTransactions: 1000,
    });
    assert.equal(page.stoppedOn, scan.stoppedOn);
    assert.equal(
      page.stoppedOn === "windowEnd" && page.paginationToken === null,
      scan.stoppedOn === "windowEnd",
    );
  }
});

test("Parsed Events Scan forwards the cursor after an empty budget-limited page", async () => {
  let call = 0;
  const requestBodies: Array<Record<string, unknown>> = [];
  const client = new HeliusParsedEventsScanClient({
    apiKey: "test",
    timeoutMs: 1000,
    creditReservation: {
      reserve: () => "2026-11-07",
      settle: () => undefined,
    },
    fetchImpl: async (_url, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      call += 1;
      return Response.json({
        data: [],
        ...(call === 1 ? { paginationToken: "460903064:422" } : {}),
        scan: {
          stoppedOn: call === 1 ? "budget" : "windowEnd",
          scannedTransactions: 0,
          matchedTransactions: 0,
          scannedThrough: null,
          creditsCharged: 10,
        },
      });
    },
  });
  const initial = await client.scanMintWindow({
    mint,
    fromUnixSeconds: 1,
    toUnixSeconds: 2,
    maxScannedTransactions: 1000,
  });
  assert.equal(initial.paginationToken, "460903064:422");
  await client.scanMintWindow({
    mint,
    fromUnixSeconds: 1,
    toUnixSeconds: 2,
    paginationToken: initial.paginationToken ?? undefined,
    maxScannedTransactions: 1000,
  });
  assert.equal(requestBodies[1]?.["paginationToken"], "460903064:422");
});

test("Parsed Events Scan exposes bounded provider failures without releasing ambiguous credits", async () => {
  let settled = false;
  const create = (fetchImpl: typeof fetch, timeoutMs = 1000) =>
    new HeliusParsedEventsScanClient({
      apiKey: "secret",
      timeoutMs,
      creditReservation: {
        reserve: () => "2026-11-07",
        settle: () => {
          settled = true;
        },
      },
      fetchImpl,
    });
  await assert.rejects(
    () =>
      create(async () => new Response("", { status: 429 })).scanMintWindow({
        mint,
        fromUnixSeconds: 1,
        toUnixSeconds: 2,
        maxScannedTransactions: 1000,
      }),
    /RATE_LIMITED/,
  );
  assert.equal(settled, false);
  const timeoutClient = create(
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      }),
    15,
  );
  await assert.rejects(
    () =>
      timeoutClient.scanMintWindow({
        mint,
        fromUnixSeconds: 1,
        toUnixSeconds: 2,
        maxScannedTransactions: 1000,
      }),
    /TIMEOUT/,
  );
  assert.equal(settled, false);
});

test("Parsed Events Scan enforces credit cap, aborts and does not expose provider credentials", async () => {
  const denied = new HeliusParsedEventsScanClient({
    apiKey: "secret-value",
    timeoutMs: 50,
    creditReservation: { reserve: () => null, settle: () => undefined },
  });
  await assert.rejects(
    () =>
      denied.scanMintWindow({
        mint,
        fromUnixSeconds: 1,
        toUnixSeconds: 2,
        maxScannedTransactions: 1000,
      }),
    /PARSED_SCAN_CREDIT_BUDGET_EXHAUSTED/,
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    () =>
      denied.scanMintWindow({
        mint,
        fromUnixSeconds: 1,
        toUnixSeconds: 2,
        maxScannedTransactions: 1000,
        signal: aborted.signal,
      }),
    /CANCELLED/,
  );
  assert.doesNotMatch("PARSED_SCAN_ACCESS_DENIED", /secret-value/);
});
