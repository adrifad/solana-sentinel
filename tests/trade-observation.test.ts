import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { base58Encode } from "@sentinel/domain";
import { decodePumpTradeEvents, PUMP_PROGRAM_ID } from "@sentinel/intelligence";
import { HeliusTradeStream } from "@sentinel/providers";
import type WebSocket from "ws";

const mint = base58Encode(Buffer.alloc(32, 1));
const trader = base58Encode(Buffer.alloc(32, 2));
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
  sockets[0]!.emit("close");
  await waitFor(() => sockets.length === 2);
  sockets[1]!.emit("open");
  assert.match(sockets[1]!.sent[0]!, /logsSubscribe/);
  assert.ok(coverage.some((item) => item.startsWith("GAP_DETECTED:")));
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
  if (value === systemProgram) return Buffer.alloc(32);
  assert.fail("UNKNOWN_SYNTHETIC_PUBLIC_KEY");
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
