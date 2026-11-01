import type { WalletTransaction } from "@sentinel/providers";
import { decodePumpTradeEvents } from "./pump-trades.ts";
import { decodePumpSwapTradeEvents } from "./pumpswap-trades.ts";

const MAX_EVENT_BLOCK_TIME_SKEW_SECONDS = 60;

export type VerifiedTradeObservation = {
  eventIndex: number;
  mint: string;
  signature: string;
  slot: number;
  blockTimeUtc: string | null;
  eventTimeUtc: string;
  receivedAtUtc: string;
  side: "BUY" | "SELL";
  traderWallet: string;
  tokenAmountRaw: string;
  quoteAmountRaw: string;
  quoteMint: string;
  venue: "PUMP_BONDING_CURVE" | "PUMPSWAP";
  source: string;
  decoderVersion: string;
  validationConfidenceBps: 10000;
};

export type TradeTransactionValidation = {
  status: "VERIFIED" | "UNVERIFIED";
  reasonCode: string | null;
  observations: VerifiedTradeObservation[];
};

type Candidate = {
  eventIndex: number;
  side: "BUY" | "SELL";
  traderWallet: string;
  tokenAmountRaw: string;
  quoteAmountRaw: string;
  quoteMint: string | null;
  timestampSeconds: bigint;
  venue: "PUMP_BONDING_CURVE" | "PUMPSWAP";
  source: string;
  decoderVersion: string;
  pool?: string;
};

/** Correlates decoded events with finalized Helius transaction evidence. */
export function validateTradeTransaction(input: {
  mint: string;
  signature: string;
  providerSlot: number;
  receivedAtUtc: string;
  transaction: WalletTransaction | null;
  pumpSwapPools?: ReadonlyMap<string, { baseMint: string; quoteMint: string }>;
}): TradeTransactionValidation {
  const tx = input.transaction;
  if (!tx) return unverified("TRADE_TRANSACTION_NOT_FOUND");
  if (tx.signature !== input.signature)
    return unverified("TRADE_SIGNATURE_MISMATCH");
  if (tx.slot !== input.providerSlot) return unverified("TRADE_SLOT_MISMATCH");
  if (!tx.succeeded) return unverified("TRADE_TRANSACTION_FAILED");
  if (tx.blockTime === null) return unverified("TRADE_BLOCK_TIME_MISSING");
  if (!tx.accountKeys.some((key) => key.pubkey === input.mint))
    return unverified("TRADE_MINT_NOT_IN_TRANSACTION_ACCOUNTS");
  if (!tx.logMessages.length)
    return unverified("TRADE_TRANSACTION_LOGS_MISSING");
  if (!tx.preTokenBalances || !tx.postTokenBalances)
    return unverified("TRADE_TOKEN_BALANCE_EVIDENCE_MISSING");

  const pump = decodePumpTradeEvents(tx.logMessages)
    .filter((event) => event.mint === input.mint)
    .map((event): Candidate => ({
      eventIndex: event.eventIndex,
      side: event.side,
      traderWallet: event.traderWallet,
      tokenAmountRaw: event.tokenAmountRaw,
      quoteAmountRaw: event.quoteAmountRaw,
      quoteMint:
        event.quoteMint === "11111111111111111111111111111111"
          ? "So11111111111111111111111111111111111111112"
          : event.quoteMint,
      timestampSeconds: event.timestampSeconds,
      venue: "PUMP_BONDING_CURVE" as const,
      source: "helius:finalized_getTransaction:pump-sdk-4.1.0",
      decoderVersion: event.instructionName,
    }));
  const pumpSwap: Candidate[] = decodePumpSwapTradeEvents(tx.logMessages).map(
    (event) => ({
      eventIndex: event.eventIndex,
      side: event.side,
      traderWallet: event.traderWallet,
      tokenAmountRaw: event.tokenAmountRaw,
      quoteAmountRaw: event.quoteAmountRaw,
      quoteMint: null,
      timestampSeconds: event.timestampSeconds,
      venue: "PUMPSWAP" as const,
      source: "helius:finalized_getTransaction:pump-swap-sdk-2.1.0",
      decoderVersion: event.instructionName,
      pool: event.pool,
    }),
  );
  const candidates: Candidate[] = [...pump, ...pumpSwap];
  if (candidates.length === 0)
    return unverified("NO_SUPPORTED_TRADE_EVENT_FOR_MINT");
  const venues = new Set(candidates.map((candidate) => candidate.venue));
  if (venues.size > 1) return unverified("MULTI_VENUE_TRADE_AMBIGUOUS");
  if (candidates[0]?.venue === "PUMPSWAP") {
    const pools = input.pumpSwapPools;
    if (!pools) return unverified("PUMPSWAP_POOL_STATE_UNVERIFIED");
    for (const candidate of pumpSwap) {
      if (!candidate.pool) return unverified("PUMPSWAP_EVENT_POOL_MISSING");
      const poolState = pools.get(candidate.pool);
      if (!poolState || poolState.baseMint !== input.mint)
        return unverified("PUMPSWAP_POOL_MINT_MISMATCH");
      if (poolState.quoteMint !== "So11111111111111111111111111111111111111112")
        return unverified("PUMPSWAP_QUOTE_ASSET_UNSUPPORTED");
      candidate.quoteMint = poolState.quoteMint;
    }
  }

  const grouped = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.venue}:${candidate.traderWallet}:${candidate.side}`;
    const group = grouped.get(key) ?? [];
    group.push(candidate);
    grouped.set(key, group);
  }
  const verified = [] as VerifiedTradeObservation[];
  for (const [key, group] of grouped) {
    const [, traderWallet, side] = key.split(":");
    if (!traderWallet || (side !== "BUY" && side !== "SELL"))
      return unverified("TRADE_ROLE_EVIDENCE_INVALID");
    if (
      !tx.accountKeys.some(
        (account) => account.pubkey === traderWallet && account.signer,
      )
    )
      return unverified("TRADE_USER_NOT_VERIFIED_SIGNER");
    const preAmount = tokenAmount(
      tx.preTokenBalances,
      input.mint,
      traderWallet,
    );
    const postAmount = tokenAmount(
      tx.postTokenBalances,
      input.mint,
      traderWallet,
    );
    if (preAmount === null || postAmount === null)
      return unverified("TRADE_USER_TOKEN_BALANCE_OWNER_UNVERIFIED");
    const eventAmount = group.reduce(
      (sum, event) => sum + BigInt(event.tokenAmountRaw),
      0n,
    );
    const delta = postAmount - preAmount;
    if (
      (side === "BUY" && delta !== eventAmount) ||
      (side === "SELL" && delta !== -eventAmount)
    )
      return unverified("TRADE_TOKEN_DELTA_MISMATCH");
    for (const event of group) {
      const eventMs = Number(event.timestampSeconds) * 1000;
      if (!Number.isSafeInteger(eventMs) || eventMs <= 0)
        return unverified("TRADE_EVENT_TIMESTAMP_INVALID");
      const timestampSkew = event.timestampSeconds - BigInt(tx.blockTime);
      if (
        (timestampSkew < 0n ? -timestampSkew : timestampSkew) >
        BigInt(MAX_EVENT_BLOCK_TIME_SKEW_SECONDS)
      )
        return unverified("TRADE_EVENT_BLOCK_TIME_MISMATCH");
      verified.push({
        eventIndex: event.eventIndex,
        mint: input.mint,
        signature: input.signature,
        slot: tx.slot,
        blockTimeUtc: tx.blockTime
          ? new Date(tx.blockTime * 1000).toISOString()
          : null,
        eventTimeUtc: new Date(eventMs).toISOString(),
        receivedAtUtc: input.receivedAtUtc,
        side: event.side,
        traderWallet: event.traderWallet,
        tokenAmountRaw: event.tokenAmountRaw,
        quoteAmountRaw: event.quoteAmountRaw,
        quoteMint: event.quoteMint ?? "",
        venue: event.venue,
        source: event.source,
        decoderVersion: event.decoderVersion,
        validationConfidenceBps: 10000,
      });
    }
  }
  return { status: "VERIFIED", reasonCode: null, observations: verified };
}

function tokenAmount(
  balances: NonNullable<WalletTransaction["preTokenBalances"]>,
  mint: string,
  owner: string,
): bigint | null {
  let found = false;
  let total = 0n;
  for (const balance of balances) {
    if (balance.mint !== mint) continue;
    if (balance.owner !== owner) continue;
    found = true;
    total += BigInt(balance.amountRaw);
  }
  // Missing owner rows mean a zero balance only when the provider returned a
  // valid balance array and the wallet is independently known as a signer.
  return found ? total : 0n;
}

function unverified(reasonCode: string): TradeTransactionValidation {
  return { status: "UNVERIFIED", reasonCode, observations: [] };
}
