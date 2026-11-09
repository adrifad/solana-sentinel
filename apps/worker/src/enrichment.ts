import { utcNow } from "@sentinel/domain";
import { ProviderFailure, type HeliusRpcClient } from "@sentinel/providers";
import type { SentinelStore } from "@sentinel/storage";
import { log } from "./logger.ts";

type Job = NonNullable<ReturnType<SentinelStore["claimEnrichmentJob"]>>;
type MigrationJob = NonNullable<
  ReturnType<SentinelStore["claimMigrationRecoveryJob"]>
>;

export class EnrichmentScheduler {
  readonly #store: SentinelStore;
  readonly #helius: HeliusRpcClient | undefined;
  readonly #concurrency: number;
  readonly #active = new Set<Promise<void>>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #healthTimer: ReturnType<typeof setInterval> | undefined;
  #stopping = false;
  #healthState: "HEALTHY" | "DEGRADED" = "HEALTHY";
  #healthError: string | null = null;

  constructor(
    store: SentinelStore,
    helius: HeliusRpcClient | undefined,
    concurrency: number,
  ) {
    this.#store = store;
    this.#helius = helius;
    this.#concurrency = concurrency;
  }

  start(): void {
    this.#store.recoverInterruptedEnrichmentJobs();
    this.#store.recoverInterruptedMigrationJobs();
    this.#reportScheduler("HEALTHY", null);
    this.#timer = setInterval(() => this.#fill(), 200);
    this.#healthTimer = setInterval(
      () => this.#reportScheduler(this.#healthState, this.#healthError),
      10_000,
    );
    this.#fill();
  }

  wake(): void {
    this.#fill();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#healthTimer) clearInterval(this.#healthTimer);
    await Promise.allSettled([...this.#active]);
    this.#reportScheduler("STOPPED", null);
  }

  #fill(): void {
    if (this.#stopping) return;
    while (this.#active.size < this.#concurrency) {
      let job: Job | null = null;
      try {
        job = this.#helius ? this.#store.claimEnrichmentJob() : null;
      } catch (error) {
        log("error", "provider.helius.enrichment_claim_failed", {
          errorCode: error instanceof Error ? error.name : "UNKNOWN_ERROR",
        });
        return;
      }
      if (!job) {
        let migrationJob: MigrationJob | null;
        try {
          migrationJob = this.#store.claimMigrationRecoveryJob();
        } catch (error) {
          log("error", "migration.recovery_claim_failed", {
            errorCode: error instanceof Error ? error.name : "UNKNOWN_ERROR",
          });
          return;
        }
        if (!migrationJob) return;
        const task = this.#processMigration(migrationJob).catch(
          (error: unknown) => {
            log("error", "migration.recovery_state_failed", {
              mint: migrationJob.mint,
              eventId: migrationJob.eventId,
              errorCode: error instanceof Error ? error.name : "UNKNOWN_ERROR",
            });
            this.#store.finishMigrationRecoveryJob(
              migrationJob.eventId,
              "FAILED",
              "MIGRATION_RECOVERY_INTERNAL_ERROR",
            );
          },
        );
        this.#active.add(task);
        void task.finally(() => {
          this.#active.delete(task);
          this.#fill();
        });
        continue;
      }
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

  async #processMigration(job: MigrationJob): Promise<void> {
    if (!job.monitoringEligible) {
      this.#store.finishMigrationRecoveryJob(
        job.eventId,
        "FAILED",
        "TOKEN_OUTSIDE_MONITORING_BUDGET",
      );
      return;
    }
    if (!this.#helius || !job.signature) {
      this.#store.finishMigrationRecoveryJob(
        job.eventId,
        "FAILED",
        !job.signature
          ? "MIGRATION_SIGNATURE_MISSING"
          : "HELIUS_CREDENTIAL_MISSING",
      );
      return;
    }
    try {
      const transaction = await this.#helius.getTransaction(job.signature);
      const mintPresent =
        transaction?.accountKeys.some((key) => key.pubkey === job.mint) ||
        transaction?.preTokenBalances?.some(
          (balance) => balance.mint === job.mint,
        ) ||
        transaction?.postTokenBalances?.some(
          (balance) => balance.mint === job.mint,
        );
      if (
        !transaction ||
        transaction.signature !== job.signature ||
        !transaction.succeeded ||
        !Number.isSafeInteger(transaction.slot) ||
        transaction.slot < 0 ||
        !mintPresent ||
        (job.eventSlot !== null && job.eventSlot !== transaction.slot)
      ) {
        this.#store.finishMigrationRecoveryJob(
          job.eventId,
          "FAILED",
          !transaction
            ? "MIGRATION_TRANSACTION_UNAVAILABLE"
            : !transaction.succeeded
              ? "MIGRATION_TRANSACTION_FAILED"
              : !mintPresent
                ? "MIGRATION_MINT_NOT_IN_TRANSACTION"
                : job.eventSlot !== null && job.eventSlot !== transaction.slot
                  ? "MIGRATION_SLOT_MISMATCH"
                  : "MIGRATION_TRANSACTION_MISMATCH",
        );
        return;
      }
      this.#store.resolveMigrationEvent({
        eventId: job.eventId,
        mint: job.mint,
        signature: job.signature,
        slot: transaction.slot,
        blockTime: transaction.blockTime,
      });
      this.#store.setProviderHealth({
        provider: "helius",
        state: "HEALTHY",
        checkedAtUtc: utcNow(),
        lastEventAtUtc: null,
        reconnectCount: 0,
        errorCode: null,
      });
      this.#reportScheduler("HEALTHY", null);
    } catch (error) {
      const deterministicFailure =
        error instanceof Error &&
        [
          "MIGRATION_EVENT_CONTRADICTS_TRANSACTION",
          "MIGRATION_SLOT_CONFLICT",
          "MIGRATION_SLOT_INVALID",
        ].includes(error.message);
      const errorCode =
        error instanceof ProviderFailure
          ? error.code
          : deterministicFailure && error instanceof Error
            ? error.message
            : "PROVIDER_UNAVAILABLE";
      const budgetDeferred = errorCode.startsWith("REQUEST_");
      const terminal =
        deterministicFailure ||
        (!budgetDeferred && job.attempts >= 3) ||
        errorCode === "INVALID_SIGNATURE";
      const untilUtcDay = new Date();
      untilUtcDay.setUTCHours(24, 0, 0, 0);
      this.#store.finishMigrationRecoveryJob(
        job.eventId,
        terminal ? "FAILED" : "PENDING",
        errorCode,
        budgetDeferred
          ? errorCode === "REQUEST_BUDGET_EXHAUSTED"
            ? Math.max(1000, untilUtcDay.getTime() - Date.now())
            : error instanceof ProviderFailure && error.retryAfterMs > 0
              ? error.retryAfterMs
              : 1000
          : terminal
            ? 0
            : 500 * 2 ** (job.attempts - 1),
      );
      if (error instanceof ProviderFailure && !budgetDeferred)
        this.#store.setProviderHealth({
          provider: "helius",
          state: "DEGRADED",
          checkedAtUtc: utcNow(),
          lastEventAtUtc: null,
          reconnectCount: 0,
          errorCode,
          queueDepth: this.#active.size,
        });
      this.#reportScheduler("DEGRADED", errorCode);
      log("warn", "migration.recovery_failed", {
        mint: job.mint,
        eventId: job.eventId,
        errorCode,
        willRetry: !terminal,
      });
    }
  }

  async #process(job: Job): Promise<void> {
    try {
      let failureCode: string | null = null;
      if (job.kind === "TOKEN_CREATED") {
        const current = this.#store.getToken(job.mint);
        if (
          current?.mintStateStatus === "UNKNOWN" ||
          current?.mintStateStatus === "PROVIDER_ERROR"
        ) {
          try {
            const account = await this.#helius!.getAccountInfo(job.mint);
            this.#store.recordMintAccount(
              job.mint,
              account.account ? "PRESENT" : "NOT_FOUND",
              account.slot,
              account.account?.owner ?? null,
              null,
            );
          } catch (error) {
            failureCode =
              error instanceof ProviderFailure
                ? error.code
                : "PROVIDER_UNAVAILABLE";
            this.#store.recordMintAccount(
              job.mint,
              "PROVIDER_ERROR",
              null,
              null,
              failureCode,
            );
          }
        }
      }
      if (
        job.slot !== null &&
        (job.chainTimeStatus === "UNKNOWN" ||
          job.chainTimeStatus === "PROVIDER_ERROR")
      ) {
        try {
          const observedAtUtc = await this.#helius!.getBlockTime(job.slot);
          if (observedAtUtc)
            this.#store.recordObservedTimestamp(job.eventId, observedAtUtc);
          else this.#store.recordUnavailableTimestamp(job.eventId);
        } catch (error) {
          const code =
            error instanceof ProviderFailure
              ? error.code
              : "PROVIDER_UNAVAILABLE";
          this.#store.recordTimestampError(job.eventId, code);
          failureCode ??= code;
        }
      }
      if (failureCode) throw new ProviderFailure(failureCode);
      this.#store.finishEnrichmentJob(job.eventId, "COMPLETE");
      this.#store.setProviderHealth({
        provider: "helius",
        state: "HEALTHY",
        checkedAtUtc: utcNow(),
        lastEventAtUtc: null,
        reconnectCount: 0,
        errorCode: null,
      });
      this.#reportScheduler("HEALTHY", null);
    } catch (error) {
      const errorCode =
        error instanceof ProviderFailure ? error.code : "PROVIDER_UNAVAILABLE";
      const budgetDeferred = errorCode.startsWith("REQUEST_");
      const terminal = !budgetDeferred && job.attempts >= 3;
      const untilUtcDay = new Date();
      untilUtcDay.setUTCHours(24, 0, 0, 0);
      this.#store.finishEnrichmentJob(
        job.eventId,
        budgetDeferred ? "DEFERRED_BUDGET" : terminal ? "FAILED" : "PENDING",
        errorCode,
        budgetDeferred
          ? errorCode === "REQUEST_BUDGET_EXHAUSTED"
            ? Math.max(1000, untilUtcDay.getTime() - Date.now())
            : error instanceof ProviderFailure && error.retryAfterMs > 0
              ? error.retryAfterMs
              : 1000
          : terminal
            ? 0
            : 500 * 2 ** (job.attempts - 1),
      );
      if (!budgetDeferred)
        this.#store.setProviderHealth({
          provider: "helius",
          state: "DEGRADED",
          checkedAtUtc: utcNow(),
          lastEventAtUtc: null,
          reconnectCount: 0,
          errorCode,
          queueDepth: this.#active.size,
        });
      this.#reportScheduler("DEGRADED", errorCode);
      log("warn", "provider.helius.enrichment_failed", {
        mint: job.mint,
        eventId: job.eventId,
        errorCode,
        willRetry: !terminal,
      });
    }
  }

  #reportScheduler(
    state: "HEALTHY" | "DEGRADED" | "STOPPED",
    errorCode: string | null,
  ): void {
    if (state !== "STOPPED") {
      this.#healthState = state;
      this.#healthError = errorCode;
    }
    this.#store.setProviderHealth({
      provider: "enrichment_scheduler",
      state,
      checkedAtUtc: utcNow(),
      lastEventAtUtc: null,
      reconnectCount: 0,
      errorCode,
      queueDepth: this.#active.size,
    });
  }
}
