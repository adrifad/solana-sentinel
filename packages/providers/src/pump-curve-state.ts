import {
  AccountLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackMint,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  PUMP_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID,
  GLOBAL_PDA,
  PUMP_PROGRAM_ID,
  PumpSdk,
  bondingCurvePda,
} from "@pump-fun/pump-sdk";
import { MarketSnapshotSchema, PubkeySchema } from "@sentinel/domain";
import type { MarketSnapshot } from "@sentinel/domain";
import type {
  HeliusAccount,
  HeliusRequestPriority,
  HeliusRpcClient,
} from "./helius.ts";
import type { PumpCurveQuoteState } from "./quotes.ts";

export type PumpCurveStateResult =
  | {
      status: "SUPPORTED";
      state: PumpCurveQuoteState;
      mintProgramId: string;
      bondingCurveAddress: string;
      curveTokenAccount: string;
    }
  | {
      status: "MISSING" | "UNSUPPORTED" | "UNSAFE";
      reasonCode:
        | "STATE_MISSING"
        | "VENUE_UNSUPPORTED"
        | "STATE_UNSAFE"
        | "MALFORMED_PROVIDER_DATA"
        | "PROVIDER_BUDGET_EXHAUSTED"
        | "REQUEST_BUDGET_EXHAUSTED"
        | "REQUEST_WINDOW_BUDGET_EXHAUSTED"
        | "REQUEST_RATE_LIMITED"
        | "REQUEST_QUEUE_FULL"
        | "PROVIDER_UNAVAILABLE";
      retryAfterMs?: number;
    };

export type PumpCurveStateLoaderOptions = {
  helius: HeliusRpcClient;
  now?: () => number;
  onRawSnapshot?: (snapshot: {
    slot: number;
    accounts: Array<{
      address: string;
      owner: string;
      dataBase64: string;
      executable: boolean;
    } | null>;
  }) => void;
};

const LEGACY_TOKEN_ID = TOKEN_PROGRAM_ID.toBase58();
const TOKEN_2022_ID = TOKEN_2022_PROGRAM_ID.toBase58();
const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Loads one confirmed, same-slot Pump bonding curve snapshot. The method makes
 * one bounded Helius getMultipleAccounts request and never follows a quote-mint
 * route outside native SOL/WSOL.
 */
export class PumpCurveStateLoader {
  readonly #helius: HeliusRpcClient;
  readonly #now: () => number;
  readonly #onRawSnapshot: PumpCurveStateLoaderOptions["onRawSnapshot"];
  readonly #sdk = new PumpSdk();

  constructor(options: PumpCurveStateLoaderOptions) {
    this.#helius = options.helius;
    this.#now = options.now ?? Date.now;
    this.#onRawSnapshot = options.onRawSnapshot;
  }

  async load(
    mintInput: string,
    priority: HeliusRequestPriority = "CANDIDATE",
  ): Promise<PumpCurveStateResult> {
    const parsedMint = PubkeySchema.safeParse(mintInput);
    if (!parsedMint.success)
      return { status: "UNSAFE", reasonCode: "MALFORMED_PROVIDER_DATA" };
    try {
      const mint = new PublicKey(parsedMint.data);
      const curve = bondingCurvePda(mint);
      const legacyAta = getAssociatedTokenAddressSync(
        mint,
        curve,
        true,
        TOKEN_PROGRAM_ID,
      );
      const token2022Ata = getAssociatedTokenAddressSync(
        mint,
        curve,
        true,
        TOKEN_2022_PROGRAM_ID,
      );
      const addresses = [
        mint.toBase58(),
        curve.toBase58(),
        GLOBAL_PDA.toBase58(),
        PUMP_FEE_CONFIG_PDA.toBase58(),
        legacyAta.toBase58(),
        token2022Ata.toBase58(),
      ];
      const batch = await this.#helius.getMultipleAccounts(
        addresses,
        priority,
        mint.toBase58(),
      );
      this.#onRawSnapshot?.({
        slot: batch.slot,
        accounts: batch.accounts.map((account, index) =>
          account
            ? {
                address: addresses[index]!,
                owner: account.owner,
                dataBase64: account.dataBase64,
                executable: account.executable,
              }
            : null,
        ),
      });
      const [
        mintAccount,
        curveAccount,
        globalAccount,
        feeAccount,
        legacyToken,
        token2022Token,
      ] = batch.accounts;
      if (!mintAccount || !curveAccount || !globalAccount || !feeAccount)
        return { status: "MISSING", reasonCode: "STATE_MISSING" };

      const tokenProgramId = mintAccount.owner;
      if (
        tokenProgramId !== LEGACY_TOKEN_ID &&
        tokenProgramId !== TOKEN_2022_ID
      )
        return { status: "UNSUPPORTED", reasonCode: "VENUE_UNSUPPORTED" };
      if (
        curveAccount.owner !== PUMP_PROGRAM_ID.toBase58() ||
        globalAccount.owner !== PUMP_PROGRAM_ID.toBase58() ||
        feeAccount.owner !== PUMP_FEE_PROGRAM_ID.toBase58()
      )
        return { status: "UNSAFE", reasonCode: "STATE_UNSAFE" };
      const curveToken =
        tokenProgramId === LEGACY_TOKEN_ID ? legacyToken : token2022Token;
      if (!curveToken || curveToken.owner !== tokenProgramId)
        return { status: "MISSING", reasonCode: "STATE_MISSING" };

      const mintInfo = toAccountInfo(mintAccount);
      const curveInfo = toAccountInfo(curveAccount);
      const globalInfo = toAccountInfo(globalAccount);
      const feeInfo = toAccountInfo(feeAccount);
      const curveTokenInfo = toAccountInfo(curveToken);
      const rawMint = unpackMint(mint, mintInfo, new PublicKey(tokenProgramId));
      const tokenAccount = AccountLayout.decode(curveTokenInfo.data);
      if (
        tokenAccount.mint.toBase58() !== mint.toBase58() ||
        tokenAccount.owner.toBase58() !== curve.toBase58()
      )
        return { status: "UNSAFE", reasonCode: "STATE_UNSAFE" };

      const global = this.#sdk.decodeGlobal(globalInfo);
      const feeConfig = this.#sdk.decodeFeeConfig(feeInfo);
      const bondingCurve = this.#sdk.decodeBondingCurve(curveInfo);
      if (
        bondingCurve.complete ||
        bondingCurve.virtualTokenReserves.isZero() ||
        bondingCurve.virtualQuoteReserves.isZero()
      )
        return { status: "UNSUPPORTED", reasonCode: "VENUE_UNSUPPORTED" };
      const quoteMint = bondingCurve.quoteMint.toBase58();
      if (
        quoteMint !== "11111111111111111111111111111111" &&
        quoteMint !== WSOL_MINT
      )
        return { status: "UNSUPPORTED", reasonCode: "VENUE_UNSUPPORTED" };

      const observedAtUtc = new Date(this.#now()).toISOString();
      const snapshot: MarketSnapshot = MarketSnapshotSchema.parse({
        mint: mint.toBase58(),
        venue: "PUMP_BONDING_CURVE",
        slot: batch.slot,
        observedAtUtc,
        source: "HELIUS_CONFIRMED_GET_MULTIPLE_ACCOUNTS",
        stateRef: "pump_curve:" + curve.toBase58() + ":slot:" + batch.slot,
        baseReserveRaw: bondingCurve.realTokenReserves.toString(),
        quoteReserveRaw: bondingCurve.realQuoteReserves.toString(),
        liquidityQuoteRaw: bondingCurve.realQuoteReserves.toString(),
        confidenceBps: 10000,
      });
      const curveBaseTokenBalance = bn(
        bondingCurve.virtualTokenReserves,
        tokenAccount.amount.toString(),
      );
      return {
        status: "SUPPORTED",
        state: {
          global,
          feeConfig,
          bondingCurve,
          curveBaseTokenBalance,
          mintSupplyRaw: rawMint.supply.toString(),
          snapshot,
        },
        mintProgramId: tokenProgramId,
        bondingCurveAddress: curve.toBase58(),
        curveTokenAccount:
          tokenProgramId === LEGACY_TOKEN_ID
            ? legacyAta.toBase58()
            : token2022Ata.toBase58(),
      };
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (code.startsWith("REQUEST_"))
        return {
          status: "MISSING",
          reasonCode: code as
            | "REQUEST_BUDGET_EXHAUSTED"
            | "REQUEST_WINDOW_BUDGET_EXHAUSTED"
            | "REQUEST_RATE_LIMITED"
            | "REQUEST_QUEUE_FULL",
          retryAfterMs:
            error && typeof error === "object" && "retryAfterMs" in error
              ? Number(error.retryAfterMs)
              : 0,
        };
      return {
        status: "UNSAFE",
        reasonCode:
          code === "PROVIDER_BUDGET_EXHAUSTED"
            ? "PROVIDER_BUDGET_EXHAUSTED"
            : code === "RATE_LIMITED"
              ? "PROVIDER_UNAVAILABLE"
              : "MALFORMED_PROVIDER_DATA",
      };
    }
  }
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
