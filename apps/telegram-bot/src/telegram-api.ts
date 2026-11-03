import { z } from "zod";

const TelegramIdSchema = z.union([
  z.number().int().safe(),
  z.string().regex(/^-?\d{1,20}$/),
]);
const TelegramResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().int().optional(),
  description: z.string().optional(),
  parameters: z
    .object({ retry_after: z.number().int().positive().optional() })
    .optional(),
});
const TelegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative().safe(),
  message: z
    .object({
      chat: z.object({ id: TelegramIdSchema }),
      from: z.object({ id: TelegramIdSchema }).nullable().optional(),
      text: z.string().optional(),
    })
    .optional(),
});
const TelegramWebhookInfoSchema = z.object({ url: z.string() });

export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;

export class TelegramApiError extends Error {
  readonly errorCode: string;
  readonly retryAfterSeconds: number | null;

  constructor(errorCode: string, retryAfterSeconds: number | null = null) {
    super(errorCode);
    this.errorCode = errorCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class TelegramApiClient {
  readonly #token: string;
  readonly #fetchImpl: typeof fetch;

  constructor(token: string, fetchImpl: typeof fetch = fetch) {
    this.#token = token;
    this.#fetchImpl = fetchImpl;
  }

  async getUpdates(
    offset: number | null,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    const result = await this.#call(
      "getUpdates",
      {
        ...(offset === null ? {} : { offset }),
        timeout: 25,
        allowed_updates: ["message"],
      },
      signal,
    );
    const parsed = z.array(TelegramUpdateSchema).safeParse(result);
    if (!parsed.success) throw new TelegramApiError("TELEGRAM_UPDATES_INVALID");
    return parsed.data;
  }

  async getWebhookInfo(signal?: AbortSignal): Promise<{ configured: boolean }> {
    const result = await this.#call("getWebhookInfo", {}, signal);
    const parsed = TelegramWebhookInfoSchema.safeParse(result);
    if (!parsed.success)
      throw new TelegramApiError("TELEGRAM_WEBHOOK_INFO_INVALID");
    return { configured: parsed.data.url.length > 0 };
  }

  async sendMessage(
    chatId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#call(
      "sendMessage",
      { chat_id: chatId, text: text.slice(0, 4096) },
      signal,
    );
  }

  async #call(
    method: string,
    body: Record<string, unknown>,
    parentSignal?: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetchImpl(
        `https://api.telegram.org/bot${this.#token}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: combineSignals(parentSignal, 30000),
        },
      );
    } catch (error) {
      if (parentSignal?.aborted) throw error;
      throw new TelegramApiError(
        error instanceof Error && error.name === "TimeoutError"
          ? "TELEGRAM_TIMEOUT"
          : "TELEGRAM_NETWORK_ERROR",
      );
    }
    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      throw new TelegramApiError("TELEGRAM_RESPONSE_INVALID");
    }
    const parsed = TelegramResponseSchema.safeParse(responseBody);
    if (!parsed.success)
      throw new TelegramApiError("TELEGRAM_RESPONSE_INVALID");
    if (!response.ok || !parsed.data.ok)
      throw new TelegramApiError(
        response.status === 429 || parsed.data.error_code === 429
          ? "TELEGRAM_RATE_LIMITED"
          : `TELEGRAM_HTTP_${response.status}`,
        parsed.data.parameters?.retry_after ?? null,
      );
    return parsed.data.result;
  }
}

function combineSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
