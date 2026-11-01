import { base58Encode, LaunchBehaviorSnapshotSchema } from "@sentinel/domain";
import type {
  LaunchBehaviorSnapshot,
  LaunchTradeObservation,
} from "@sentinel/domain";
import type { WalletTransaction } from "@sentinel/providers";
import { PUMP_PROGRAM_ID } from "./pump-constants.ts";
export { PUMP_PROGRAM_ID } from "./pump-constants.ts";
export { decodePumpTradeEvents } from "./pump-trades.ts";

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

export type WalletTokenOutflow = {
  wallet: string;
  mint: string;
  signature: string;
  slot: number;
  beforeAmountRaw: string;
  afterAmountRaw: string;
  observedAtUtc: string | null;
  reasonCode: "WALLET_ASSOCIATED_TOKEN_OUTFLOW";
  confidenceBps: 6500;
};

export function analyzeLaunchBehavior(input: {
  mint: string;
  observations: LaunchTradeObservation[];
  creatorWallets: string[];
  linkedWallets: string[];
  windowStartedAtUtc: string;
  observedAtUtc: string;
  windowSeconds: 30 | 60 | 120;
  throughSlot: number | null;
  complete: boolean;
  gapReason: string | null;
  minIndependentBuyers: number;
  metadataLikelyTest?: boolean;
}): LaunchBehaviorSnapshot {
  const endMs = Date.parse(input.observedAtUtc);
  const startMs = Date.parse(input.windowStartedAtUtc);
  const creators = new Set(input.creatorWallets);
  const linked = new Set(input.linkedWallets);
  const observations = input.observations
    .filter((item) => {
      const at = Date.parse(item.blockTimeUtc ?? item.receivedAtUtc);
      return (
        item.mint === input.mint &&
        at >= startMs &&
        at <= endMs &&
        (input.throughSlot === null ||
          item.slot === null ||
          item.slot <= input.throughSlot)
      );
    })
    .sort((a, b) => {
      const slotA = a.slot ?? Number.MAX_SAFE_INTEGER;
      const slotB = b.slot ?? Number.MAX_SAFE_INTEGER;
      return slotA - slotB || a.receivedAtUtc.localeCompare(b.receivedAtUtc);
    });
  const buys = observations.filter((item) => item.side === "BUY");
  const sells = observations.filter((item) => item.side === "SELL");
  const buyerCounts = new Map<string, number>();
  const walletVolumes = new Map<string, bigint>();
  const walletSides = new Map<string, Set<"BUY" | "SELL">>();
  let buyVolume = 0n;
  let sellVolume = 0n;
  let creatorAssociatedBuys = 0;
  for (const item of observations) {
    const amount = BigInt(item.quoteAmountRaw ?? "0");
    const wallet = item.traderWallet;
    if (wallet) {
      buyerCounts.set(wallet, (buyerCounts.get(wallet) ?? 0) + 1);
      walletVolumes.set(wallet, (walletVolumes.get(wallet) ?? 0n) + amount);
      const sides = walletSides.get(wallet) ?? new Set<"BUY" | "SELL">();
      sides.add(item.side);
      walletSides.set(wallet, sides);
    }
    if (item.side === "BUY") {
      buyVolume += amount;
      if (wallet && creators.has(wallet)) creatorAssociatedBuys += 1;
    } else sellVolume += amount;
  }
  const independentWallets = new Set(
    buys
      .map((item) => item.traderWallet)
      .filter(
        (wallet): wallet is string =>
          wallet !== null && !creators.has(wallet) && !linked.has(wallet),
      ),
  );
  const repeatedWalletTransactions = [...buyerCounts.values()].reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0,
  );
  const suspectedWashPattern = [...walletSides.entries()].some(
    ([wallet, sides]) =>
      sides.has("BUY") &&
      sides.has("SELL") &&
      (buyerCounts.get(wallet) ?? 0) >= 3,
  );
  const totalVolume = buyVolume + sellVolume;
  const maxWalletVolume = [...walletVolumes.values()].reduce(
    (maximum, current) => (current > maximum ? current : maximum),
    0n,
  );
  const largestWalletVolumeBps =
    totalVolume === 0n
      ? null
      : Number((maxWalletVolume * 10000n) / totalVolume);
  const reasons = new Set<string>();
  let classification: LaunchBehaviorSnapshot["classification"] = "UNKNOWN";
  let confidenceBps = 0;
  if (input.metadataLikelyTest) {
    classification = "LIKELY_TEST";
    confidenceBps = 7000;
    reasons.add("TEST_TOKEN_METADATA_PATTERN");
  } else if (!input.complete) {
    reasons.add(input.gapReason ?? "OBSERVATION_WINDOW_INCOMPLETE");
  } else if (suspectedWashPattern) {
    classification = "UNKNOWN";
    confidenceBps = 4000;
    reasons.add("POSSIBLE_WASH_TRADING_PATTERN");
  } else if (independentWallets.size < input.minIndependentBuyers) {
    reasons.add("MIN_INDEPENDENT_BUYERS_NOT_MET");
    classification = "UNKNOWN";
  } else {
    classification = "ORGANIC_CANDIDATE";
    confidenceBps = Math.min(8000, 5000 + independentWallets.size * 250);
    reasons.add("INDEPENDENT_BUYER_THRESHOLD_MET");
  }
  if (largestWalletVolumeBps !== null && largestWalletVolumeBps >= 8000)
    reasons.add("EARLY_VOLUME_CONCENTRATION_HIGH");
  if (creatorAssociatedBuys > 0) reasons.add("CREATOR_ASSOCIATED_BUY_ACTIVITY");
  const uniqueEvidenceRefs = [
    ...new Set(observations.map((item) => `launch_trade:${item.id}`)),
  ];
  const candidate = {
    id: `${input.mint}:${input.windowSeconds}:${input.observedAtUtc}`,
    mint: input.mint,
    windowSeconds: input.windowSeconds,
    windowStartedAtUtc: input.windowStartedAtUtc,
    observedAtUtc: input.observedAtUtc,
    throughSlot: input.throughSlot,
    buyCount: buys.length,
    sellCount: sells.length,
    uniqueBuyers: new Set(buys.map((item) => item.traderWallet).filter(Boolean))
      .size,
    independentBuyerEstimate: independentWallets.size,
    creatorAssociatedBuys,
    repeatedWalletTransactions,
    largestWalletVolumeBps,
    volumeBuyRaw: buyVolume.toString(),
    volumeSellRaw: sellVolume.toString(),
    marketPhase: observations.some((item) => item.venue === "PUMPSWAP")
      ? "MIGRATED_PUMPSWAP"
      : observations.some((item) => item.venue === "PUMP_BONDING_CURVE")
        ? "PUMP_CURVE"
        : "UNKNOWN",
    classification,
    reasonCodes: [...reasons].sort(),
    confidenceBps,
    complete: input.complete,
    gapReason: input.gapReason,
    evidenceRefs: uniqueEvidenceRefs,
  };
  return LaunchBehaviorSnapshotSchema.parse(candidate);
}

/** Detects a verified token balance decrease for the queried wallet only. */
export function detectWalletTokenOutflows(
  wallet: string,
  transaction: WalletTransaction,
): WalletTokenOutflow[] {
  if (!transaction.succeeded) return [];
  const before = sumOwnedTokenBalances(transaction.preTokenBalances, wallet);
  const after = sumOwnedTokenBalances(transaction.postTokenBalances, wallet);
  const mints = new Set([...before.keys(), ...after.keys()]);
  const observedAtUtc = transaction.blockTime
    ? new Date(transaction.blockTime * 1000).toISOString()
    : null;
  const results: WalletTokenOutflow[] = [];
  for (const mint of mints) {
    const beforeAmountRaw = before.get(mint) ?? 0n;
    const afterAmountRaw = after.get(mint) ?? 0n;
    if (afterAmountRaw >= beforeAmountRaw || beforeAmountRaw === 0n) continue;
    results.push({
      wallet,
      mint,
      signature: transaction.signature,
      slot: transaction.slot,
      beforeAmountRaw: beforeAmountRaw.toString(),
      afterAmountRaw: afterAmountRaw.toString(),
      observedAtUtc,
      reasonCode: "WALLET_ASSOCIATED_TOKEN_OUTFLOW",
      confidenceBps: 6500,
    });
  }
  return results;
}

function sumOwnedTokenBalances(
  balances: NonNullable<WalletTransaction["preTokenBalances"]> | undefined,
  wallet: string,
): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const balance of balances ?? []) {
    if (balance.owner !== wallet) continue;
    totals.set(
      balance.mint,
      (totals.get(balance.mint) ?? 0n) + BigInt(balance.amountRaw),
    );
  }
  return totals;
}

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
