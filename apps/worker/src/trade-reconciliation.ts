import { createHash } from "node:crypto";
import type { HeliusParsedEventsScanClient } from "@sentinel/providers";
import type {
  ParsedReconciliationFinalization,
  SentinelStore,
} from "@sentinel/storage";
import type { BoundedTradeVerificationQueue } from "./trade-verification.ts";

export function parsedScanMatchesVerifiedTrades(input: {
  expectedMint: string | null | undefined;
  expectedSide: "BUY" | "SELL" | null | undefined;
  observations: Array<{ mint: string; side: "BUY" | "SELL" }>;
}): boolean {
  return Boolean(
    input.expectedMint &&
    input.expectedSide &&
    input.observations.length > 0 &&
    input.observations.every(
      (observation) =>
        observation.mint === input.expectedMint &&
        observation.side === input.expectedSide,
    ),
  );
}

export function parsedScanEventWithinExactWindow(input: {
  blockTime: number;
  windowStartedAtUtc: string;
  windowExpiresAtUtc: string;
}): boolean {
  const startedAt = Date.parse(input.windowStartedAtUtc);
  const expiresAt = Date.parse(input.windowExpiresAtUtc);
  const blockTimeMs = input.blockTime * 1000;
  return (
    Number.isFinite(startedAt) &&
    Number.isFinite(expiresAt) &&
    blockTimeMs >= startedAt &&
    blockTimeMs < expiresAt
  );
}

export class TradeReconciliationWorker {
  readonly #store: SentinelStore;
  readonly #scan: HeliusParsedEventsScanClient;
  readonly #queue: BoundedTradeVerificationQueue;
  readonly #maxPagesPerJob: number;
  readonly #maxScannedTransactions: number;
  readonly #concurrency: number;
  readonly #onEvidence: (input: { mint: string; triggerKey: string }) => void;
  readonly #finalityBufferSeconds: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #stopped = false;

  constructor(input: {
    store: SentinelStore;
    scan: HeliusParsedEventsScanClient;
    verificationQueue: BoundedTradeVerificationQueue;
    maxPagesPerJob: number;
    maxScannedTransactions: number;
    concurrency: number;
    finalityBufferSeconds: number;
    onEvidence: (input: { mint: string; triggerKey: string }) => void;
  }) {
    this.#store = input.store;
    this.#scan = input.scan;
    this.#queue = input.verificationQueue;
    this.#maxPagesPerJob = input.maxPagesPerJob;
    this.#maxScannedTransactions = input.maxScannedTransactions;
    this.#concurrency = input.concurrency;
    this.#finalityBufferSeconds = input.finalityBufferSeconds;
    this.#onEvidence = input.onEvidence;
  }

  start(): void {
    if (this.#timer || this.#stopped) return;
    this.#store.recoverParsedReconciliationJobs();
    this.#restorePendingTransactions();
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    while (this.#running)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }

  #restorePendingTransactions(): void {
    for (const item of this.#store.listPendingParsedReconciliationTransactions()) {
      this.#queue.enqueue({
        mint: item.mint,
        signature: item.signature,
        slot: item.slot,
        providerBlockTime: item.blockTime,
        expectedMint: item.parsedMint,
        expectedSide: item.expectedSide,
        logs: [],
        observedAtUtc: new Date().toISOString(),
        payloadRef: `parsed-scan:${item.signature}`,
        windowStartedAtUtc: item.windowStartedAtUtc,
        windowExpiresAtUtc: item.windowExpiresAtUtc,
        reconnectCount: 0,
      });
    }
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => void this.#tick(), delayMs);
  }

  async #tick(): Promise<void> {
    this.#timer = undefined;
    if (this.#stopped || this.#running) return;
    this.#running = true;
    try {
      this.#restorePendingTransactions();
      this.#notifyFinalized(this.#store.finalizeParsedReconciliationJobs());
      for (
        let index = 0;
        index < this.#concurrency && !this.#stopped;
        index += 1
      ) {
        const job = this.#store.claimParsedReconciliationJob(
          this.#finalityBufferSeconds,
        );
        if (!job) break;
        try {
          // Chain blockTime has one-second resolution. Round the start inward
          // so a transaction from the preceding second cannot enter the window.
          const from = Math.ceil(Date.parse(job.windowStartedAtUtc) / 1000);
          const to = Math.ceil(Date.parse(job.windowExpiresAtUtc) / 1000);
          const page = await this.#scan.scanMintWindow({
            mint: job.mint,
            fromUnixSeconds: from,
            toUnixSeconds: to,
            ...(job.paginationToken
              ? { paginationToken: job.paginationToken }
              : {}),
            maxScannedTransactions: this.#maxScannedTransactions,
          });
          const finalized = this.#store.saveParsedReconciliationPage({
            jobId: job.id,
            mint: job.mint,
            items: page.items,
            paginationToken: page.paginationToken,
            stoppedOn: page.stoppedOn,
            scannedThrough: page.scannedThrough,
            creditsCharged: page.creditsCharged,
            maxPages: this.#maxPagesPerJob,
          });
          this.#notifyFinalized(finalized);
          for (const item of page.items) {
            if (
              item.blockTime !== null &&
              !parsedScanEventWithinExactWindow({
                blockTime: item.blockTime,
                windowStartedAtUtc: job.windowStartedAtUtc,
                windowExpiresAtUtc: job.windowExpiresAtUtc,
              })
            ) {
              this.#notifyFinalized(
                this.#store.setParsedReconciliationTransactionStatus({
                  mint: job.mint,
                  signature: item.signature,
                  status: "IRRELEVANT",
                  reasonCode: "SCAN_EVENT_OUTSIDE_EXACT_OBSERVATION_WINDOW",
                }),
              );
              continue;
            }
            if (item.classification === "NON_TRADE") {
              this.#notifyFinalized(
                this.#store.setParsedReconciliationTransactionStatus({
                  mint: job.mint,
                  signature: item.signature,
                  status: "IRRELEVANT",
                  reasonCode:
                    item.reasonCode ?? "VERIFIED_NON_TRADE_PROGRAM_INSTRUCTION",
                }),
              );
              continue;
            }
            if (
              item.classification === "UNSUPPORTED" ||
              item.parsedMint !== job.mint ||
              item.blockTime === null ||
              item.slot < 0
            ) {
              this.#notifyFinalized(
                this.#store.setParsedReconciliationTransactionStatus({
                  mint: job.mint,
                  signature: item.signature,
                  status: "UNSUPPORTED",
                  reasonCode:
                    item.reasonCode ??
                    (item.parsedMint && item.parsedMint !== job.mint
                      ? "SCAN_MINT_MISMATCH"
                      : "SCAN_INSTRUCTION_UNSUPPORTED"),
                }),
              );
              continue;
            }
            const queued = this.#queue.enqueue({
              mint: job.mint,
              signature: item.signature,
              slot: item.slot,
              providerBlockTime: item.blockTime,
              expectedMint: item.parsedMint,
              expectedSide: item.expectedSide,
              logs: [],
              observedAtUtc: new Date().toISOString(),
              payloadRef: `parsed-scan:${createHash("sha256").update(item.signature).digest("hex")}`,
              windowStartedAtUtc: job.windowStartedAtUtc,
              windowExpiresAtUtc: job.windowExpiresAtUtc,
              reconnectCount: 0,
            });
            if (queued === "FULL")
              this.#notifyFinalized(
                this.#store.setParsedReconciliationTransactionStatus({
                  mint: job.mint,
                  signature: item.signature,
                  status: "FAILED",
                  reasonCode: "TRADE_VERIFICATION_QUEUE_FULL",
                }),
              );
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "PARSED_SCAN_FAILED";
          const permanent = [
            "PARSED_SCAN_ACCESS_DENIED",
            "PARSED_SCAN_HTTP_400",
            "MALFORMED_PARSED_SCAN_RESPONSE",
            "INCONSISTENT_SCAN_COMPLETION",
            "PARSED_SCAN_CHARGE_EXCEEDS_RESERVATION",
          ].some((code) => message.startsWith(code));
          if (permanent) {
            this.#store.failParsedReconciliationJob(
              job.id,
              message.slice(0, 96),
            );
            this.#onEvidence({
              mint: job.mint,
              triggerKey: `scan-failed:${job.id}:${message.slice(0, 96)}`,
            });
          } else {
            const terminal = this.#store.deferParsedReconciliationJob(
              job.id,
              message.slice(0, 96),
              retryDelay(job.attempts),
            );
            if (terminal)
              this.#onEvidence({
                mint: job.mint,
                triggerKey: `scan-retries-exhausted:${job.id}:${message.slice(0, 96)}`,
              });
          }
        }
      }
    } finally {
      this.#running = false;
      this.#schedule(1000);
    }
  }

  #notifyFinalized(items: ParsedReconciliationFinalization[]): void {
    for (const item of items)
      this.#onEvidence({
        mint: item.mint,
        triggerKey: `reconciliation:${item.jobId}:${item.status}`,
      });
  }
}

function retryDelay(attempt: number): number {
  const base = Math.min(120_000, 1000 * 2 ** Math.min(7, attempt));
  return base + Math.floor(Math.random() * Math.min(1000, base / 4));
}
