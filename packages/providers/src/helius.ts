import { z } from "zod";
import { PubkeySchema, base58DecodedLength } from "@sentinel/domain";

const RpcEnvelope = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.number(), z.string()]),
    result: z.unknown().optional(),
    error: z.object({ code: z.number(), message: z.string() }).optional(),
  })
  .passthrough();
const AccountInfoResult = z
  .object({
    context: z
      .object({ slot: z.number().int().nonnegative().safe() })
      .passthrough(),
    value: z
      .object({
        owner: PubkeySchema,
        data: z.tuple([z.string(), z.literal("base64")]),
        executable: z.boolean(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();
const MultipleAccountInfoResult = z
  .object({
    context: z.object({ slot: z.number().int().nonnegative().safe() }),
    value: z.array(
      z
        .object({
          owner: PubkeySchema,
          data: z.tuple([z.string(), z.literal("base64")]),
          executable: z.boolean(),
        })
        .passthrough()
        .nullable(),
    ),
  })
  .passthrough();
const SignatureSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/)
  .refine((signature) => base58DecodedLength(signature) === 64);
const SignaturePageItem = z
  .object({
    signature: SignatureSchema,
    slot: z.number().int().nonnegative().safe(),
    err: z.unknown(),
    blockTime: z.number().int().nonnegative().safe().nullable(),
  })
  .passthrough();
const ParsedAccountKey = z.union([
  PubkeySchema,
  z
    .object({
      pubkey: PubkeySchema,
      signer: z.boolean(),
      writable: z.boolean().optional(),
      source: z.string().optional(),
    })
    .passthrough(),
]);
const ParsedInstruction = z
  .object({
    programId: PubkeySchema,
    program: z.string().optional(),
    accounts: z.array(z.unknown()).optional(),
    data: z.string().optional(),
    parsed: z.unknown().optional(),
  })
  .passthrough();
const TokenBalance = z
  .object({
    accountIndex: z.number().int().nonnegative(),
    mint: PubkeySchema,
    owner: PubkeySchema.optional(),
    programId: PubkeySchema.optional(),
    uiTokenAmount: z.object({
      amount: z.string().regex(/^\d+$/),
      decimals: z.number().int().min(0).max(255),
    }),
  })
  .passthrough();
const TransactionResult = z
  .object({
    slot: z.number().int().nonnegative().safe(),
    blockTime: z.number().int().nonnegative().safe().nullable(),
    transaction: z
      .object({
        signatures: z.array(SignatureSchema),
        message: z
          .object({
            accountKeys: z.array(ParsedAccountKey),
            instructions: z.array(ParsedInstruction),
          })
          .passthrough(),
      })
      .passthrough(),
    meta: z
      .object({
        err: z.unknown(),
        fee: z.number().int().nonnegative().safe(),
        logMessages: z.array(z.string()).nullable().optional(),
        preBalances: z.array(z.number().int().nonnegative().safe()).optional(),
        postBalances: z.array(z.number().int().nonnegative().safe()).optional(),
        preTokenBalances: z.array(TokenBalance).optional(),
        postTokenBalances: z.array(TokenBalance).optional(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();
const TokenSupplyResult = z
  .object({
    context: z.object({ slot: z.number().int().nonnegative().safe() }),
    value: z.object({
      amount: z.string().regex(/^\d+$/),
      decimals: z.number().int().min(0).max(255),
      uiAmountString: z.string().optional(),
    }),
  })
  .passthrough();
const LargestAccountsResult = z
  .object({
    context: z.object({ slot: z.number().int().nonnegative().safe() }),
    value: z.array(
      z.object({
        address: PubkeySchema,
        amount: z.string().regex(/^\d+$/),
        decimals: z.number().int().min(0).max(255).optional(),
      }),
    ),
  })
  .passthrough();

export type WalletSignature = {
  signature: string;
  slot: number;
  succeeded: boolean;
  blockTime: number | null;
};
export type WalletTransaction = {
  signature: string;
  slot: number;
  blockTime: number | null;
  succeeded: boolean;
  feeLamports: number;
  accountKeys: Array<{
    pubkey: string;
    signer: boolean;
    writable: boolean | null;
  }>;
  instructions: Array<{
    programId: string;
    program: string | null;
    parsed: unknown;
    data: string | null;
    accounts: unknown[];
  }>;
  logMessages: string[];
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: Array<{
    accountIndex: number;
    mint: string;
    owner: string | null;
    amountRaw: string;
  }>;
  postTokenBalances?: Array<{
    accountIndex: number;
    mint: string;
    owner: string | null;
    amountRaw: string;
  }>;
};

export type HeliusOptions = {
  apiKey: string;
  requestTimeoutMs: number;
  maxRequestsPerSecond?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  consumeRequestBudget?: () => boolean;
};
export type HeliusAccount = {
  slot: number;
  owner: string;
  dataBase64: string;
  encoding: string;
  executable: boolean;
} | null;
export type HeliusHealth = {
  ok: boolean;
  checkedAtUtc: string;
  errorCode: string | null;
  genesisHash?: string;
};

export class HeliusRpcClient {
  readonly #opts: HeliusOptions;
  #failureCount = 0;
  #circuitOpenedAt = 0;
  #lastRequestAt = 0;
  #requestGate: Promise<void> = Promise.resolve();

  constructor(options: HeliusOptions) {
    if (!options.apiKey.trim()) throw new Error("HELIUS_API_KEY is required");
    this.#opts = options;
  }

  async getHealth(): Promise<HeliusHealth> {
    const checkedAtUtc = new Date(
      this.#opts.now?.() ?? Date.now(),
    ).toISOString();
    try {
      const rpcHealth = await this.#rpc("getHealth", []);
      if (rpcHealth !== "ok") throw new ProviderFailure("RPC_UNHEALTHY");
      const genesis = await this.#rpc("getGenesisHash", []);
      if (
        typeof genesis !== "string" ||
        genesis.length < 32 ||
        genesis.length > 64
      )
        throw new ProviderFailure("MALFORMED_RESPONSE");
      return { ok: true, checkedAtUtc, errorCode: null, genesisHash: genesis };
    } catch (error) {
      return {
        ok: false,
        checkedAtUtc,
        errorCode:
          error instanceof ProviderFailure
            ? error.code
            : "PROVIDER_UNAVAILABLE",
      };
    }
  }

  async getAccountInfo(
    address: string,
  ): Promise<{ slot: number; account: HeliusAccount }> {
    if (!PubkeySchema.safeParse(address).success)
      throw new ProviderFailure("INVALID_PUBKEY");
    const parsed = await this.#rpc("getAccountInfo", [
      address,
      { commitment: "confirmed", encoding: "base64" },
    ]);
    const result = AccountInfoResult.safeParse(parsed);
    if (!result.success) throw new ProviderFailure("MALFORMED_RESPONSE");
    const { context, value } = result.data;
    return {
      slot: context.slot,
      account: value
        ? {
            slot: context.slot,
            owner: value.owner,
            dataBase64: value.data[0],
            encoding: value.data[1],
            executable: value.executable,
          }
        : null,
    };
  }

  async getMultipleAccounts(addresses: string[]): Promise<{
    slot: number;
    accounts: HeliusAccount[];
  }> {
    if (addresses.length < 1 || addresses.length > 100)
      throw new ProviderFailure("INVALID_BATCH_SIZE");
    if (addresses.some((address) => !PubkeySchema.safeParse(address).success))
      throw new ProviderFailure("INVALID_PUBKEY");
    const parsed = MultipleAccountInfoResult.safeParse(
      await this.#rpc("getMultipleAccounts", [
        addresses,
        { commitment: "confirmed", encoding: "base64" },
      ]),
    );
    if (!parsed.success || parsed.data.value.length !== addresses.length)
      throw new ProviderFailure("MALFORMED_RESPONSE");
    return {
      slot: parsed.data.context.slot,
      accounts: parsed.data.value.map((value) =>
        value
          ? {
              slot: parsed.data.context.slot,
              owner: value.owner,
              dataBase64: value.data[0],
              encoding: value.data[1],
              executable: value.executable,
            }
          : null,
      ),
    };
  }

  async getBlockTime(slot: number): Promise<string | null> {
    if (!Number.isSafeInteger(slot) || slot < 0)
      throw new ProviderFailure("INVALID_SLOT");
    const result = await this.#rpc("getBlockTime", [slot]);
    if (result === null) return null;
    if (
      typeof result !== "number" ||
      !Number.isSafeInteger(result) ||
      result < 0
    )
      throw new ProviderFailure("MALFORMED_RESPONSE");
    return new Date(result * 1000).toISOString();
  }

  async getSignaturesForAddress(
    address: string,
    options: { limit: number; before?: string },
  ): Promise<WalletSignature[]> {
    if (!PubkeySchema.safeParse(address).success)
      throw new ProviderFailure("INVALID_PUBKEY");
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 1000
    )
      throw new ProviderFailure("INVALID_PAGE_SIZE");
    if (options.before && !SignatureSchema.safeParse(options.before).success)
      throw new ProviderFailure("INVALID_SIGNATURE");
    const result = await this.#rpc("getSignaturesForAddress", [
      address,
      {
        commitment: "finalized",
        limit: options.limit,
        ...(options.before ? { before: options.before } : {}),
      },
    ]);
    const parsed = z
      .array(SignaturePageItem)
      .max(options.limit)
      .safeParse(result);
    if (!parsed.success) throw new ProviderFailure("MALFORMED_RESPONSE");
    return parsed.data.map((item) => ({
      signature: item.signature,
      slot: item.slot,
      succeeded: item.err === null,
      blockTime: item.blockTime,
    }));
  }

  async getTransaction(signature: string): Promise<WalletTransaction | null> {
    if (!SignatureSchema.safeParse(signature).success)
      throw new ProviderFailure("INVALID_SIGNATURE");
    const result = await this.#rpc("getTransaction", [
      signature,
      {
        commitment: "finalized",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
      },
    ]);
    if (result === null) return null;
    const parsed = TransactionResult.safeParse(result);
    if (!parsed.success) throw new ProviderFailure("MALFORMED_RESPONSE");
    const transaction = parsed.data;
    const meta = transaction.meta;
    if (!meta || transaction.transaction.signatures[0] !== signature)
      throw new ProviderFailure("MALFORMED_RESPONSE");
    const key = transaction.transaction.message.accountKeys.map((account) =>
      typeof account === "string"
        ? { pubkey: account, signer: false, writable: null }
        : {
            pubkey: account.pubkey,
            signer: account.signer,
            writable: account.writable ?? null,
          },
    );
    return {
      signature,
      slot: transaction.slot,
      blockTime: transaction.blockTime,
      succeeded: meta.err === null,
      feeLamports: meta.fee,
      accountKeys: key,
      instructions: transaction.transaction.message.instructions.map(
        (instruction) => ({
          programId: instruction.programId,
          program: instruction.program ?? null,
          parsed: instruction.parsed ?? null,
          data: instruction.data ?? null,
          accounts: instruction.accounts ?? [],
        }),
      ),
      logMessages: meta.logMessages ?? [],
      preBalances: meta.preBalances ?? [],
      postBalances: meta.postBalances ?? [],
      preTokenBalances: (meta.preTokenBalances ?? []).map((balance) => ({
        accountIndex: balance.accountIndex,
        mint: balance.mint,
        owner: balance.owner ?? null,
        amountRaw: balance.uiTokenAmount.amount,
      })),
      postTokenBalances: (meta.postTokenBalances ?? []).map((balance) => ({
        accountIndex: balance.accountIndex,
        mint: balance.mint,
        owner: balance.owner ?? null,
        amountRaw: balance.uiTokenAmount.amount,
      })),
    };
  }

  async getTokenSupply(mint: string): Promise<{
    slot: number;
    amountRaw: string;
    decimals: number;
  }> {
    if (!PubkeySchema.safeParse(mint).success)
      throw new ProviderFailure("INVALID_PUBKEY");
    const parsed = TokenSupplyResult.safeParse(
      await this.#rpc("getTokenSupply", [mint, { commitment: "confirmed" }]),
    );
    if (!parsed.success) throw new ProviderFailure("MALFORMED_RESPONSE");
    return {
      slot: parsed.data.context.slot,
      amountRaw: parsed.data.value.amount,
      decimals: parsed.data.value.decimals,
    };
  }

  async getTokenLargestAccounts(mint: string): Promise<{
    slot: number;
    accounts: Array<{ address: string; amountRaw: string }>;
  }> {
    if (!PubkeySchema.safeParse(mint).success)
      throw new ProviderFailure("INVALID_PUBKEY");
    const parsed = LargestAccountsResult.safeParse(
      await this.#rpc("getTokenLargestAccounts", [
        mint,
        { commitment: "confirmed" },
      ]),
    );
    if (!parsed.success) throw new ProviderFailure("MALFORMED_RESPONSE");
    return {
      slot: parsed.data.context.slot,
      accounts: parsed.data.value.map((account) => ({
        address: account.address,
        amountRaw: account.amount,
      })),
    };
  }

  async #rpc(method: string, params: unknown[]): Promise<unknown> {
    const now = this.#opts.now ?? Date.now;
    if (this.#failureCount >= 5 && now() - this.#circuitOpenedAt < 15000)
      throw new ProviderFailure("CIRCUIT_OPEN");
    const url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(this.#opts.apiKey)}`;
    const fetchImpl = this.#opts.fetchImpl ?? fetch;
    let lastFailure: ProviderFailure = new ProviderFailure(
      "PROVIDER_UNAVAILABLE",
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.#pace();
      if (this.#opts.consumeRequestBudget && !this.#opts.consumeRequestBudget())
        throw new ProviderFailure("REQUEST_BUDGET_EXHAUSTED");
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.#opts.requestTimeoutMs,
      );
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: controller.signal,
        });
        if (response.status === 429) throw new ProviderFailure("RATE_LIMITED");
        if (response.status >= 500)
          throw new ProviderFailure("PROVIDER_UNAVAILABLE");
        if (!response.ok) throw new ProviderFailure("RPC_REJECTED");
        const body: unknown = await response.json();
        const envelope = RpcEnvelope.safeParse(body);
        if (!envelope.success) throw new ProviderFailure("MALFORMED_RESPONSE");
        if (envelope.data.error) throw new ProviderFailure("RPC_REJECTED");
        if (!("result" in envelope.data))
          throw new ProviderFailure("MALFORMED_RESPONSE");
        this.#failureCount = 0;
        return envelope.data.result;
      } catch (error) {
        lastFailure =
          error instanceof ProviderFailure
            ? error
            : new ProviderFailure(
                error instanceof Error && error.name === "AbortError"
                  ? "TIMEOUT"
                  : "PROVIDER_UNAVAILABLE",
              );
        if (
          lastFailure.code === "RPC_REJECTED" ||
          lastFailure.code === "MALFORMED_RESPONSE" ||
          lastFailure.code === "REQUEST_BUDGET_EXHAUSTED"
        )
          break;
        if (attempt < 2)
          await new Promise((resolve) =>
            setTimeout(resolve, 100 * 2 ** attempt),
          );
      } finally {
        clearTimeout(timeout);
      }
    }
    this.#failureCount += 1;
    if (this.#failureCount >= 5) this.#circuitOpenedAt = now();
    throw lastFailure;
  }

  async #pace(): Promise<void> {
    let release = (): void => undefined;
    const previous = this.#requestGate;
    this.#requestGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const intervalMs = 1000 / (this.#opts.maxRequestsPerSecond ?? 5);
      const waitMs = Math.max(
        0,
        intervalMs - (Date.now() - this.#lastRequestAt),
      );
      if (waitMs > 0)
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.#lastRequestAt = Date.now();
    } finally {
      release();
    }
  }
}

export class ProviderFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ProviderFailure";
    this.code = code;
  }
}
