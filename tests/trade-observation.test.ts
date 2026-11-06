import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { base58Encode } from "@sentinel/domain";
import {
  decodePumpSwapTradeEvents,
  decodePumpTradeEvents,
  PUMP_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  validateTradeTransaction,
} from "@sentinel/intelligence";
import type { WalletTransaction } from "@sentinel/providers";
import { HeliusTradeStream } from "@sentinel/providers";
import type { HeliusLogTradeInput } from "@sentinel/providers";
import type WebSocket from "ws";
import { BoundedTradeVerificationQueue } from "../apps/worker/src/trade-verification.ts";

const mint = base58Encode(Buffer.alloc(32, 1));
const trader = base58Encode(Buffer.alloc(32, 2));
const pool = base58Encode(Buffer.alloc(32, 3));
const systemProgram = base58Encode(Buffer.alloc(32));

test("decodes the pinned Pump SDK TradeEvent layout from a successful program invocation", () => {
  const fields = [
    pk(mint),
    u64(500n),
    u64(900n),
    Buffer.from([1]),
    pk(trader),
    i64(1_798_000_000n),
    u64(10n),
    u64(11n),
    u64(12n),
    u64(13n),
    pk(trader),
    u64(14n),
    u64(15n),
    pk(trader),
    u64(16n),
    u64(17n),
    Buffer.from([0]),
    u64(18n),
    u64(19n),
    u64(20n),
    i64(21n),
    string("buy"),
    Buffer.from([0]),
    u64(0n),
    u64(0n),
    u64(0n),
    u64(0n),
    u32(0),
    pk(systemProgram),
    u64(500n),
    u64(0n),
    u64(0n),
    u64(0n),
    u64(0n),
    u64(0n),
  ];
  const event = Buffer.concat([
    Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]),
    ...fields,
  ]);
  const logs = [
    `Program ${PUMP_PROGRAM_ID} invoke [1]`,
    `Program data: ${event.toString("base64")}`,
    `Program ${PUMP_PROGRAM_ID} success`,
  ];
  const decoded = decodePumpTradeEvents(logs);
  assert.equal(decoded.length, 1);
  assert.deepEqual(decoded[0], {
    eventIndex: 0,
    mint,
    side: "BUY",
    traderWallet: trader,
    tokenAmountRaw: "900",
    quoteAmountRaw: "500",
    quoteMint: systemProgram,
    timestampSeconds: 1_798_000_000n,
    instructionName: "PUMP_TRADE_EVENT_IDL_4_1_0",
  });
  assert.deepEqual(
    decodePumpTradeEvents([
      `Program ${PUMP_PROGRAM_ID} invoke [1]`,
      `Program data: ${event.toString("base64")}`,
    ]),
    [],
  );
});

test("PumpSwap BuyEvent and SellEvent decode under successful venue invocations", () => {
  const buy = encodePumpSwapEvent(true);
  const sell = encodePumpSwapEvent(false);
  const logs = [
    `Program ${PUMPSWAP_PROGRAM_ID} invoke [1]`,
    `Program data: ${buy.toString("base64")}`,
    `Program data: ${sell.toString("base64")}`,
    `Program ${PUMPSWAP_PROGRAM_ID} success`,
  ];
  assert.deepEqual(
    decodePumpSwapTradeEvents(logs).map((event) => ({
      eventIndex: event.eventIndex,
      side: event.side,
      traderWallet: event.traderWallet,
      pool: event.pool,
      tokenAmountRaw: event.tokenAmountRaw,
      quoteAmountRaw: event.quoteAmountRaw,
      instructionName: event.instructionName,
    })),
    [
      {
        eventIndex: 0,
        side: "BUY",
        traderWallet: trader,
        pool,
        tokenAmountRaw: "900",
        quoteAmountRaw: "500",
        instructionName: "PUMPSWAP_BUY_EVENT_IDL_2_1_0",
      },
      {
        eventIndex: 1,
        side: "SELL",
        traderWallet: trader,
        pool,
        tokenAmountRaw: "900",
        quoteAmountRaw: "500",
        instructionName: "PUMPSWAP_SELL_EVENT_IDL_2_1_0",
      },
    ],
  );
  assert.deepEqual(
    decodePumpSwapTradeEvents([
      `Program ${PUMPSWAP_PROGRAM_ID} invoke [1]`,
      `Program data: ${buy.toString("base64")}`,
      `Program ${PUMPSWAP_PROGRAM_ID} failed: custom program error: 0x1`,
    ]),
    [],
  );
  assert.deepEqual(
    decodePumpSwapTradeEvents([
      `Program ${PUMP_PROGRAM_ID} invoke [1]`,
      `Program data: ${buy.toString("base64")}`,
      `Program ${PUMP_PROGRAM_ID} success`,
    ]),
    [],
  );
});

test("Pump SDK decoder rejects malformed shareholder vector and unsupported suffix", () => {
  const valid = encodePumpTradeEvent();
  const malformed = Buffer.from(valid);
  // The u32 shareholder count follows ix_name, mayhem and four fee u64 fields.
  const shareholderCountOffset = 298;
  malformed.writeUInt32LE(1, shareholderCountOffset);
  const logs = [
    `Program ${PUMP_PROGRAM_ID} invoke [1]`,
    `Program data: ${malformed.toString("base64")}`,
    `Program ${PUMP_PROGRAM_ID} success`,
  ];
  assert.deepEqual(decodePumpTradeEvents(logs), []);
  assert.deepEqual(
    decodePumpTradeEvents([
      `Program ${PUMP_PROGRAM_ID} invoke [1]`,
      `Program data: ${Buffer.concat([valid, Buffer.from([0])]).toString("base64")}`,
      `Program ${PUMP_PROGRAM_ID} success`,
    ]),
    [],
  );
});

test("finalized transaction validation checks signature, slot, trader signer, and exact token delta", () => {
  const logs = [
    `Program ${PUMP_PROGRAM_ID} invoke [1]`,
    `Program data: ${encodePumpTradeEvent().toString("base64")}`,
    `Program ${PUMP_PROGRAM_ID} success`,
  ];
  const transaction = verifiedTransaction(logs);
  const result = validateTradeTransaction({
    mint,
    signature: transaction.signature,
    providerSlot: transaction.slot,
    receivedAtUtc: "2026-11-01T00:00:00.000Z",
    transaction,
  });
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0]?.quoteAmountRaw, "500");
  assert.equal(
    result.observations[0]?.blockTimeUtc,
    "2026-11-01T00:00:00.000Z",
  );
  assert.equal(
    result.observations[0]?.eventTimeUtc,
    "2026-11-01T00:00:00.000Z",
  );

  assert.equal(
    validateTradeTransaction({
      mint,
      signature: "different-signature",
      providerSlot: transaction.slot,
      receivedAtUtc: "2026-11-01T00:00:00.000Z",
      transaction,
    }).reasonCode,
    "TRADE_SIGNATURE_MISMATCH",
  );
  assert.equal(
    validateTradeTransaction({
      mint,
      signature: transaction.signature,
      providerSlot: transaction.slot + 1,
      receivedAtUtc: "2026-11-01T00:00:00.000Z",
      transaction,
    }).reasonCode,
    "TRADE_SLOT_MISMATCH",
  );
  const wrongDelta = verifiedTransaction(logs, "899");
  assert.equal(
    validateTradeTransaction({
      mint,
      signature: wrongDelta.signature,
      providerSlot: wrongDelta.slot,
      receivedAtUtc: "2026-11-01T00:00:00.000Z",
      transaction: wrongDelta,
    }).reasonCode,
    "TRADE_TOKEN_DELTA_MISMATCH",
  );
});

test("PumpSwap trade remains unknown until pool mints and trader token delta are verified", () => {
  const logs = [
    `Program ${PUMPSWAP_PROGRAM_ID} invoke [1]`,
    `Program data: ${encodePumpSwapEvent(true).toString("base64")}`,
    `Program ${PUMPSWAP_PROGRAM_ID} success`,
  ];
  const transaction = verifiedTransaction(logs);
  const common = {
    mint,
    signature: transaction.signature,
    providerSlot: transaction.slot,
    receivedAtUtc: "2026-11-01T00:00:00.000Z",
    transaction,
  };
  assert.equal(
    validateTradeTransaction(common).reasonCode,
    "PUMPSWAP_POOL_STATE_UNVERIFIED",
  );
  const validated = validateTradeTransaction({
    ...common,
    pumpSwapPools: new Map([
      [pool, { baseMint: mint, quoteMint: systemProgram }],
    ]),
  });
  assert.equal(validated.reasonCode, "PUMPSWAP_QUOTE_ASSET_UNSUPPORTED");
  const supported = validateTradeTransaction({
    ...common,
    pumpSwapPools: new Map([
      [
        pool,
        {
          baseMint: mint,
          quoteMint: "So11111111111111111111111111111111111111112",
        },
      ],
    ]),
  });
  assert.equal(supported.status, "VERIFIED");
  assert.equal(supported.observations[0]?.venue, "PUMPSWAP");
});

test("trade verification queue bounds work, rejects duplicate signatures, and drains on stop", async () => {
  let releaseFirst: (() => void) | undefined;
  const processed: string[] = [];
  const queue = new BoundedTradeVerificationQueue({
    maxPending: 2,
    concurrency: 1,
    async process(input) {
      if (input.signature === "first")
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      processed.push(input.signature);
    },
    onFailure(_input, error) {
      assert.fail(String(error));
    },
  });
  const observation = (signature: string): HeliusLogTradeInput => ({
    mint,
    signature,
    slot: 1,
    logs: [],
    observedAtUtc: "2026-11-01T00:00:00.000Z",
    payloadRef: `sha256:${"b".repeat(64)}`,
    windowStartedAtUtc: "2026-11-01T00:00:00.000Z",
    windowExpiresAtUtc: "2026-11-01T00:01:00.000Z",
    reconnectCount: 0,
  });
  assert.equal(queue.enqueue(observation("first")), "ACCEPTED");
  assert.equal(queue.enqueue(observation("second")), "ACCEPTED");
  assert.equal(queue.enqueue(observation("third")), "FULL");
  assert.equal(queue.enqueue(observation("first")), "DUPLICATE");
  assert.equal(queue.activeCount, 1);
  assert.equal(queue.pendingCount, 1);
  const stopped = queue.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(processed, []);
  releaseFirst?.();
  await stopped;
  assert.deepEqual(processed, ["first", "second"]);
  assert.equal(queue.enqueue(observation("after-stop")), "STOPPED");
});

test("Helius reconnect records a gap and resubscribes without claiming completeness", async () => {
  const sockets: FakeSocket[] = [];
  const coverage: string[] = [];
  const stream = new HeliusTradeStream({
    apiKey: "test-key",
    maxActiveSubscriptions: 2,
    subscriptionDurationSeconds: 60,
    consumeEventBudget: () => true,
    onLogs: () => undefined,
    onCoverage: ({ status, reasonCode }) =>
      coverage.push(`${status}:${reasonCode}`),
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    minBackoffMs: 5,
    maxBackoffMs: 5,
  });
  stream.start();
  assert.equal(stream.subscribeMint(mint), true);
  sockets[0]!.emit("open");
  assert.equal(stream.activeSubscriptionCount, 1);
  assert.match(sockets[0]!.sent[0]!, /logsSubscribe/);
  sockets[0]!.emit("error", new Error("synthetic socket fault"));
  await waitFor(() => sockets.length === 2);
  sockets[1]!.emit("open");
  assert.match(sockets[1]!.sent[0]!, /logsSubscribe/);
  assert.ok(coverage.some((item) => item.startsWith("GAP_DETECTED:")));
  assert.ok(coverage.includes("GAP_DETECTED:HELIUS_TRADE_SOCKET_ERROR"));
  assert.ok(coverage.every((item) => !item.startsWith("COMPLETE:")));
  await stream.stop();
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("OBSERVABLE_EVENT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function pk(value: string): Buffer {
  if (value === mint) return Buffer.alloc(32, 1);
  if (value === trader) return Buffer.alloc(32, 2);
  if (value === pool) return Buffer.alloc(32, 3);
  if (value === systemProgram) return Buffer.alloc(32);
  assert.fail("UNKNOWN_SYNTHETIC_PUBLIC_KEY");
}

function encodePumpTradeEvent(): Buffer {
  return Buffer.concat([
    Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]),
    pk(mint),
    u64(500n),
    u64(900n),
    Buffer.from([1]),
    pk(trader),
    i64(1_793_491_200n),
    u64(10n),
    u64(11n),
    u64(12n),
    u64(13n),
    pk(trader),
    u64(14n),
    u64(15n),
    pk(trader),
    u64(16n),
    u64(17n),
    Buffer.from([0]),
    u64(18n),
    u64(19n),
    u64(20n),
    i64(21n),
    string("buy"),
    Buffer.from([0]),
    u64(0n),
    u64(0n),
    u64(0n),
    u64(0n),
    u32(0),
    pk(systemProgram),
    u64(500n),
    u64(0n),
    u64(0n),
    u64(0n),
    u64(0n),
    u64(0n),
  ]);
}

function encodePumpSwapEvent(isBuy: boolean): Buffer {
  const discriminator = isBuy
    ? Buffer.from([103, 244, 82, 31, 44, 245, 119, 119])
    : Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]);
  const fields: Buffer[] = [
    i64(1_793_491_200n),
    ...Array.from({ length: 13 }, (_, i) =>
      u64(i === 0 ? 900n : i === 12 ? 500n : 1n),
    ),
    pk(pool),
    pk(trader),
  ];
  for (let index = 0; index < 5; index += 1) fields.push(pk(trader));
  fields.push(u64(1n), u64(2n));
  if (isBuy) {
    fields.push(
      Buffer.from([1]),
      u64(3n),
      u64(4n),
      u64(5n),
      i64(6n),
      u64(7n),
      string("buy_v2"),
    );
  }
  fields.push(
    u64(8n),
    u64(9n),
    u64(10n),
    u64(11n),
    Buffer.alloc(16),
    Buffer.from([1]),
    u64(12n),
    u64(13n),
    u64(14n),
    u64(15n),
  );
  return Buffer.concat([discriminator, ...fields]);
}

function verifiedTransaction(
  logMessages: string[],
  postAmountRaw = "900",
): WalletTransaction {
  return {
    signature:
      "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv",
    slot: 55,
    blockTime: 1793491200,
    succeeded: true,
    feeLamports: 5000,
    accountKeys: [
      { pubkey: trader, signer: true, writable: true },
      { pubkey: mint, signer: false, writable: true },
    ],
    instructions: [],
    logMessages,
    preBalances: [100_000_000, 0],
    postBalances: [99_995_000, 0],
    preTokenBalances: [],
    postTokenBalances: [
      { accountIndex: 1, mint, owner: trader, amountRaw: postAmountRaw },
    ],
  };
}

function u64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}
function i64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(value);
  return bytes;
}
function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}
function string(value: string): Buffer {
  const content = Buffer.from(value);
  return Buffer.concat([u32(content.length), content]);
}
