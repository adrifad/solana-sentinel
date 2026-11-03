import { randomUUID } from "node:crypto";
import {
  AccountLayout,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import type { RawMint } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  GLOBAL_CONFIG_PDA,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_SDK,
  PUMP_FEE_PROGRAM_ID,
  buyQuoteInput,
  canonicalPumpPoolPda,
  computeFeesBps,
  sellBaseInput,
} from "@pump-fun/pump-swap-sdk";
import type { FeeConfig, GlobalConfig, Pool } from "@pump-fun/pump-swap-sdk";
import {
  MarketSnapshotSchema,
  PubkeySchema,
  QuoteRequestSchema,
  QuoteResultSchema,
} from "@sentinel/domain";
import type {
  MarketSnapshot,
  QuoteRequest,
  QuoteResult,
} from "@sentinel/domain";
import type {
  HeliusAccount,
  HeliusRequestPriority,
  HeliusRpcClient,
} from "./helius.ts";

const TOKEN_PROGRAM_IDS = new Set([
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
]);
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

export type PumpSwapQuoteState = {
  pool: Pool;
  globalConfig: GlobalConfig;
  feeConfig: FeeConfig;
  baseMintAccount: RawMint;
  baseReserve: { toString(): string; constructor: unknown };
  quoteReserve: { toString(): string; constructor: unknown };
  mintSupplyRaw: string;
  snapshot: MarketSnapshot;
};

export type PumpSwapStateResult =
  | {
      status: "SUPPORTED";
      state: PumpSwapQuoteState;
      poolAddress: string;
      slotSkew: number;
    }
  | {
      status: "MISSING" | "UNSUPPORTED" | "UNSAFE";
      reasonCode:
        | "STATE_MISSING"
        | "VENUE_UNSUPPORTED"
        | "STATE_UNSAFE"
        | "MALFORMED_PROVIDER_DATA"
        | "PROVIDER_BUDGET_EXHAUSTED"
        | "PROVIDER_UNAVAILABLE"
        | "STALE_SNAPSHOT";
    };

export type PumpSwapStateLoaderOptions = {
  helius: HeliusRpcClient;
  maxSlotSkew?: number;
  now?: () => number;
  onRawSnapshot?: (snapshot: {
    slot: number;
    poolAddress: string;
    accounts: Array<{
      address: string;
      owner: string;
      dataBase64: string;
      executable: boolean;
    } | null>;
  }) => void;
};

export class PumpSwapStateLoader {
  readonly #helius: HeliusRpcClient;
  readonly #maxSlotSkew: number;
  readonly #now: () => number;
  readonly #onRawSnapshot: PumpSwapStateLoaderOptions["onRawSnapshot"];

  constructor(options: PumpSwapStateLoaderOptions) {
    this.#helius = options.helius;
    this.#maxSlotSkew = options.maxSlotSkew ?? 32;
    this.#now = options.now ?? Date.now;
    this.#onRawSnapshot = options.onRawSnapshot;
  }

  async load(
    mintInput: string,
    priority: HeliusRequestPriority = "CANDIDATE",
  ): Promise<PumpSwapStateResult> {
    const parsedMint = PubkeySchema.safeParse(mintInput);
    if (!parsedMint.success)
      return { status: "UNSAFE", reasonCode: "MALFORMED_PROVIDER_DATA" };
    try {
      const mint = new PublicKey(parsedMint.data);
      const poolAddress = canonicalPumpPoolPda(mint, WSOL_MINT);
      const firstAddresses = [
        poolAddress.toBase58(),
        GLOBAL_CONFIG_PDA.toBase58(),
        PUMP_AMM_FEE_CONFIG_PDA.toBase58(),
        mint.toBase58(),
      ];
      const first = await this.#helius.getMultipleAccounts(
        firstAddresses,
        priority,
        mint.toBase58(),
      );
      const [poolAccount, globalAccount, feeAccount, mintAccount] =
        first.accounts;
      if (!poolAccount || !globalAccount || !feeAccount || !mintAccount)
        return { status: "MISSING", reasonCode: "STATE_MISSING" };
      if (
        poolAccount.owner !== PUMP_AMM_PROGRAM_ID.toBase58() ||
        globalAccount.owner !== PUMP_AMM_PROGRAM_ID.toBase58() ||
        feeAccount.owner !== PUMP_FEE_PROGRAM_ID.toBase58() ||
        !TOKEN_PROGRAM_IDS.has(mintAccount.owner)
      )
        return { status: "UNSAFE", reasonCode: "STATE_UNSAFE" };

      const pool = PUMP_AMM_SDK.decodePool(toAccountInfo(poolAccount));
      const globalConfig = PUMP_AMM_SDK.decodeGlobalConfig(
        toAccountInfo(globalAccount),
      );
      const feeConfig = PUMP_AMM_SDK.decodeFeeConfig(toAccountInfo(feeAccount));
      if (
        !pool.baseMint.equals(mint) ||
        !pool.quoteMint.equals(WSOL_MINT) ||
        poolAddress.toBase58() !==
          canonicalPumpPoolPda(mint, pool.quoteMint).toBase58()
      )
        return { status: "UNSAFE", reasonCode: "STATE_UNSAFE" };
      if (pool.isCashbackCoin)
        return { status: "UNSUPPORTED", reasonCode: "VENUE_UNSUPPORTED" };

      const secondAddresses = [
        pool.poolBaseTokenAccount.toBase58(),
        pool.poolQuoteTokenAccount.toBase58(),
      ];
      const second = await this.#helius.getMultipleAccounts(
        secondAddresses,
        priority,
        mint.toBase58(),
      );
      const [baseVault, quoteVault] = second.accounts;
      if (!baseVault || !quoteVault)
        return { status: "MISSING", reasonCode: "STATE_MISSING" };
      const slotSkew = Math.abs(second.slot - first.slot);
      if (second.slot < first.slot || slotSkew > this.#maxSlotSkew)
        return { status: "UNSAFE", reasonCode: "STALE_SNAPSHOT" };
      if (
        baseVault.owner !== mintAccount.owner ||
        quoteVault.owner !== TOKEN_PROGRAM_ID.toBase58()
      )
        return { status: "UNSAFE", reasonCode: "STATE_UNSAFE" };
      const baseVaultInfo = toAccountInfo(baseVault);
      const quoteVaultInfo = toAccountInfo(quoteVault);
      const baseToken = AccountLayout.decode(baseVaultInfo.data);
      const quoteToken = AccountLayout.decode(quoteVaultInfo.data);
      if (
        !baseToken.mint.equals(mint) ||
        !baseToken.owner.equals(poolAddress) ||
        !quoteToken.mint.equals(WSOL_MINT) ||
        !quoteToken.owner.equals(poolAddress)
      )
        return { status: "UNSAFE", reasonCode: "STATE_UNSAFE" };

      const mintInfo = toAccountInfo(mintAccount);
      const mintState = MintLayout.decode(mintInfo.data);
      const baseReserve = bn(pool.lpSupply, baseToken.amount.toString());
      const quoteReserve = bn(pool.lpSupply, quoteToken.amount.toString());
      const realQuoteReserve =
        BigInt(quoteReserve.toString()) -
        BigInt(pool.protocolFees.toString()) -
        BigInt(pool.creatorFees.toString());
      const effectiveQuoteReserve =
        BigInt(quoteReserve.toString()) +
        BigInt(pool.virtualQuoteReserves.toString());
      if (
        BigInt(baseReserve.toString()) <= 0n ||
        realQuoteReserve <= 0n ||
        effectiveQuoteReserve <= 0n
      )
        return { status: "UNSAFE", reasonCode: "STATE_UNSAFE" };

      const observedAtUtc = new Date(this.#now()).toISOString();
      const snapshot: MarketSnapshot = MarketSnapshotSchema.parse({
        mint: mint.toBase58(),
        venue: "PUMPSWAP",
        slot: second.slot,
        observedAtUtc,
        source: "HELIUS_CONFIRMED_PUMPSWAP_STATE",
        stateRef:
          "pumpswap_pool:" + poolAddress.toBase58() + ":slot:" + second.slot,
        baseReserveRaw: baseReserve.toString(),
        quoteReserveRaw: effectiveQuoteReserve.toString(),
        liquidityQuoteRaw: realQuoteReserve.toString(),
        confidenceBps: 10000,
      });
      const accounts = [
        poolAccount,
        globalAccount,
        feeAccount,
        mintAccount,
        baseVault,
        quoteVault,
      ];
      this.#onRawSnapshot?.({
        slot: second.slot,
        poolAddress: poolAddress.toBase58(),
        accounts: accounts.map((account, index) => {
          if (!account) return null;
          const address =
            index === 0
              ? firstAddresses[0]!
              : index === 1
                ? firstAddresses[1]!
                : index === 2
                  ? firstAddresses[2]!
                  : index === 3
                    ? firstAddresses[3]!
                    : secondAddresses[index - 4]!;
          return {
            address,
            owner: account.owner,
            dataBase64: account.dataBase64,
            executable: account.executable,
          };
        }),
      });
      return {
        status: "SUPPORTED",
        state: {
          pool,
          globalConfig,
          feeConfig,
          baseMintAccount: mintState,
          baseReserve,
          quoteReserve,
          mintSupplyRaw: mintState.supply.toString(),
          snapshot,
        },
        poolAddress: poolAddress.toBase58(),
        slotSkew,
      };
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      return {
        status: "UNSAFE",
        reasonCode:
          code === "REQUEST_BUDGET_EXHAUSTED"
            ? "PROVIDER_BUDGET_EXHAUSTED"
            : code === "RATE_LIMITED" || code === "PROVIDER_UNAVAILABLE"
              ? "PROVIDER_UNAVAILABLE"
              : "MALFORMED_PROVIDER_DATA",
      };
    }
  }
}

export class PumpSwapQuoteEngine {
  quote(requestInput: QuoteRequest, state: PumpSwapQuoteState): QuoteResult {
    const request = QuoteRequestSchema.parse(requestInput);
    const freshnessMs = Math.max(
      0,
      Date.parse(request.requestedAtUtc) -
        Date.parse(state.snapshot.observedAtUtc),
    );
    const base = quoteResultBase(request, state.snapshot, freshnessMs);
    const requestQuoteMint =
      request.direction === "BUY" ? request.inputMint : request.outputMint;
    if (
      state.snapshot.mint !== request.mint ||
      !state.pool.baseMint.equals(new PublicKey(request.mint)) ||
      !state.pool.quoteMint.equals(WSOL_MINT) ||
      requestQuoteMint !== WSOL_MINT.toBase58()
    )
      return QuoteResultSchema.parse({
        ...base,
        validationStatus: "FAIL",
        failureReason: "MALFORMED_PROVIDER_DATA",
      });
    if (state.snapshot.venue !== "PUMPSWAP")
      return QuoteResultSchema.parse({
        ...base,
        venue: null,
        validationStatus: "UNKNOWN",
        failureReason: "VENUE_UNSUPPORTED",
      });
    if (freshnessMs > request.maxAgeMs)
      return QuoteResultSchema.parse({
        ...base,
        validationStatus: "FAIL",
        failureReason: "STALE_SNAPSHOT",
      });
    if (
      Date.parse(state.snapshot.observedAtUtc) >
      Date.parse(request.requestedAtUtc)
    )
      return QuoteResultSchema.parse({
        ...base,
        validationStatus: "UNKNOWN",
        failureReason: "STATE_UNSAFE",
      });
    const input = bn(state.pool.lpSupply, request.exactInputAmountRaw);
    const feeBucketsTotal = bn(
      state.pool.lpSupply,
      (
        BigInt(state.pool.protocolFees.toString()) +
        BigInt(state.pool.creatorFees.toString())
      ).toString(),
    );
    const common = {
      baseReserve: state.baseReserve,
      quoteReserve: state.quoteReserve,
      virtualQuoteReserves: state.pool.virtualQuoteReserves,
      globalConfig: state.globalConfig,
      baseMintAccount: state.baseMintAccount,
      baseMint: state.pool.baseMint,
      coinCreator: state.pool.coinCreator,
      creator: state.pool.creator,
      feeConfig: state.feeConfig,
      quoteMint: state.pool.quoteMint,
      isMayhemMode: state.pool.isMayhemMode,
      creatorFeeBps: state.pool.creatorFeeBps,
    };
    try {
      let outputRaw: string;
      let feeAmountRaw: string;
      let feeBreakdownRaw: NonNullable<QuoteResult["feeBreakdownRaw"]> | null;
      if (request.direction === "BUY") {
        const result = buyQuoteInput({
          quote: input,
          slippage: 0,
          ...common,
        });
        outputRaw = result.base.toString();
        feeAmountRaw = (
          BigInt(request.exactInputAmountRaw) -
          BigInt(result.internalQuoteWithoutFees.toString())
        ).toString();
        feeBreakdownRaw = decomposeFee(
          feeAmountRaw,
          state,
          bn(state.pool.lpSupply, result.internalQuoteWithoutFees.toString()),
        );
      } else {
        const result = sellBaseInput({
          base: input,
          slippage: 0,
          feeBucketsTotal,
          ...common,
        });
        outputRaw = result.uiQuote.toString();
        feeAmountRaw = (
          BigInt(result.internalQuoteAmountOut.toString()) -
          BigInt(result.uiQuote.toString())
        ).toString();
        feeBreakdownRaw = decomposeFee(
          feeAmountRaw,
          state,
          bn(state.pool.lpSupply, result.internalQuoteAmountOut.toString()),
        );
      }
      if (!feeBreakdownRaw)
        return QuoteResultSchema.parse({
          ...base,
          validationStatus: "UNKNOWN",
          failureReason: "MALFORMED_PROVIDER_DATA",
        });
      const output = BigInt(outputRaw);
      if (output <= 0n)
        return QuoteResultSchema.parse({
          ...base,
          validationStatus: "FAIL",
          failureReason: "INSUFFICIENT_LIQUIDITY",
        });
      const baseReserve = BigInt(state.baseReserve.toString());
      const effectiveQuoteReserve =
        BigInt(state.quoteReserve.toString()) +
        BigInt(state.pool.virtualQuoteReserves.toString());
      const inputRaw = BigInt(request.exactInputAmountRaw);
      const realQuoteReserve =
        BigInt(state.quoteReserve.toString()) -
        BigInt(state.pool.protocolFees.toString()) -
        BigInt(state.pool.creatorFees.toString());
      if (
        (request.direction === "BUY" && output >= baseReserve) ||
        (request.direction === "SELL" &&
          (inputRaw > baseReserve || output > realQuoteReserve))
      )
        return QuoteResultSchema.parse({
          ...base,
          validationStatus: "FAIL",
          failureReason: "INSUFFICIENT_LIQUIDITY",
        });
      const idealOutput =
        request.direction === "BUY"
          ? (inputRaw * baseReserve) / effectiveQuoteReserve
          : (inputRaw * effectiveQuoteReserve) / baseReserve;
      const priceImpactBps =
        idealOutput <= output || idealOutput === 0n
          ? 0
          : Number(((idealOutput - output) * 10000n) / idealOutput);
      return QuoteResultSchema.parse({
        ...base,
        expectedOutputAmountRaw: outputRaw,
        feeAmountRaw,
        feeBreakdownRaw,
        feeMint:
          request.direction === "BUY" ? request.inputMint : request.outputMint,
        feeModel: "PUMPSWAP_OFFICIAL_SDK_LP_PROTOCOL_CREATOR_DECOMPOSED",
        priceImpactBps,
        liquidityQuoteRaw: realQuoteReserve.toString(),
        validationStatus: "PASS",
        failureReason: null,
        provenance: {
          provider: state.snapshot.source,
          stateRef: state.snapshot.stateRef,
          quoteSdk: "@pump-fun/pump-swap-sdk@2.1.0",
          poolAddress: state.snapshot.stateRef.split(":")[1],
          feeBucketsExcludedFromExitLiquidity: true,
          virtualQuoteReservesIncluded: true,
        },
      });
    } catch {
      return QuoteResultSchema.parse({
        ...base,
        validationStatus: "FAIL",
        failureReason: "INSUFFICIENT_LIQUIDITY",
      });
    }
  }
}

function decomposeFee(
  totalFeeRaw: string,
  state: PumpSwapQuoteState,
  amount: { toString(): string; constructor: unknown },
) {
  const fees = computeFeesBps({
    globalConfig: state.globalConfig,
    feeConfig: state.feeConfig,
    creator: state.pool.creator,
    baseMintSupply: bn(
      amount,
      state.pool.isMayhemMode ? state.mintSupplyRaw : "1000000000000000",
    ),
    baseMint: state.pool.baseMint,
    baseReserve: state.baseReserve,
    quoteReserve: state.quoteReserve,
    quoteMint: state.pool.quoteMint,
    isMayhemMode: state.pool.isMayhemMode,
    creatorFeeBps: state.pool.creatorFeeBps,
  });
  const amountBig = BigInt(amount.toString());
  const lp = ceilBps(amountBig, BigInt(fees.lpFeeBps.toString()));
  const protocol = ceilBps(amountBig, BigInt(fees.protocolFeeBps.toString()));
  const creator = ceilBps(amountBig, BigInt(fees.creatorFeeBps.toString()));
  const observed = BigInt(totalFeeRaw);
  const sum = lp + protocol + creator;
  const adjust = observed - sum;
  if (adjust < 0n) return null;
  return {
    protocol: protocol.toString(),
    creator: creator.toString(),
    liquidityProvider: lp.toString(),
    unallocated: adjust.toString(),
  };
}

function quoteResultBase(
  request: QuoteRequest,
  snapshot: MarketSnapshot,
  freshnessMs: number,
) {
  return {
    id:
      "pumpswap:" +
      randomUUID() +
      ":" +
      snapshot.stateRef +
      ":" +
      request.direction +
      ":" +
      request.exactInputAmountRaw,
    mint: request.mint,
    direction: request.direction,
    exactInputAmountRaw: request.exactInputAmountRaw,
    expectedOutputAmountRaw: null,
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    venue: snapshot.venue,
    source: "PUMPSWAP_OFFICIAL_SDK",
    snapshotSlot: snapshot.slot,
    snapshotAtUtc: snapshot.observedAtUtc,
    feeAmountRaw: null,
    feeMint: null,
    feeModel: "UNKNOWN",
    priceImpactBps: null,
    liquidityQuoteRaw: snapshot.liquidityQuoteRaw,
    freshnessMs,
    validationStatus: "UNKNOWN" as const,
    failureReason: null,
    evidenceRefs: [snapshot.stateRef],
    provenance: { provider: snapshot.source },
    observedAtUtc: new Date().toISOString(),
  };
}

function toAccountInfo(account: NonNullable<HeliusAccount>) {
  return {
    data: Buffer.from(account.dataBase64, "base64"),
    executable: account.executable,
    lamports: 0,
    owner: new PublicKey(account.owner),
    rentEpoch: 0,
  };
}

function bn(template: { constructor: unknown }, value: string) {
  const Constructor = template.constructor as new (
    value: string,
    base?: number,
  ) => typeof template;
  return new Constructor(value, 10);
}

function ceilBps(amount: bigint, bps: bigint): bigint {
  if (amount === 0n || bps === 0n) return 0n;
  return (amount * bps + 9999n) / 10000n;
}
