import { createHash } from "node:crypto";
import WebSocket from "ws";
import { z } from "zod";
import { PubkeySchema, base58DecodedLength } from "@sentinel/domain";

const SignatureSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/)
  .refine((signature) => base58DecodedLength(signature) === 64);
const NotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("logsNotification"),
  params: z.object({
    subscription: z.number().int().nonnegative(),
    result: z.object({
      context: z.object({
        slot: z.number().int().nonnegative().safe(),
      }),
      value: z.object({
        signature: z.string(),
        err: z.unknown(),
        logs: z.array(z.string()).max(10000),
      }),
    }),
  }),
});

export type HeliusLogTradeInput = {
  mint: string;
  signature: string;
  slot: number;
  logs: string[];
  observedAtUtc: string;
  payloadRef: string;
  windowStartedAtUtc: string;
  windowExpiresAtUtc: string;
  reconnectCount: number;
};

export type HeliusTradeStreamOptions = {
  apiKey: string;
  maxActiveSubscriptions: number;
  subscriptionDurationSeconds: number;
  consumeEventBudget: () => boolean;
  onLogs: (input: HeliusLogTradeInput) => void;
  onCoverage: (input: {
    mint: string;
    status: "UNVERIFIED" | "GAP_DETECTED" | "RECONCILING";
    reasonCode: string;
    observedAtUtc: string;
    windowStartedAtUtc: string;
    windowExpiresAtUtc: string;
    reconnectCount: number;
  }) => void;
  onHealth?: (
    state: "STARTING" | "HEALTHY" | "DEGRADED" | "STOPPED",
    errorCode: string | null,
    reconnectCount: number,
  ) => void;
  socketFactory?: (url: string) => WebSocket;
  now?: () => number;
  maxMessageBytes?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
};

type Subscription = {
  mint: string;
  startedAtMs: number;
  expiresAtMs: number;
  subscriptionId: number | null;
  requestId: number | null;
};

/** One Helius standard logsSubscribe socket for bounded per-mint observation. */
export class HeliusTradeStream {
  readonly #options: Required<
    Pick<
      HeliusTradeStreamOptions,
      "now" | "maxMessageBytes" | "minBackoffMs" | "maxBackoffMs"
    >
  > &
    HeliusTradeStreamOptions;
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #bySubscriptionId = new Map<number, Subscription>();
  readonly #requests = new Map<number, Subscription>();
  #socket: WebSocket | undefined;
  #running = false;
  #reconnectCount = 0;
  #nextRequestId = 1;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #expiryTimer: ReturnType<typeof setInterval> | undefined;
  #loop: Promise<void> | undefined;

  constructor(options: HeliusTradeStreamOptions) {
    if (!options.apiKey.trim()) throw new Error("HELIUS_API_KEY is required");
    if (
      !Number.isSafeInteger(options.maxActiveSubscriptions) ||
      options.maxActiveSubscriptions < 1 ||
      !Number.isSafeInteger(options.subscriptionDurationSeconds) ||
      options.subscriptionDurationSeconds < 1
    )
      throw new Error("HELIUS_TRADE_STREAM_CONFIG_INVALID");
    this.#options = {
      ...options,
      now: options.now ?? Date.now,
      maxMessageBytes: options.maxMessageBytes ?? 1_048_576,
      minBackoffMs: options.minBackoffMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
    };
  }

  get activeSubscriptionCount(): number {
    return this.#subscriptions.size;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#options.onHealth?.("STARTING", null, this.#reconnectCount);
    this.#expiryTimer = setInterval(() => this.#expireSubscriptions(), 1000);
    this.#connect();
  }

  subscribeMint(mint: string): boolean {
    if (!PubkeySchema.safeParse(mint).success) return false;
    const now = this.#options.now();
    const existing = this.#subscriptions.get(mint);
    if (existing) {
      existing.expiresAtMs = Math.max(
        existing.expiresAtMs,
        now + this.#options.subscriptionDurationSeconds * 1000,
      );
      return true;
    }
    if (
      !this.#running ||
      this.#subscriptions.size >= this.#options.maxActiveSubscriptions
    ) {
      this.#options.onCoverage({
        mint,
        status: "UNVERIFIED",
        reasonCode: this.#running
          ? "TRADE_SUBSCRIPTION_CAPACITY_REACHED"
          : "TRADE_STREAM_DISABLED",
        observedAtUtc: new Date(now).toISOString(),
        windowStartedAtUtc: new Date(now).toISOString(),
        windowExpiresAtUtc: new Date(now).toISOString(),
        reconnectCount: this.#reconnectCount,
      });
      return false;
    }
    const subscription: Subscription = {
      mint,
      startedAtMs: now,
      expiresAtMs: now + this.#options.subscriptionDurationSeconds * 1000,
      subscriptionId: null,
      requestId: null,
    };
    this.#subscriptions.set(mint, subscription);
    this.#reportCoverage(
      subscription,
      "UNVERIFIED",
      "HELIUS_LOGS_STREAM_HAS_NO_REPLAY_CURSOR",
      now,
    );
    if (this.#socket?.readyState === WebSocket.OPEN)
      this.#sendSubscribe(subscription);
    return true;
  }

  unsubscribeMint(
    mint: string,
    reasonCode = "OBSERVATION_WINDOW_EXPIRED",
  ): void {
    const subscription = this.#subscriptions.get(mint);
    if (!subscription) return;
    if (subscription.subscriptionId !== null)
      this.#send({
        jsonrpc: "2.0",
        id: this.#requestId(),
        method: "logsUnsubscribe",
        params: [subscription.subscriptionId],
      });
    if (subscription.requestId !== null)
      this.#requests.delete(subscription.requestId);
    this.#bySubscriptionId.delete(subscription.subscriptionId ?? -1);
    this.#subscriptions.delete(mint);
    this.#reportCoverage(
      subscription,
      "UNVERIFIED",
      reasonCode,
      this.#options.now(),
    );
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    if (this.#expiryTimer) clearInterval(this.#expiryTimer);
    this.#retryTimer = undefined;
    this.#expiryTimer = undefined;
    for (const mint of [...this.#subscriptions.keys()])
      this.unsubscribeMint(mint, "TRADE_STREAM_STOPPED");
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING)
      socket.close(1000, "shutdown");
    await this.#loop?.catch(() => undefined);
    this.#options.onHealth?.("STOPPED", null, this.#reconnectCount);
  }

  #connect(): void {
    if (!this.#running) return;
    const url = `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(this.#options.apiKey)}`;
    const socket = (
      this.#options.socketFactory ?? ((target) => new WebSocket(target))
    )(url);
    this.#socket = socket;
    this.#loop = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      socket.on("open", () => {
        if (this.#socket !== socket || !this.#running) return;
        this.#options.onHealth?.("HEALTHY", null, this.#reconnectCount);
        for (const subscription of this.#subscriptions.values()) {
          subscription.subscriptionId = null;
          this.#sendSubscribe(subscription);
        }
      });
      socket.on("message", (data: WebSocket.RawData) => {
        if (this.#socket !== socket || !this.#running) return;
        this.#onMessage(data);
      });
      socket.on("error", () => {
        if (this.#socket === socket)
          this.#options.onHealth?.(
            "DEGRADED",
            "HELIUS_TRADE_SOCKET_ERROR",
            this.#reconnectCount,
          );
      });
      socket.on("close", () => {
        finish();
        if (this.#socket !== socket) return;
        this.#socket = undefined;
        this.#requests.clear();
        if (!this.#running) return;
        const at = new Date(this.#options.now()).toISOString();
        for (const subscription of this.#subscriptions.values()) {
          subscription.subscriptionId = null;
          subscription.requestId = null;
          this.#reportCoverage(
            subscription,
            "GAP_DETECTED",
            "HELIUS_TRADE_SOCKET_DISCONNECTED",
            Date.parse(at),
          );
        }
        this.#reconnectCount += 1;
        this.#options.onHealth?.(
          "DEGRADED",
          "HELIUS_TRADE_SOCKET_DISCONNECTED",
          this.#reconnectCount,
        );
        const delay = Math.min(
          this.#options.maxBackoffMs,
          this.#options.minBackoffMs *
            2 ** Math.min(this.#reconnectCount - 1, 8),
        );
        this.#retryTimer = setTimeout(() => this.#connect(), delay);
      });
    });
  }

  #sendSubscribe(subscription: Subscription): void {
    const requestId = this.#requestId();
    subscription.requestId = requestId;
    this.#requests.set(requestId, subscription);
    this.#send({
      jsonrpc: "2.0",
      id: requestId,
      method: "logsSubscribe",
      params: [{ mentions: [subscription.mint] }, { commitment: "confirmed" }],
    });
  }

  #send(value: unknown): void {
    if (this.#socket?.readyState === WebSocket.OPEN)
      this.#socket.send(JSON.stringify(value));
  }

  #requestId(): number {
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    return id;
  }

  #onMessage(data: WebSocket.RawData): void {
    const raw = rawDataToBuffer(data);
    if (raw.length > this.#options.maxMessageBytes) {
      this.#options.onHealth?.(
        "DEGRADED",
        "HELIUS_TRADE_FRAME_TOO_LARGE",
        this.#reconnectCount,
      );
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
      this.#options.onHealth?.(
        "DEGRADED",
        "HELIUS_TRADE_FRAME_MALFORMED",
        this.#reconnectCount,
      );
      return;
    }
    if (!isRecord(input)) {
      this.#options.onHealth?.(
        "DEGRADED",
        "HELIUS_TRADE_FRAME_MALFORMED",
        this.#reconnectCount,
      );
      return;
    }
    if (typeof input["id"] === "number") {
      this.#onSubscriptionAck(input);
      return;
    }
    const parsed = NotificationSchema.safeParse(input);
    if (!parsed.success) {
      this.#options.onHealth?.(
        "DEGRADED",
        "HELIUS_TRADE_FRAME_UNSUPPORTED",
        this.#reconnectCount,
      );
      return;
    }
    const envelope = parsed.data.params;
    const subscription = this.#bySubscriptionId.get(envelope.subscription);
    if (!subscription) return;
    const event = envelope.result.value;
    if (!this.#options.consumeEventBudget()) {
      this.#reportCoverage(
        subscription,
        "GAP_DETECTED",
        "HELIUS_TRADE_EVENT_BUDGET_EXHAUSTED",
        this.#options.now(),
      );
      this.unsubscribeMint(
        subscription.mint,
        "HELIUS_TRADE_EVENT_BUDGET_EXHAUSTED",
      );
      return;
    }
    if (
      !SignatureSchema.safeParse(event.signature).success ||
      base58DecodedLength(event.signature) !== 64 ||
      event.err !== null
    )
      return;
    const payloadRef = `sha256:${createHash("sha256")
      .update(
        JSON.stringify({
          signature: event.signature,
          slot: envelope.result.context.slot,
          logs: event.logs,
        }),
      )
      .digest("hex")}`;
    try {
      this.#options.onLogs({
        mint: subscription.mint,
        signature: event.signature,
        slot: envelope.result.context.slot,
        logs: event.logs,
        observedAtUtc: new Date(this.#options.now()).toISOString(),
        payloadRef,
        windowStartedAtUtc: new Date(subscription.startedAtMs).toISOString(),
        windowExpiresAtUtc: new Date(subscription.expiresAtMs).toISOString(),
        reconnectCount: this.#reconnectCount,
      });
    } catch {
      this.#reportCoverage(
        subscription,
        "GAP_DETECTED",
        "TRADE_OBSERVATION_PERSIST_FAILED",
        this.#options.now(),
      );
      this.#options.onHealth?.(
        "DEGRADED",
        "TRADE_OBSERVATION_PERSIST_FAILED",
        this.#reconnectCount,
      );
    }
  }

  #onSubscriptionAck(input: Record<string, unknown>): void {
    const requestId = input["id"];
    if (typeof requestId !== "number") return;
    const subscription = this.#requests.get(requestId);
    this.#requests.delete(requestId);
    if (!subscription) return;
    if (
      typeof input["result"] !== "number" ||
      !Number.isSafeInteger(input["result"])
    ) {
      this.#reportCoverage(
        subscription,
        "GAP_DETECTED",
        "HELIUS_LOGS_SUBSCRIPTION_REJECTED",
        this.#options.now(),
      );
      return;
    }
    subscription.requestId = null;
    subscription.subscriptionId = input["result"];
    this.#bySubscriptionId.set(input["result"], subscription);
  }

  #expireSubscriptions(): void {
    const now = this.#options.now();
    for (const [mint, subscription] of this.#subscriptions)
      if (subscription.expiresAtMs <= now)
        this.unsubscribeMint(mint, "OBSERVATION_WINDOW_EXPIRED");
  }

  #reportCoverage(
    subscription: Subscription,
    status: "UNVERIFIED" | "GAP_DETECTED" | "RECONCILING",
    reasonCode: string,
    observedAtMs: number,
  ): void {
    this.#options.onCoverage({
      mint: subscription.mint,
      status,
      reasonCode,
      observedAtUtc: new Date(observedAtMs).toISOString(),
      windowStartedAtUtc: new Date(subscription.startedAtMs).toISOString(),
      windowExpiresAtUtc: new Date(subscription.expiresAtMs).toISOString(),
      reconnectCount: this.#reconnectCount,
    });
  }
}

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
