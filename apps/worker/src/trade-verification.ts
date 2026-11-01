import type { HeliusLogTradeInput } from "@sentinel/providers";

export class BoundedTradeVerificationQueue {
  readonly #maxPending: number;
  readonly #concurrency: number;
  readonly #process: (event: HeliusLogTradeInput) => Promise<void>;
  readonly #onFailure: (event: HeliusLogTradeInput, error: unknown) => void;
  readonly #queue: HeliusLogTradeInput[] = [];
  readonly #signatures = new Set<string>();
  #active = 0;
  #accepting = true;
  #idleWaiters: Array<() => void> = [];

  constructor(input: {
    maxPending: number;
    concurrency: number;
    process: (event: HeliusLogTradeInput) => Promise<void>;
    onFailure: (event: HeliusLogTradeInput, error: unknown) => void;
  }) {
    if (
      !Number.isSafeInteger(input.maxPending) ||
      input.maxPending < 1 ||
      !Number.isSafeInteger(input.concurrency) ||
      input.concurrency < 1
    )
      throw new Error("TRADE_VERIFICATION_QUEUE_CONFIG_INVALID");
    this.#maxPending = input.maxPending;
    this.#concurrency = input.concurrency;
    this.#process = input.process;
    this.#onFailure = input.onFailure;
  }

  get pendingCount(): number {
    return this.#queue.length;
  }

  get activeCount(): number {
    return this.#active;
  }

  enqueue(
    event: HeliusLogTradeInput,
  ): "ACCEPTED" | "DUPLICATE" | "FULL" | "STOPPED" {
    const key = `${event.mint}:${event.signature}`;
    if (!this.#accepting) return "STOPPED";
    if (this.#signatures.has(key)) return "DUPLICATE";
    if (this.#queue.length + this.#active >= this.#maxPending) return "FULL";
    this.#signatures.add(key);
    this.#queue.push(event);
    this.#drain();
    return "ACCEPTED";
  }

  async stop(): Promise<void> {
    this.#accepting = false;
    if (this.#queue.length === 0 && this.#active === 0) return;
    await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
  }

  #drain(): void {
    while (this.#active < this.#concurrency && this.#queue.length > 0) {
      const event = this.#queue.shift();
      if (!event) continue;
      this.#active += 1;
      void this.#process(event)
        .catch((error: unknown) => this.#onFailure(event, error))
        .finally(() => {
          this.#active -= 1;
          this.#signatures.delete(`${event.mint}:${event.signature}`);
          this.#drain();
          if (this.#queue.length === 0 && this.#active === 0)
            for (const resolve of this.#idleWaiters.splice(0)) resolve();
        });
    }
  }
}
