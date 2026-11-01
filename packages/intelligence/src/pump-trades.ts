import { base58Encode } from "@sentinel/domain";
import { PUMP_PROGRAM_ID } from "./pump-constants.ts";

const TRADE_EVENT_DISCRIMINATOR = Buffer.from([
  189, 219, 127, 211, 78, 230, 97, 238,
]);
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

export type PumpTradeEvent = {
  eventIndex: number;
  mint: string;
  side: "BUY" | "SELL";
  traderWallet: string;
  tokenAmountRaw: string;
  quoteAmountRaw: string;
  quoteMint: string;
  timestampSeconds: bigint;
  instructionName: string;
};

/**
 * Decode only the pinned Pump SDK 4.1.0 TradeEvent IDL layout from a successful
 * Pump program invocation. Unknown event versions or quote mints are omitted.
 */
export function decodePumpTradeEvents(logMessages: string[]): PumpTradeEvent[] {
  const result: PumpTradeEvent[] = [];
  const programs: string[] = [];
  const pendingByDepth: PumpTradeEvent[][] = [];
  for (const line of logMessages) {
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(
      line,
    );
    if (invoke) {
      const depth = Number(invoke[2]);
      if (Number.isSafeInteger(depth) && depth > 0) {
        programs.length = depth - 1;
        programs[depth - 1] = invoke[1] ?? "";
        pendingByDepth.length = depth - 1;
        pendingByDepth[depth - 1] = [];
      }
      continue;
    }
    const completed =
      /^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed:.*)$/.exec(line);
    if (completed) {
      const index = programs.lastIndexOf(completed[1] ?? "");
      if (index >= 0) {
        if (completed[2] === "success" && programs[index] === PUMP_PROGRAM_ID) {
          for (const event of pendingByDepth[index] ?? [])
            result.push({ ...event, eventIndex: result.length });
        }
        programs.length = index;
        pendingByDepth.length = index;
      }
      continue;
    }
    if (programs.at(-1) !== PUMP_PROGRAM_ID) continue;
    const encoded = /^Program data: ([A-Za-z0-9+/]+={0,2})$/.exec(line)?.[1];
    if (!encoded) continue;
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) continue;
    const event = decodeTradeEvent(bytes, 0);
    if (event) pendingByDepth[programs.length - 1]?.push(event);
  }
  return result;
}

function decodeTradeEvent(
  data: Buffer,
  eventIndex: number,
): PumpTradeEvent | null {
  if (
    data.length < 8 + 32 + 8 + 8 + 1 + 32 + 8 ||
    !data.subarray(0, 8).equals(TRADE_EVENT_DISCRIMINATOR)
  )
    return null;
  let offset = 8;
  const take = (size: number): Buffer | null => {
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > data.length)
      return null;
    const bytes = data.subarray(offset, offset + size);
    offset += size;
    return bytes;
  };
  const pubkey = (): string | null => {
    const bytes = take(32);
    return bytes ? base58Encode(bytes) : null;
  };
  const u64 = (): bigint | null => {
    const bytes = take(8);
    return bytes ? bytes.readBigUInt64LE(0) : null;
  };
  const i64 = (): bigint | null => {
    const bytes = take(8);
    return bytes ? bytes.readBigInt64LE(0) : null;
  };
  const bool = (): boolean | null => {
    const bytes = take(1);
    if (!bytes || (bytes[0] !== 0 && bytes[0] !== 1)) return null;
    return bytes[0] === 1;
  };
  const skipU64s = (count: number): boolean => {
    for (let index = 0; index < count; index += 1)
      if (u64() === null) return false;
    return true;
  };
  try {
    const mint = pubkey();
    const solAmount = u64();
    const tokenAmount = u64();
    const isBuy = bool();
    const traderWallet = pubkey();
    const timestampSeconds = i64();
    if (
      !mint ||
      solAmount === null ||
      tokenAmount === null ||
      isBuy === null ||
      !traderWallet ||
      timestampSeconds === null
    )
      return null;

    // Reserves, fee recipient/amounts, creator/fees, and volume fields.
    if (!skipU64s(4) || !pubkey() || !skipU64s(2) || !pubkey()) return null;
    if (!skipU64s(2) || bool() === null || !skipU64s(3) || i64() === null)
      return null;
    const stringLengthBytes = take(4);
    if (!stringLengthBytes) return null;
    const stringLength = stringLengthBytes.readUInt32LE(0);
    if (stringLength > 64 || !take(stringLength) || bool() === null)
      return null;
    if (!skipU64s(4)) return null;
    const shareholderLengthBytes = take(4);
    if (!shareholderLengthBytes) return null;
    const shareholderCount = shareholderLengthBytes.readUInt32LE(0);
    if (shareholderCount > 100 || !take(shareholderCount * 40)) return null;
    const quoteMint = pubkey();
    const quoteAmount = u64();
    if (!quoteMint || quoteAmount === null) return null;

    // The supported quote engines only price native SOL/WSOL routes.
    if (quoteMint !== SYSTEM_PROGRAM_ID && quoteMint !== WSOL_MINT) return null;
    const normalizedQuoteAmount =
      quoteMint === WSOL_MINT && quoteAmount > 0n ? quoteAmount : solAmount;
    if (tokenAmount <= 0n || normalizedQuoteAmount <= 0n) return null;
    return {
      eventIndex,
      mint,
      side: isBuy ? "BUY" : "SELL",
      traderWallet,
      tokenAmountRaw: tokenAmount.toString(),
      quoteAmountRaw: normalizedQuoteAmount.toString(),
      quoteMint,
      timestampSeconds,
      instructionName: "PUMP_TRADE_EVENT_IDL_4_1_0",
    };
  } catch {
    return null;
  }
}
