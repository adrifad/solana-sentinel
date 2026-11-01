import { base58Encode } from "@sentinel/domain";

export const PUMPSWAP_PROGRAM_ID =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const BUY_EVENT_DISCRIMINATOR = Buffer.from([
  103, 244, 82, 31, 44, 245, 119, 119,
]);
const SELL_EVENT_DISCRIMINATOR = Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]);

export type PumpSwapTradeEvent = {
  eventIndex: number;
  side: "BUY" | "SELL";
  traderWallet: string;
  pool: string;
  tokenAmountRaw: string;
  quoteAmountRaw: string;
  timestampSeconds: bigint;
  instructionName:
    "PUMPSWAP_BUY_EVENT_IDL_2_1_0" | "PUMPSWAP_SELL_EVENT_IDL_2_1_0";
};

/**
 * Decode only BuyEvent/SellEvent payloads emitted by a successful PumpSwap
 * invocation. The event has no mint field; transaction evidence must associate
 * its user token-balance delta with the requested mint before persistence.
 */
export function decodePumpSwapTradeEvents(
  logMessages: string[],
): PumpSwapTradeEvent[] {
  const result: Array<Omit<PumpSwapTradeEvent, "eventIndex">> = [];
  const programs: string[] = [];
  const pendingByDepth: Array<Array<Omit<PumpSwapTradeEvent, "eventIndex">>> =
    [];
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
      if (index < 0) continue;
      if (completed[2] === "success" && programs[index] === PUMPSWAP_PROGRAM_ID)
        result.push(...(pendingByDepth[index] ?? []));
      programs.length = index;
      pendingByDepth.length = index;
      continue;
    }
    if (programs.at(-1) !== PUMPSWAP_PROGRAM_ID) continue;
    const encoded = /^Program data: ([A-Za-z0-9+/]+={0,2})$/.exec(line)?.[1];
    if (!encoded) continue;
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) continue;
    const event = decodeEvent(bytes);
    if (event) pendingByDepth[programs.length - 1]?.push(event);
  }
  return result.map((event, eventIndex) => ({ ...event, eventIndex }));
}

function decodeEvent(
  data: Buffer,
): Omit<PumpSwapTradeEvent, "eventIndex"> | null {
  if (data.length < 8) return null;
  const isBuy = data.subarray(0, 8).equals(BUY_EVENT_DISCRIMINATOR);
  const isSell = data.subarray(0, 8).equals(SELL_EVENT_DISCRIMINATOR);
  if (!isBuy && !isSell) return null;

  let offset = 8;
  const take = (size: number): Buffer | null => {
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > data.length)
      return null;
    const bytes = data.subarray(offset, offset + size);
    offset += size;
    return bytes;
  };
  const u64 = (): bigint | null => {
    const bytes = take(8);
    return bytes ? bytes.readBigUInt64LE(0) : null;
  };
  const i64 = (): bigint | null => {
    const bytes = take(8);
    return bytes ? bytes.readBigInt64LE(0) : null;
  };
  const pubkey = (): string | null => {
    const bytes = take(32);
    return bytes ? base58Encode(bytes) : null;
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
  const skipPubkeys = (count: number): boolean => {
    for (let index = 0; index < count; index += 1) if (!pubkey()) return false;
    return true;
  };
  try {
    const timestampSeconds = i64();
    const tokenAmount = u64();
    if (timestampSeconds === null || tokenAmount === null || tokenAmount === 0n)
      return null;
    // Both official event structs have thirteen u64 values before pool/user.
    // The first is base_amount_{out,in}; the thirteenth is user_quote_amount.
    if (!skipU64s(11)) return null;
    const quoteAmount = u64();
    if (quoteAmount === null || quoteAmount === 0n) return null;
    const pool = pubkey();
    const traderWallet = pubkey();
    if (!pool || !traderWallet || !skipPubkeys(5)) return null;
    if (!skipU64s(2)) return null; // creator fee basis points and fee

    if (isBuy) {
      if (bool() === null || !skipU64s(3) || i64() === null || u64() === null)
        return null;
      const stringLengthBytes = take(4);
      if (!stringLengthBytes) return null;
      const stringLength = stringLengthBytes.readUInt32LE(0);
      if (stringLength > 64) return null;
      const instructionName = take(stringLength)?.toString("utf8");
      if (!instructionName || !instructionName.startsWith("buy")) return null;
    }

    // PumpSwap 2.1.0 v1/v2 BuyEvent and SellEvent fee/reserve tail.
    if (!skipU64s(isBuy ? 4 : 4) || !take(16) || bool() === null) return null;
    if (!skipU64s(4) || offset !== data.length) return null;
    return {
      side: isBuy ? "BUY" : "SELL",
      traderWallet,
      pool,
      tokenAmountRaw: tokenAmount.toString(),
      quoteAmountRaw: quoteAmount.toString(),
      timestampSeconds,
      instructionName: isBuy
        ? "PUMPSWAP_BUY_EVENT_IDL_2_1_0"
        : "PUMPSWAP_SELL_EVENT_IDL_2_1_0",
    };
  } catch {
    return null;
  }
}
