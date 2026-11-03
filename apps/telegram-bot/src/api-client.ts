import { z } from "zod";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export class SentinelApiClient {
  readonly #baseUrl: string;
  readonly #fetchImpl: typeof fetch;

  constructor(baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.#baseUrl = baseUrl;
    this.#fetchImpl = fetchImpl;
  }

  async get(
    path: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const url = new URL(path, `${this.#baseUrl}/`);
    if (url.origin !== new URL(this.#baseUrl).origin)
      throw new Error("INTERNAL_API_PATH_INVALID");
    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
      });
    } catch {
      throw new Error("INTERNAL_API_UNAVAILABLE");
    }
    if (!response.ok) throw new Error(`INTERNAL_API_HTTP_${response.status}`);
    const parsed = JsonObjectSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("INTERNAL_API_RESPONSE_INVALID");
    return parsed.data;
  }
}
