import { createHash } from "node:crypto";
import WebSocket from "ws";
import {
  MarketEventSchema,
  eventIdempotencyKey,
  utcNow,
} from "@sentinel/domain";
import type { MarketEvent } from "@sentinel/domain";

export type PumpPortalOptions = {
  apiKey: string;
  enableNewTokens: boolean;
  enableMigrations: boolean;
  onEvent: (event: MarketEvent) => Promise<void>;
  onHealth: (
    state: "STARTING" | "HEALTHY" | "DEGRADED" | "STOPPED",
    reconnectCount: number,
    errorCode: string | null,
    lastEventAtUtc: string | null,
  ) => void;
  socketFactory?: (url: string) => WebSocket;
  random?: () => number;
  now?: () => number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  heartbeatMs?: number;
  maxMessageBytes?: number;
};

const SECRET_FIELD =
  /(?:api.?key|secret|password|private.?key|keypair|authorization|access.?token)/i;

export function parsePumpPortalMessage(
  input: unknown,
  receivedAtMs = Date.now(),
): MarketEvent {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("MALFORMED_EVENT");
  const record = input as Record<string, unknown>;
  const mint = record["mint"];
  if (typeof mint !== "string") throw new Error("MALFORMED_EVENT");
  const discriminator = [
    record["txType"],
    record["type"],
    record["event"],
  ].find((value) => typeof value === "string");
  if (typeof discriminator !== "string")
    throw new Error("UNSUPPORTED_EVENT_KIND");
  const normalizedType = discriminator.trim().toLowerCase();
  const kind =
    normalizedType === "create" || normalizedType === "token_created"
      ? "TOKEN_CREATED"
      : normalizedType === "migrate" ||
          normalizedType === "migration" ||
          normalizedType === "token_migrated"
        ? "TOKEN_MIGRATED"
        : null;
  if (!kind) throw new Error("UNSUPPORTED_EVENT_KIND");

  const signature = record["signature"];
  const slot = record["slot"];
  const creator = record["creator"];
  const name = record["name"];
  const symbol = record["symbol"];
  const uri = record["uri"];
  const optionalString = (
    value: unknown,
    limit: number,
    field: string,
  ): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value.length > limit)
      throw new Error("MALFORMED_EVENT");
    if (field === "creator") return value;
    return value;
  };
  if (
    signature !== undefined &&
    (typeof signature !== "string" ||
      !/^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(signature))
  )
    throw new Error("MALFORMED_EVENT");
  if (
    slot !== undefined &&
    (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0)
  )
    throw new Error("MALFORMED_EVENT");
  const safeCreator = optionalString(creator, 44, "creator");
  const safeName = optionalString(name, 128, "name");
  const safeSymbol = optionalString(symbol, 32, "symbol");
  const safeUri = optionalString(uri, 2048, "uri");
  const canonical = JSON.stringify(sanitizePayload(record));
  const payload =
    canonical.length <= 4096
      ? canonical
      : JSON.stringify({
          truncated: true,
          digest: createHash("sha256").update(canonical).digest("hex"),
        });
  const idempotencyKey = eventIdempotencyKey({
    kind,
    mint,
    ...(typeof signature === "string" ? { signature } : {}),
    ...(typeof slot === "number" ? { slot } : {}),
    ...(safeCreator ? { creator: safeCreator } : {}),
    ...(safeName ? { name: safeName } : {}),
    ...(safeSymbol ? { symbol: safeSymbol } : {}),
  });
  const event = {
    id: idempotencyKey,
    version: 1 as const,
    provider: "pumpportal" as const,
    kind,
    mint,
    ...(typeof signature === "string" ? { txSignature: signature } : {}),
    ...(typeof slot === "number" ? { slot } : {}),
    receivedAtUtc: new Date(receivedAtMs).toISOString(),
    firstSeenAtUtc: new Date(receivedAtMs).toISOString(),
    idempotencyKey,
    rawPayloadRef: `sha256:${createHash("sha256").update(payload).digest("hex")}`,
    sanitizedPayload: payload,
    ingestionLatencyMs: 0,
    ...(safeCreator ? { creator: safeCreator } : {}),
    ...(safeName ? { name: safeName } : {}),
    ...(safeSymbol ? { symbol: safeSymbol } : {}),
    ...(safeUri ? { uri: redactUrl(safeUri) } : {}),
  };
  return MarketEventSchema.parse(event);
}

function sanitizePayload(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[DEPTH_LIMIT]";
  if (Array.isArray(value))
    return value.slice(0, 40).map((item) => sanitizePayload(item, depth + 1));
  if (!value || typeof value !== "object") {
    if (typeof value === "string") return redactUrl(value.slice(0, 1024));
    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    )
      return value;
    return "[OMITTED]";
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    output[key.slice(0, 80)] = SECRET_FIELD.test(key)
      ? "[REDACTED]"
      : sanitizePayload(item, depth + 1);
  }
  return output;
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()])
      if (SECRET_FIELD.test(key)) url.searchParams.set(key, "[REDACTED]");
    return url.toString();
  } catch {
    return value;
  }
}

export class PumpPortalClient {
  readonly #opts: Required<
    Pick<
      PumpPortalOptions,
      | "minBackoffMs"
      | "maxBackoffMs"
      | "heartbeatMs"
      | "maxMessageBytes"
      | "random"
      | "now"
    >
  > &
    PumpPortalOptions;
  #running = false;
  #current: WebSocket | undefined;
  #loop: Promise<void> | undefined;
  #lastEventAtUtc: string | null = null;
  #reconnectCount = 0;
  #sleepTimer: ReturnType<typeof setTimeout> | undefined;
  #wakeSleep: (() => void) | undefined;

  constructor(options: PumpPortalOptions) {
    if (!options.apiKey.trim())
      throw new Error("PUMPPORTAL_API_KEY is required to start discovery");
    if (!options.enableNewTokens && !options.enableMigrations)
      throw new Error(
        "At least one PumpPortal discovery subscription must be enabled",
      );
    this.#opts = {
      ...options,
      minBackoffMs: options.minBackoffMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 30000,
      heartbeatMs: options.heartbeatMs ?? 15000,
      maxMessageBytes: options.maxMessageBytes ?? 65536,
      random: options.random ?? Math.random,
      now: options.now ?? Date.now,
    };
  }

  get reconnectCount(): number {
    return this.#reconnectCount;
  }

  start(): Promise<void> {
    if (this.#loop) return this.#loop;
    this.#running = true;
    this.#opts.onHealth(
      "STARTING",
      this.#reconnectCount,
      null,
      this.#lastEventAtUtc,
    );
    this.#loop = this.#run();
    return this.#loop;
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#sleepTimer) clearTimeout(this.#sleepTimer);
    this.#wakeSleep?.();
    this.#opts.onHealth(
      "STOPPED",
      this.#reconnectCount,
      null,
      this.#lastEventAtUtc,
    );
    this.#current?.close(1000, "shutdown");
    await this.#loop;
    this.#loop = undefined;
  }

  async #run(): Promise<void> {
    while (this.#running) {
      await this.#connectOnce();
      if (!this.#running) break;
      this.#reconnectCount += 1;
      this.#opts.onHealth(
        "DEGRADED",
        this.#reconnectCount,
        "SOCKET_DISCONNECTED",
        this.#lastEventAtUtc,
      );
      const base = Math.min(
        this.#opts.maxBackoffMs,
        this.#opts.minBackoffMs * 2 ** Math.min(this.#reconnectCount - 1, 10),
      );
      const delay = Math.floor(base * (0.5 + this.#opts.random() * 0.5));
      await new Promise<void>((resolve) => {
        this.#wakeSleep = resolve;
        this.#sleepTimer = setTimeout(() => {
          this.#sleepTimer = undefined;
          this.#wakeSleep = undefined;
          resolve();
        }, delay);
      });
    }
  }

  async #connectOnce(): Promise<void> {
    await new Promise<void>((resolve) => {
      const url = new URL("wss://pumpportal.fun/api/data");
      url.searchParams.set("api-key", this.#opts.apiKey);
      const socket = this.#opts.socketFactory
        ? this.#opts.socketFactory(url.toString())
        : new WebSocket(url.toString(), { handshakeTimeout: 10000 });
      this.#current = socket;
      let closed = false;
      let awaitingPong = false;
      const finish = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(handshakeTimeout);
        if (this.#current === socket) this.#current = undefined;
        resolve();
      };
      const heartbeat = setInterval(() => {
        if (awaitingPong) {
          this.#opts.onHealth(
            "DEGRADED",
            this.#reconnectCount,
            "HEARTBEAT_TIMEOUT",
            this.#lastEventAtUtc,
          );
          socket.terminate();
          return;
        }
        awaitingPong = true;
        try {
          socket.ping();
        } catch {
          socket.terminate();
        }
      }, this.#opts.heartbeatMs);
      const handshakeTimeout = setTimeout(() => {
        this.#opts.onHealth(
          "DEGRADED",
          this.#reconnectCount,
          "CONNECT_TIMEOUT",
          this.#lastEventAtUtc,
        );
        socket.terminate();
      }, 15000);
      socket.on("open", () => {
        clearTimeout(handshakeTimeout);
        if (this.#opts.enableNewTokens)
          socket.send(JSON.stringify({ method: "subscribeNewToken" }));
        if (this.#opts.enableMigrations)
          socket.send(JSON.stringify({ method: "subscribeMigration" }));
        this.#opts.onHealth(
          "HEALTHY",
          this.#reconnectCount,
          null,
          this.#lastEventAtUtc,
        );
      });
      socket.on("pong", () => {
        awaitingPong = false;
        this.#opts.onHealth(
          "HEALTHY",
          this.#reconnectCount,
          null,
          this.#lastEventAtUtc,
        );
      });
      socket.on("message", (data: WebSocket.RawData) => {
        const receivedAt = this.#opts.now();
        const bytes = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer);
        if (bytes.byteLength > this.#opts.maxMessageBytes) {
          this.#opts.onHealth(
            "DEGRADED",
            this.#reconnectCount,
            "MESSAGE_TOO_LARGE",
            this.#lastEventAtUtc,
          );
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(bytes.toString("utf8")) as unknown;
        } catch {
          this.#opts.onHealth(
            "DEGRADED",
            this.#reconnectCount,
            "MALFORMED_JSON",
            this.#lastEventAtUtc,
          );
          return;
        }
        try {
          const event = parsePumpPortalMessage(parsed, receivedAt);
          void this.#opts
            .onEvent(event)
            .then(() => {
              this.#lastEventAtUtc = event.receivedAtUtc;
              this.#opts.onHealth(
                "HEALTHY",
                this.#reconnectCount,
                null,
                this.#lastEventAtUtc,
              );
            })
            .catch(() =>
              this.#opts.onHealth(
                "DEGRADED",
                this.#reconnectCount,
                "EVENT_PERSIST_FAILED",
                this.#lastEventAtUtc,
              ),
            );
        } catch (error) {
          const code =
            error instanceof Error &&
            ["MALFORMED_EVENT", "UNSUPPORTED_EVENT_KIND"].includes(
              error.message,
            )
              ? error.message
              : "MALFORMED_EVENT";
          this.#opts.onHealth(
            "DEGRADED",
            this.#reconnectCount,
            code,
            this.#lastEventAtUtc,
          );
        }
      });
      socket.on("error", () =>
        this.#opts.onHealth(
          "DEGRADED",
          this.#reconnectCount,
          "SOCKET_ERROR",
          this.#lastEventAtUtc,
        ),
      );
      socket.on("close", finish);
    });
  }
}

export function pumpPortalHealth(
  state: "DISABLED" | "STARTING" | "HEALTHY" | "DEGRADED" | "STOPPED",
  reconnectCount: number,
  errorCode: string | null,
  lastEventAtUtc: string | null,
) {
  return {
    provider: "pumpportal" as const,
    state,
    checkedAtUtc: utcNow(),
    lastEventAtUtc,
    reconnectCount,
    errorCode,
  };
}
