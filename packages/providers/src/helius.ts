import { z } from "zod";
import { PubkeySchema } from "@sentinel/domain";

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
