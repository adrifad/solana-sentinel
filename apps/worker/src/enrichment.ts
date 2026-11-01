import { utcNow } from "@sentinel/domain";
import { ProviderFailure, type HeliusRpcClient } from "@sentinel/providers";
import type { SentinelStore } from "@sentinel/storage";
import { log } from "./logger.ts";

type Job = NonNullable<ReturnType<SentinelStore["claimEnrichmentJob"]>>;

export class EnrichmentScheduler {
  readonly #store: SentinelStore;
  readonly #helius: HeliusRpcClient;
  readonly #concurrency: number;
  readonly #active = new Set<Promise<void>>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #stopping = false;

  constructor(
    store: SentinelStore,
    helius: HeliusRpcClient,
    concurrency: number,
  ) {
    this.#store = store;
    this.#helius = helius;
    this.#concurrency = concurrency;
  }

  start(): void {
    this.#store.recoverInterruptedEnrichmentJobs();
    this.#timer = setInterval(() => this.#fill(), 200);
    this.#fill();
  }

  wake(): void {
    this.#fill();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    await Promise.allSettled([...this.#active]);
  }

  #fill(): void {
    if (this.#stopping) return;
    while (this.#active.size < this.#concurrency) {
      let job: Job | null;
      try {
        job = this.#store.claimEnrichmentJob();
      } catch (error) {
        log("error", "provider.helius.enrichment_claim_failed", {
          errorCode: error instanceof Error ? error.name : "UNKNOWN_ERROR",
        });
        return;
      }
      if (!job) return;
      const task = this.#process(job).catch((error: unknown) => {
        log("error", "provider.helius.enrichment_state_failed", {
          mint: job.mint,
          eventId: job.eventId,
          errorCode: error instanceof Error ? error.name : "UNKNOWN_ERROR",
        });
      });
      this.#active.add(task);
      void task.finally(() => {
        this.#active.delete(task);
        this.#fill();
      });
    }
  }

  async #process(job: Job): Promise<void> {
    try {
      if (job.kind === "TOKEN_CREATED") {
        const current = this.#store.getToken(job.mint);
        if (
          current?.mintStateStatus === "UNKNOWN" ||
          current?.mintStateStatus === "PROVIDER_ERROR"
        ) {
          const account = await this.#helius.getAccountInfo(job.mint);
          this.#store.recordMintAccount(
            job.mint,
            account.account ? "PRESENT" : "NOT_FOUND",
            account.slot,
            account.account?.owner ?? null,
            null,
          );
        }
      }
      if (job.slot !== null) {
        const observedAtUtc = await this.#helius.getBlockTime(job.slot);
        if (observedAtUtc)
          this.#store.recordObservedTimestamp(job.eventId, observedAtUtc);
      }
      this.#store.finishEnrichmentJob(job.eventId, "COMPLETE");
      this.#store.setProviderHealth({
        provider: "helius",
        state: "HEALTHY",
        checkedAtUtc: utcNow(),
        lastEventAtUtc: null,
        reconnectCount: 0,
        errorCode: null,
      });
    } catch (error) {
      const errorCode =
        error instanceof ProviderFailure ? error.code : "PROVIDER_UNAVAILABLE";
      const budgetExhausted = errorCode === "REQUEST_BUDGET_EXHAUSTED";
      const terminal = budgetExhausted || job.attempts >= 3;
      const untilUtcDay = new Date();
      untilUtcDay.setUTCHours(24, 0, 0, 0);
      this.#store.finishEnrichmentJob(
        job.eventId,
        terminal ? (budgetExhausted ? "PENDING" : "FAILED") : "PENDING",
        errorCode,
        budgetExhausted
          ? Math.max(1000, untilUtcDay.getTime() - Date.now())
          : terminal
            ? 0
            : 500 * 2 ** (job.attempts - 1),
      );
      if (job.kind === "TOKEN_CREATED")
        this.#store.recordMintAccount(
          job.mint,
          "PROVIDER_ERROR",
          null,
          null,
          errorCode,
        );
      this.#store.setProviderHealth({
        provider: "helius",
        state: "DEGRADED",
        checkedAtUtc: utcNow(),
        lastEventAtUtc: null,
        reconnectCount: 0,
        errorCode,
        queueDepth: this.#active.size,
      });
      log("warn", "provider.helius.enrichment_failed", {
        mint: job.mint,
        eventId: job.eventId,
        errorCode,
        willRetry: !terminal,
      });
    }
  }
}
