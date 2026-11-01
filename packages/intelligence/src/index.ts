import { base58Encode } from "@sentinel/domain";
import type { WalletTransaction } from "@sentinel/providers";

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const CREATE_EVENT_DISCRIMINATOR = Buffer.from([
  27, 114, 169, 77, 222, 235, 99, 118,
]);

export type PumpCreateEvent = {
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  user: string;
  creator: string;
  timestampSeconds: bigint;
};

export type FundingTransfer = {
  source: string;
  destination: string;
  lamportsRaw: string;
};

export function decodePumpCreateEvents(
  logMessages: string[],
): PumpCreateEvent[] {
  const events: PumpCreateEvent[] = [];
  const programs: string[] = [];
  for (const line of logMessages) {
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(
      line,
    );
    if (invoke) {
      const depth = Number(invoke[2]);
      if (Number.isSafeInteger(depth) && depth > 0) {
        programs.length = depth - 1;
        programs[depth - 1] = invoke[1] ?? "";
      }
      continue;
    }
    const completed =
      /^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed:.*)$/.exec(line);
    if (completed) {
      const index = programs.lastIndexOf(completed[1] ?? "");
      if (index >= 0) programs.length = index;
      continue;
    }
    if (!programs.includes(PUMP_PROGRAM_ID)) continue;
    const data = /^Program data: ([A-Za-z0-9+/]+={0,2})$/.exec(line)?.[1];
    if (!data) continue;
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data) continue;
    const event = decodeCreateEvent(bytes);
    if (event) events.push(event);
  }
  return events;
}

function decodeCreateEvent(data: Buffer): PumpCreateEvent | null {
  if (
    data.length < 8 + CREATE_EVENT_DISCRIMINATOR.length ||
    !data.subarray(0, 8).equals(CREATE_EVENT_DISCRIMINATOR)
  )
    return null;
  let offset = 8;
  const takeString = (maxBytes: number): string | null => {
    if (offset + 4 > data.length) return null;
    const length = data.readUInt32LE(offset);
    offset += 4;
    if (length > maxBytes || offset + length > data.length) return null;
    const value = new TextDecoder("utf-8", { fatal: true }).decode(
      data.subarray(offset, offset + length),
    );
    offset += length;
    return value;
  };
  const takePubkey = (): string | null => {
    if (offset + 32 > data.length) return null;
    const value = base58Encode(data.subarray(offset, offset + 32));
    offset += 32;
    return value;
  };
  try {
    const name = takeString(128);
    const symbol = takeString(32);
    const uri = takeString(2048);
    const mint = takePubkey();
    const bondingCurve = takePubkey();
    const user = takePubkey();
    const creator = takePubkey();
    if (
      name === null ||
      symbol === null ||
      uri === null ||
      mint === null ||
      bondingCurve === null ||
      user === null ||
      creator === null ||
      offset + 8 > data.length
    )
      return null;
    return {
      name,
      symbol,
      uri,
      mint,
      bondingCurve,
      user,
      creator,
      timestampSeconds: data.readBigInt64LE(offset),
    };
  } catch {
    return null;
  }
}

export function extractDirectFundingTransfers(
  transaction: WalletTransaction,
): FundingTransfer[] {
  if (!transaction.succeeded) return [];
  const transfers: FundingTransfer[] = [];
  for (const instruction of transaction.instructions) {
    if (instruction.program !== "system" || !isRecord(instruction.parsed))
      continue;
    const parsed = instruction.parsed;
    if (parsed["type"] !== "transfer" || !isRecord(parsed["info"])) continue;
    const info = parsed["info"];
    const source = info["source"];
    const destination = info["destination"];
    const lamports = info["lamports"];
    if (
      typeof source !== "string" ||
      typeof destination !== "string" ||
      source === destination ||
      !(
        typeof lamports === "string" ||
        (typeof lamports === "number" && Number.isSafeInteger(lamports))
      )
    )
      continue;
    const amount = String(lamports);
    if (!/^\d+$/.test(amount)) continue;
    transfers.push({ source, destination, lamportsRaw: amount });
  }
  return transfers;
}

export function transactionSigners(transaction: WalletTransaction): string[] {
  return transaction.accountKeys
    .filter((account) => account.signer)
    .map((account) => account.pubkey);
}

export function transactionFeePayer(
  transaction: WalletTransaction,
): string | null {
  const first = transaction.accountKeys[0];
  return first?.signer ? first.pubkey : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
