import { createHash } from "node:crypto";
import {
  base58Encode,
  CreatorReputationSchema,
  TokenRiskReportSchema,
  WalletRoleEvidenceSchema,
  utcNow,
} from "@sentinel/domain";
import type {
  CreatorReputation,
  QuoteResult,
  TokenRiskReport,
  WalletRoleEvidence,
} from "@sentinel/domain";
import {
  analyzeLaunchBehavior,
  decodePumpCreateEvents,
  extractDirectFundingTransfers,
  detectWalletTokenOutflows,
  transactionFeePayer,
  transactionSigners,
} from "@sentinel/intelligence";
import type { PumpCreateEvent } from "@sentinel/intelligence";
import {
  ProviderFailure,
  PumpCurveQuoteEngine,
  PumpCurveStateLoader,
  PumpSwapQuoteEngine,
  PumpSwapStateLoader,
  type HeliusRpcClient,
  type WalletTransaction,
} from "@sentinel/providers";
import type { JupiterQuoteClient } from "@sentinel/providers";
import type { AppConfig } from "@sentinel/config";
import {
  assessTestTokenMetadata,
  decodeMintAccount,
  ratioBps,
} from "@sentinel/security";
import { evaluateRiskDecision, validateExitQuotes } from "@sentinel/strategy";
import type { SentinelStore } from "@sentinel/storage";
import { log } from "./logger.ts";

type AnalysisJob = NonNullable<ReturnType<SentinelStore["claimAnalysisJob"]>>;
type HeliusErrorCode = string;

export type AnalysisOptions = {
  store: SentinelStore;
  helius: HeliusRpcClient | undefined;
  jupiter?: JupiterQuoteClient | undefined;
  config: AppConfig;
  configVersion: string;
  concurrency: number;
  now?: () => number;
};

type AnalysisEvidence = {
  txBySignature: Map<string, WalletTransaction>;
  verifiedCreateEvents: PumpCreateEvent[];
  roleEvidence: WalletRoleEvidence[];
  walletProfiles: CreatorReputation[];
  clusterWallets: Set<string>;
  asOfSlot: number | null;
  evidenceRefs: Set<string>;
  errors: Set<string>;
};

export class TokenAnalysisScheduler {
  readonly #store: SentinelStore;
  readonly #helius: HeliusRpcClient | undefined;
  readonly #jupiter: JupiterQuoteClient | undefined;
  readonly #pumpCurveState: PumpCurveStateLoader | undefined;
  readonly #pumpSwapState: PumpSwapStateLoader | undefined;
  readonly #pumpCurveQuotes = new PumpCurveQuoteEngine();
  readonly #pumpSwapQuotes = new PumpSwapQuoteEngine();
  readonly #config: AppConfig;
  readonly #configVersion: string;
  readonly #concurrency: number;
  readonly #now: () => number;
  readonly #active = new Set<Promise<void>>();
  readonly #walletRefreshLocks = new Map<string, Promise<void>>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #stopping = false;

  constructor(options: AnalysisOptions) {
    this.#store = options.store;
    this.#helius = options.helius;
    this.#jupiter = options.jupiter;
    this.#pumpCurveState = options.helius
      ? new PumpCurveStateLoader({
          helius: options.helius,
          ...(options.now ? { now: options.now } : {}),
        })
      : undefined;
    this.#pumpSwapState = options.helius
      ? new PumpSwapStateLoader({
          helius: options.helius,
          ...(options.now ? { now: options.now } : {}),
        })
      : undefined;
    this.#config = options.config;
    this.#configVersion = options.configVersion;
    this.#concurrency = options.concurrency;
    this.#now = options.now ?? Date.now;
  }

  start(): void {
    this.#store.recoverInterruptedAnalysisJobs();
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
      let job: AnalysisJob | null;
      try {
        job = this.#store.claimAnalysisJob();
      } catch (error) {
        log("error", "analysis.job_claim_failed", {
          errorCode: error instanceof Error ? error.name : "UNKNOWN_ERROR",
        });
        return;
      }
      if (!job) return;
      const task = this.#analyze(job).catch((error: unknown) => {
        log("error", "analysis.job_failed", {
          mint: job.mint,
          eventId: job.eventId,
          errorCode: error instanceof Error ? error.message : "UNKNOWN_ERROR",
        });
        this.#store.finishAnalysisJob(job.eventId, 1000);
      });
      this.#active.add(task);
      void task.finally(() => {
        this.#active.delete(task);
        this.#fill();
      });
    }
  }

  async #analyze(job: AnalysisJob): Promise<void> {
    const startedAt = this.#now();
    const event = this.#store.getMarketEventSummary(job.eventId);
    const token = this.#store.getToken(job.mint);
    if (!event || !token) {
      this.#store.finishAnalysisJob(job.eventId);
      return;
    }
    const evidence: AnalysisEvidence = {
      txBySignature: new Map(),
      verifiedCreateEvents: [],
      roleEvidence: [],
      walletProfiles: [],
      clusterWallets: new Set(),
      asOfSlot: event.slot,
      evidenceRefs: new Set([`market_event:${job.eventId}`]),
      errors: new Set(),
    };

    if (!event.monitoringEligible) {
      evidence.errors.add("TOKEN_OUTSIDE_MONITORING_BUDGET");
    } else if (this.#helius) {
      await this.#resolveLaunchRoles(event, evidence);
      if (evidence.asOfSlot !== null) {
        const identityWallets = unique([
          ...evidence.verifiedCreateEvents.map((item) => item.creator),
          ...evidence.verifiedCreateEvents.map((item) => item.user),
          event.creatorClaim,
          event.initiatorClaim,
        ]).slice(0, this.#config.analysis.creator_tracing_max_depth);
        for (const wallet of identityWallets) {
          const reputation = await this.#refreshWalletHistory(
            wallet,
            evidence.asOfSlot,
            evidence,
            startedAt,
          );
          if (reputation) evidence.walletProfiles.push(reputation);
          for (const linked of this.#store.listLinkedWallets(
            wallet,
            evidence.asOfSlot,
          ))
            evidence.clusterWallets.add(linked);
        }
      } else {
        evidence.errors.add("CHAIN_SLOT_UNKNOWN");
      }
    } else {
      evidence.errors.add("HELIUS_CREDENTIAL_MISSING");
    }

    const security = event.monitoringEligible
      ? await this.#securityReport(
          job.mint,
          evidence.verifiedCreateEvents.find((item) => item.mint === job.mint)
            ?.creator ?? token.creator,
          evidence.verifiedCreateEvents.find((item) => item.mint === job.mint)
            ?.user ?? token.launchInitiator,
          token.name,
          token.symbol,
          token.uri,
          evidence,
        )
      : this.#makeSecurityReport(
          `security:${hashId(job.eventId)}`,
          job.mint,
          decodeMintAccount(null, null),
          event.slot,
          null,
          null,
          0,
          new Set([
            "TOKEN_OUTSIDE_MONITORING_BUDGET",
            ...assessTestTokenMetadata({
              name: token.name,
              symbol: token.symbol,
              uri: token.uri,
            }).reasonCodes,
          ]),
          evidence,
        );
    this.#store.saveTokenRiskReport(security);

    const primaryWallet =
      evidence.verifiedCreateEvents.find((item) => item.mint === job.mint)
        ?.creator ?? token.creator;
    const reputation = primaryWallet
      ? this.#store.getCreatorReputation(
          primaryWallet,
          evidence.asOfSlot ?? undefined,
        )
      : null;
    const quotes =
      (this.#helius || this.#jupiter) &&
      event.monitoringEligible &&
      security.status === "SUPPORTED"
        ? await this.#quoteExit(job.mint, token.marketPhase)
        : { buy: null, sell: null };
    const exitValidation = validateExitQuotes({
      ...quotes,
      maximumAgeMs: this.#config.providers.jupiter.max_quote_age_ms,
      maximumPriceImpactBps: this.#config.risk.max_price_impact_bps,
      minimumExitAmountRaw: "1",
    });
    for (const reference of exitValidation.evidenceRefs)
      evidence.evidenceRefs.add(`market_quote:${reference}`);
    for (const reason of exitValidation.reasonCodes)
      evidence.errors.add(reason);
    const launchBehavior = this.#buildLaunchBehavior(
      job.mint,
      token.firstSeenAtUtc,
      evidence,
      token.name,
      token.symbol,
      token.uri,
    );
    if (launchBehavior) {
      this.#store.saveLaunchBehaviorSnapshot(launchBehavior);
      evidence.evidenceRefs.add(`launch_behavior:${launchBehavior.id}`);
    }
    const decision = evaluateRiskDecision({
      mint: job.mint,
      configVersion: this.#configVersion,
      security,
      creator: reputation,
      marketPhase: token.marketPhase,
      exitValidation,
      startedAtMs: startedAt,
      nowMs: this.#now(),
      supportingEvidenceRefs: [...evidence.evidenceRefs],
      analysisReasonCodes: [...evidence.errors],
      minimumHolderSampleCoverageBps:
        this.#config.analysis.min_holder_sample_coverage_bps,
      minimumIndependentBuyers: this.#config.analysis.min_independent_buyers,
      launchBehavior,
    });
    this.#store.saveRiskDecision(decision);
    if (decision.status === "BUY_ELIGIBLE") {
      this.#store.saveDryRunTradeIntent({
        id: `dry-run:${decision.id}:BUY`,
        mint: job.mint,
        side: "BUY",
        decisionId: decision.id,
        reasonCodes: decision.reasonCodes,
        createdAtUtc: decision.decidedAtUtc,
      });
    }
    const refreshNeeded =
      Boolean(this.#helius) &&
      event.monitoringEligible &&
      (evidence.walletProfiles.some((profile) => !profile.historyComplete) ||
        security.status === "MISSING");
    const retryDelayMs = refreshNeeded
      ? Math.min(3_600_000, 30_000 * 2 ** Math.min(job.attempts - 1, 7))
      : 0;
    this.#store.finishAnalysisJob(job.eventId, retryDelayMs);
    log("info", "analysis.report.persisted", {
      mint: job.mint,
      eventId: job.eventId,
      decision: decision.status,
      securityStatus: security.status,
      evidenceCount: evidence.evidenceRefs.size,
      latencyMs: decision.latencyMs,
    });
  }

  #buildLaunchBehavior(
    mint: string,
    firstSeenAtUtc: string,
    evidence: AnalysisEvidence,
    name: string | null,
    symbol: string | null,
    uri: string | null,
  ) {
    const nowMs = this.#now();
    const observedAtUtc = new Date(nowMs).toISOString();
    const windowSeconds =
      this.#config.providers.pumpportal.observation_window_seconds;
    const windowEndMs = Date.parse(firstSeenAtUtc) + windowSeconds * 1000;
    const effectiveEndUtc = new Date(
      Math.min(nowMs, windowEndMs),
    ).toISOString();
    const observations = this.#store.listLaunchTradeObservations(
      mint,
      firstSeenAtUtc,
      effectiveEndUtc,
      evidence.asOfSlot,
    );
    if (observations.length === 0) return null;

    const verifiedCreators = evidence.verifiedCreateEvents
      .filter((item) => item.mint === mint)
      .flatMap((item) => [item.creator, item.user]);
    const metadataLikelyTest =
      assessTestTokenMetadata({
        name,
        symbol,
        uri,
      }).classification === "LIKELY_TEST";
    return analyzeLaunchBehavior({
      mint,
      observations,
      creatorWallets: unique(verifiedCreators),
      linkedWallets: [...evidence.clusterWallets],
      windowStartedAtUtc: firstSeenAtUtc,
      observedAtUtc,
      windowSeconds,
      throughSlot: evidence.asOfSlot,
      // Stored trades do not prove uninterrupted subscription coverage. Keep
      // the snapshot incomplete until a provider coverage record exists.
      complete: false,
      gapReason: "TRADE_STREAM_COMPLETENESS_UNVERIFIED",
      minIndependentBuyers: this.#config.analysis.min_independent_buyers,
      metadataLikelyTest,
    });
  }

  async #quoteExit(
    mint: string,
    marketPhase: string,
  ): Promise<{
    buy: QuoteResult | null;
    sell: QuoteResult | null;
  }> {
    const inputAmountRaw = solToLamports(this.#config.risk.max_trade_sol);
    const requestedAtUtc = new Date(this.#now()).toISOString();
    if (marketPhase === "MIGRATED_PUMPSWAP" && this.#pumpSwapState) {
      const loaded = await this.#pumpSwapState.load(mint);
      if (loaded.status !== "SUPPORTED") {
        log("warn", "analysis.pumpswap_state_unavailable", {
          mint,
          errorCode: loaded.reasonCode,
        });
        return { buy: null, sell: null };
      }
      const buy = this.#pumpSwapQuotes.quote(
        {
          mint,
          direction: "BUY",
          exactInputAmountRaw: inputAmountRaw,
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: mint,
          maxAgeMs: this.#config.security.max_snapshot_age_ms,
          requestedAtUtc,
        },
        loaded.state,
      );
      this.#store.saveQuoteResult(buy);
      if (buy.validationStatus !== "PASS" || !buy.expectedOutputAmountRaw)
        return { buy, sell: null };
      const sell = this.#pumpSwapQuotes.quote(
        {
          mint,
          direction: "SELL",
          exactInputAmountRaw: buy.expectedOutputAmountRaw,
          inputMint: mint,
          outputMint: "So11111111111111111111111111111111111111112",
          maxAgeMs: this.#config.security.max_snapshot_age_ms,
          requestedAtUtc: new Date(this.#now()).toISOString(),
        },
        loaded.state,
      );
      this.#store.saveQuoteResult(sell);
      return { buy, sell };
    }
    if (marketPhase === "PUMP_CURVE" && this.#pumpCurveState) {
      const loaded = await this.#pumpCurveState.load(mint);
      if (loaded.status !== "SUPPORTED") {
        log("warn", "analysis.pump_curve_state_unavailable", {
          mint,
          errorCode: loaded.reasonCode,
        });
        return { buy: null, sell: null };
      }
      const buy = this.#pumpCurveQuotes.quote(
        {
          mint,
          direction: "BUY",
          exactInputAmountRaw: inputAmountRaw,
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: mint,
          maxAgeMs: this.#config.security.max_snapshot_age_ms,
          requestedAtUtc,
        },
        loaded.state,
      );
      this.#store.saveQuoteResult(buy);
      if (buy.validationStatus !== "PASS" || !buy.expectedOutputAmountRaw)
        return { buy, sell: null };
      const sell = this.#pumpCurveQuotes.quote(
        {
          mint,
          direction: "SELL",
          exactInputAmountRaw: buy.expectedOutputAmountRaw,
          inputMint: mint,
          outputMint: "So11111111111111111111111111111111111111112",
          maxAgeMs: this.#config.security.max_snapshot_age_ms,
          requestedAtUtc: new Date(this.#now()).toISOString(),
        },
        loaded.state,
      );
      this.#store.saveQuoteResult(sell);
      return { buy, sell };
    }
    try {
      const buy = await this.#jupiter!.quote({
        mint,
        direction: "BUY",
        exactInputAmountRaw: inputAmountRaw,
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: mint,
        maxAgeMs: this.#config.providers.jupiter.max_quote_age_ms,
        requestedAtUtc,
      });
      this.#store.saveQuoteResult(buy);
      if (!buy.expectedOutputAmountRaw || buy.expectedOutputAmountRaw === "0")
        return { buy, sell: null };
      const sell = await this.#jupiter!.quote({
        mint,
        direction: "SELL",
        exactInputAmountRaw: buy.expectedOutputAmountRaw,
        inputMint: mint,
        outputMint: "So11111111111111111111111111111111111111112",
        maxAgeMs: this.#config.providers.jupiter.max_quote_age_ms,
        requestedAtUtc: new Date(this.#now()).toISOString(),
      });
      this.#store.saveQuoteResult(sell);
      return { buy, sell };
    } catch (error) {
      log("warn", "analysis.quote_failed", {
        mint,
        errorCode: providerError(error),
      });
      return { buy: null, sell: null };
    }
  }

  async #resolveLaunchRoles(
    event: NonNullable<ReturnType<SentinelStore["getMarketEventSummary"]>>,
    evidence: AnalysisEvidence,
  ): Promise<void> {
    if (event.signature) {
      try {
        const transaction = await this.#helius!.getTransaction(event.signature);
        if (!transaction) evidence.errors.add("LAUNCH_TRANSACTION_UNAVAILABLE");
        else if (
          !transaction.succeeded ||
          transaction.signature !== event.signature ||
          (event.slot !== null && transaction.slot !== event.slot)
        ) {
          evidence.errors.add("LAUNCH_TRANSACTION_CONTRADICTS_EVENT");
        } else {
          evidence.asOfSlot = transaction.slot;
          evidence.txBySignature.set(transaction.signature, transaction);
          evidence.evidenceRefs.add(
            `solana_transaction:${transaction.signature}`,
          );
          evidence.verifiedCreateEvents = decodePumpCreateEvents(
            transaction.logMessages,
          ).filter((create) => create.mint === event.mint);
          if (
            event.kind === "TOKEN_CREATED" &&
            evidence.verifiedCreateEvents.length === 0
          )
            evidence.errors.add("PUMP_CREATE_EVENT_UNVERIFIED");
          for (const create of evidence.verifiedCreateEvents) {
            if (event.creatorClaim && event.creatorClaim !== create.creator)
              evidence.errors.add("PROVIDER_CREATOR_CLAIM_MISMATCH");
            if (event.initiatorClaim && event.initiatorClaim !== create.user)
              evidence.errors.add("PROVIDER_INITIATOR_CLAIM_MISMATCH");
            const observedAtUtc = transaction.blockTime
              ? new Date(transaction.blockTime * 1000).toISOString()
              : utcNow();
            this.#saveRoleEvidence(
              {
                mint: event.mint,
                wallet: create.creator,
                role: "CLAIMED_CREATOR",
                source: "PUMP_IDL_CREATE_EVENT",
                signature: transaction.signature,
                slot: transaction.slot,
                observedAtUtc,
                confidenceBps: 10000,
                reasonCode: "PUMP_CREATE_EVENT_CREATOR",
              },
              evidence,
            );
            this.#saveRoleEvidence(
              {
                mint: event.mint,
                wallet: create.user,
                role: "LAUNCH_INITIATOR",
                source: "PUMP_IDL_CREATE_EVENT",
                signature: transaction.signature,
                slot: transaction.slot,
                observedAtUtc,
                confidenceBps: 10000,
                reasonCode: "PUMP_CREATE_EVENT_USER",
              },
              evidence,
            );
            this.#store.saveCreatorLaunch({
              creator: create.creator,
              mint: create.mint,
              signature: transaction.signature,
              slot: transaction.slot,
              blockTimeSeconds: transaction.blockTime,
              observedAtUtc,
              confidenceBps: 10000,
              idlRevision:
                "pump-public-docs:CreateEvent:27,114,169,77,222,235,99,118",
            });
          }
          const payer = transactionFeePayer(transaction);
          if (payer)
            this.#saveRoleEvidence(
              {
                mint: event.mint,
                wallet: payer,
                role: "FEE_PAYER",
                source: "SOLANA_RPC",
                signature: transaction.signature,
                slot: transaction.slot,
                observedAtUtc: transaction.blockTime
                  ? new Date(transaction.blockTime * 1000).toISOString()
                  : utcNow(),
                confidenceBps: 10000,
                reasonCode: "FIRST_REQUIRED_SIGNER_FEE_PAYER",
              },
              evidence,
            );
        }
      } catch (error) {
        evidence.errors.add(providerError(error));
      }
    } else {
      evidence.errors.add("LAUNCH_SIGNATURE_MISSING");
    }
    const observedAtUtc = event.receivedAtUtc;
    if (event.creatorClaim)
      this.#saveRoleEvidence(
        {
          mint: event.mint,
          wallet: event.creatorClaim,
          role: "CLAIMED_CREATOR",
          source: "PUMPPORTAL_CLAIM",
          signature: event.signature,
          slot: event.slot,
          observedAtUtc,
          confidenceBps: 5000,
          reasonCode: "PROVIDER_CREATOR_CLAIM_UNVERIFIED",
        },
        evidence,
      );
    if (event.initiatorClaim)
      this.#saveRoleEvidence(
        {
          mint: event.mint,
          wallet: event.initiatorClaim,
          role: "LAUNCH_INITIATOR",
          source: "PUMPPORTAL_CLAIM",
          signature: event.signature,
          slot: event.slot,
          observedAtUtc,
          confidenceBps: 5000,
          reasonCode: "PROVIDER_INITIATOR_CLAIM_UNVERIFIED",
        },
        evidence,
      );
  }

  #saveRoleEvidence(
    input: Omit<WalletRoleEvidence, "id">,
    evidence: AnalysisEvidence,
  ): void {
    const id = hashId(
      `${input.mint}|${input.wallet}|${input.role}|${input.source}|${input.signature ?? ""}|${input.reasonCode}`,
    );
    const value = WalletRoleEvidenceSchema.parse({ ...input, id });
    this.#store.saveWalletRoleEvidence(value);
    evidence.roleEvidence.push(value);
    evidence.evidenceRefs.add(`wallet_role_evidence:${id}`);
  }

  async #refreshWalletHistory(
    wallet: string,
    asOfSlot: number,
    evidence: AnalysisEvidence,
    startedAt: number,
  ): Promise<CreatorReputation | null> {
    const previous = this.#walletRefreshLocks.get(wallet) ?? Promise.resolve();
    let release = (): void => undefined;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#walletRefreshLocks.set(wallet, lock);
    await previous;
    try {
      return await this.#refreshWalletHistoryLocked(
        wallet,
        asOfSlot,
        evidence,
        startedAt,
      );
    } finally {
      release();
      if (this.#walletRefreshLocks.get(wallet) === lock)
        this.#walletRefreshLocks.delete(wallet);
    }
  }

  async #refreshWalletHistoryLocked(
    wallet: string,
    asOfSlot: number,
    evidence: AnalysisEvidence,
    startedAt: number,
  ): Promise<CreatorReputation | null> {
    const existingRefresh = this.#store.getWalletHistoryRefresh(
      wallet,
      asOfSlot,
    );
    const cached = this.#store.getCreatorReputation(wallet, asOfSlot);
    if (
      existingRefresh &&
      existingRefresh.asOfSlot >= asOfSlot &&
      Date.parse(existingRefresh.freshUntilUtc) > this.#now() &&
      cached
    )
      return cached;

    const sameAsOf = existingRefresh?.asOfSlot === asOfSlot;
    let beforeSignature = sameAsOf ? existingRefresh.beforeSignature : null;
    let scannedCount = sameAsOf ? existingRefresh.scannedCount : 0;
    let historyComplete = sameAsOf && existingRefresh.historyComplete;
    let refreshError: string | null = null;
    const pageSize = this.#config.analysis.creator_history_page_size;
    const maxTransactions =
      this.#config.analysis.creator_history_max_transactions;
    let pages = 0;

    while (
      !historyComplete &&
      scannedCount < maxTransactions &&
      pages < Math.ceil(maxTransactions / pageSize) + 1 &&
      this.#now() - startedAt < this.#config.analysis.max_analysis_ms
    ) {
      pages += 1;
      const requestLimit = Math.min(pageSize, maxTransactions - scannedCount);
      let signatures;
      try {
        signatures = await this.#helius!.getSignaturesForAddress(wallet, {
          limit: requestLimit,
          ...(beforeSignature ? { before: beforeSignature } : {}),
        });
      } catch (error) {
        refreshError = providerError(error);
        evidence.errors.add(refreshError);
        break;
      }
      if (signatures.length === 0) {
        historyComplete = true;
        beforeSignature = null;
        break;
      }
      let lastSuccessCursor = beforeSignature;
      let pageFailed = false;
      for (const item of signatures) {
        if (this.#now() - startedAt >= this.#config.analysis.max_analysis_ms) {
          refreshError = "ANALYSIS_TIME_BUDGET_EXHAUSTED";
          pageFailed = true;
          break;
        }
        if (item.slot <= asOfSlot) {
          let transaction: WalletTransaction | null | undefined =
            evidence.txBySignature.get(item.signature);
          if (transaction === undefined) {
            try {
              transaction = await this.#helius!.getTransaction(item.signature);
            } catch (error) {
              refreshError = providerError(error);
              pageFailed = true;
              break;
            }
          }
          if (!transaction || transaction.slot !== item.slot) {
            refreshError = "HISTORICAL_TRANSACTION_UNAVAILABLE";
            pageFailed = true;
            break;
          }
          this.#persistTransaction(wallet, transaction);
          evidence.evidenceRefs.add(`helius_transaction:${item.signature}`);
          this.#ingestTransactionEvidence(wallet, transaction, evidence);
        }
        lastSuccessCursor = item.signature;
        scannedCount += 1;
      }
      if (pageFailed) {
        beforeSignature = lastSuccessCursor;
        evidence.errors.add(refreshError ?? "HISTORY_PAGE_INCOMPLETE");
        break;
      }
      beforeSignature = signatures[signatures.length - 1]?.signature ?? null;
      if (signatures.length < requestLimit) {
        historyComplete = true;
        beforeSignature = null;
      }
      this.#store.saveWalletHistoryRefresh({
        wallet,
        asOfSlot,
        beforeSignature,
        scannedCount,
        historyComplete,
        fetchedAtUtc: utcNow(),
        freshUntilUtc: new Date(
          this.#now() +
            this.#config.analysis.creator_history_cache_ttl_seconds * 1000,
        ).toISOString(),
        errorCode: refreshError,
      });
    }
    if (scannedCount >= maxTransactions && !historyComplete) {
      refreshError ??= "HISTORY_TRANSACTION_LIMIT_REACHED";
      evidence.errors.add(refreshError);
    }
    if (this.#now() - startedAt >= this.#config.analysis.max_analysis_ms) {
      refreshError ??= "ANALYSIS_TIME_BUDGET_EXHAUSTED";
      evidence.errors.add(refreshError);
    }
    const cacheTtlSeconds =
      refreshError || !historyComplete
        ? Math.min(30, this.#config.analysis.creator_history_cache_ttl_seconds)
        : this.#config.analysis.creator_history_cache_ttl_seconds;
    this.#store.saveWalletHistoryRefresh({
      wallet,
      asOfSlot,
      beforeSignature,
      scannedCount,
      historyComplete,
      fetchedAtUtc: utcNow(),
      freshUntilUtc: new Date(
        this.#now() + cacheTtlSeconds * 1000,
      ).toISOString(),
      errorCode: refreshError,
    });

    const launches = this.#store.listCreatorLaunches(wallet, asOfSlot);
    const indicators = new Set<string>();
    const launchWindowMs =
      this.#config.analysis.suspicious_launch_window_seconds * 1000;
    const timestamps = launches
      .map((launch) => launch.blockTimeSeconds)
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    let rapidLaunchPattern = false;
    for (let index = 0; index < timestamps.length; index += 1) {
      const start = timestamps[index];
      if (start === undefined) continue;
      const count = timestamps.filter(
        (stamp) => stamp >= start && stamp <= start + launchWindowMs / 1000,
      ).length;
      if (count >= this.#config.analysis.suspicious_launch_count) {
        rapidLaunchPattern = true;
        break;
      }
    }
    if (rapidLaunchPattern) indicators.add("RAPID_REPEATED_LAUNCHES");
    const repeatedCosignerLinks = this.#store
      .getWalletLinks(wallet)
      .filter(
        (link) =>
          link["relationType"] === "REPEATED_COSIGNER" &&
          Number(link["confidenceBps"]) >= 8000 &&
          Number(link["slot"]) <= asOfSlot,
      );
    if (repeatedCosignerLinks.length > 0)
      indicators.add("REPEATED_COSIGNER_NETWORK");
    const walletOutflows = this.#store.listWalletTokenOutflows(
      wallet,
      asOfSlot,
    );
    const outflowCounts = new Map<string, number>();
    for (const outflow of walletOutflows) {
      const mint = String(outflow["mint"]);
      outflowCounts.set(mint, (outflowCounts.get(mint) ?? 0) + 1);
    }
    if ([...outflowCounts.values()].some((count) => count >= 2))
      indicators.add("REPEATED_WALLET_TOKEN_OUTFLOWS");
    const evidenceRefs = [
      ...launches.map((launch) => `solana_transaction:${launch.signature}`),
      ...walletOutflows.map(
        (outflow) => `wallet_token_outflow:${String(outflow["id"])}`,
      ),
      ...repeatedCosignerLinks.map(
        (link) => `wallet_link:${String(link["id"])}`,
      ),
    ];
    const complete = historyComplete && refreshError === null;
    const nowUtc = new Date(this.#now()).toISOString();
    const reputation = CreatorReputationSchema.parse({
      wallet,
      status:
        indicators.size > 0
          ? "SUSPICIOUS"
          : launches.length > 0
            ? "KNOWN"
            : "UNKNOWN",
      launchesObserved: launches.length,
      suspiciousIndicators: [...indicators].sort(),
      confidenceBps: launches.length === 0 ? 0 : complete ? 8500 : 5000,
      historyComplete: complete,
      asOfSlot,
      computedAtUtc: nowUtc,
      freshUntilUtc: new Date(
        this.#now() + cacheTtlSeconds * 1000,
      ).toISOString(),
      evidenceRefs,
    });
    this.#store.saveCreatorReputation(reputation);
    return reputation;
  }

  #persistTransaction(wallet: string, tx: WalletTransaction): void {
    const fundingTransfers = extractDirectFundingTransfers(tx);
    const summary = JSON.stringify({
      signature: tx.signature,
      slot: tx.slot,
      blockTime: tx.blockTime,
      succeeded: tx.succeeded,
      feeLamportsRaw: String(tx.feeLamports),
      signers: transactionSigners(tx).slice(0, 16),
      fundingTransfers: fundingTransfers.slice(0, 16),
      createEvents: decodePumpCreateEvents(tx.logMessages).slice(0, 8),
    });
    this.#store.saveWalletTransaction({
      wallet,
      signature: tx.signature,
      slot: tx.slot,
      blockTimeSeconds: tx.blockTime,
      fetchedAtUtc: utcNow(),
      succeeded: tx.succeeded,
      feeLamportsRaw: String(tx.feeLamports),
      confidenceBps: 10000,
      reasonCode: "FINALIZED_HELIUS_TRANSACTION",
      sanitizedTransactionJson: summary,
    });
  }

  #ingestTransactionEvidence(
    queriedWallet: string,
    transaction: WalletTransaction,
    evidence: AnalysisEvidence,
  ): void {
    if (!transaction.succeeded) return;
    for (const outflow of detectWalletTokenOutflows(
      queriedWallet,
      transaction,
    )) {
      const id = hashId(
        `${outflow.wallet}|${outflow.mint}|${outflow.signature}|${outflow.reasonCode}`,
      );
      this.#store.saveWalletTokenOutflow({ id, ...outflow });
      evidence.evidenceRefs.add(`wallet_token_outflow:${id}`);
    }
    const observedAtUtc = transaction.blockTime
      ? new Date(transaction.blockTime * 1000).toISOString()
      : utcNow();
    const creates = decodePumpCreateEvents(transaction.logMessages);
    for (const create of creates) {
      const ref = `solana_transaction:${transaction.signature}`;
      evidence.evidenceRefs.add(ref);
      this.#store.saveCreatorLaunch({
        creator: create.creator,
        mint: create.mint,
        signature: transaction.signature,
        slot: transaction.slot,
        blockTimeSeconds: transaction.blockTime,
        observedAtUtc,
        confidenceBps: 10000,
        idlRevision:
          "pump-public-docs:CreateEvent:27,114,169,77,222,235,99,118",
      });
      if (create.creator === queriedWallet)
        this.#saveRoleEvidence(
          {
            mint: create.mint,
            wallet: create.creator,
            role: "CLAIMED_CREATOR",
            source: "PUMP_IDL_CREATE_EVENT",
            signature: transaction.signature,
            slot: transaction.slot,
            observedAtUtc,
            confidenceBps: 10000,
            reasonCode: "HISTORICAL_PUMP_CREATE_EVENT_CREATOR",
          },
          evidence,
        );
    }
    const transfers = extractDirectFundingTransfers(transaction);
    for (const transfer of transfers) {
      if (
        transfer.source !== queriedWallet &&
        transfer.destination !== queriedWallet
      )
        continue;
      this.#store.saveWalletLink({
        id: hashId(
          `${transfer.source}|${transfer.destination}|${transaction.signature}|DIRECT_FUNDING`,
        ),
        sourceWallet: transfer.source,
        destinationWallet: transfer.destination,
        relationType: "DIRECT_FUNDING",
        signature: transaction.signature,
        slot: transaction.slot,
        observedAtUtc,
        amountLamportsRaw: transfer.lamportsRaw,
        confidenceBps: 3500,
        reasonCode: "OBSERVED_DIRECT_SYSTEM_TRANSFER_NO_OWNERSHIP_CLAIM",
      });
    }
    const signers = transactionSigners(transaction)
      .filter((signer) => signer !== queriedWallet)
      .slice(0, 16);
    for (const signer of signers) {
      const pair = [queriedWallet, signer].sort();
      const sourceWallet = pair[0];
      const destinationWallet = pair[1];
      if (!sourceWallet || !destinationWallet) continue;
      const evidenceCount =
        this.#store.countSharedCosignerEvidence(
          queriedWallet,
          signer,
          transaction.slot,
        ) + 1;
      const confidenceBps = Math.min(
        9500,
        4500 + Math.max(0, evidenceCount - 1) * 2000,
      );
      this.#store.saveWalletLink({
        id: hashId(
          `${sourceWallet}|${destinationWallet}|${transaction.signature}|REPEATED_COSIGNER`,
        ),
        sourceWallet,
        destinationWallet,
        relationType: "REPEATED_COSIGNER",
        signature: transaction.signature,
        slot: transaction.slot,
        observedAtUtc,
        amountLamportsRaw: null,
        confidenceBps,
        reasonCode:
          evidenceCount >= 3
            ? "REPEATED_COSIGNING_RELATION_NOT_OWNERSHIP"
            : "SINGLE_COSIGNING_RELATION_NOT_OWNERSHIP",
      });
    }
  }

  async #securityReport(
    mint: string,
    creator: string | null,
    initiator: string | null,
    name: string | null,
    symbol: string | null,
    uri: string | null,
    evidence: AnalysisEvidence,
  ): Promise<TokenRiskReport> {
    const securityStartedAt = this.#now();
    const reasons = new Set<string>();
    const testToken = assessTestTokenMetadata({ name, symbol, uri });
    for (const reason of testToken.reasonCodes) reasons.add(reason);
    const nowUtc = new Date(this.#now()).toISOString();
    const id = `security:${hashId(`${mint}|${nowUtc}|${this.#configVersion}`)}`;
    const creatorWallets = new Set(
      [creator, initiator].filter((x): x is string => Boolean(x)),
    );
    if (!this.#helius) {
      reasons.add("HELIUS_CREDENTIAL_MISSING");
      return TokenRiskReportSchema.parse({
        id,
        mint,
        status: "MISSING",
        programId: null,
        mintAuthority: null,
        freezeAuthority: null,
        supplyRaw: null,
        decimals: null,
        extensions: [],
        topHolderConcentrationBps: null,
        creatorConcentrationRaw: null,
        clusterConcentrationRaw: null,
        holderSampleCount: 0,
        holderSampleComplete: false,
        holderSampleCoverageBps: null,
        holderSampleValidated: false,
        testTokenClassification: testToken.classification,
        testTokenConfidenceBps: testToken.confidenceBps,
        reasonCodes: [...reasons],
        source: "HELIUS_RPC",
        asOfSlot: null,
        observedAtUtc: nowUtc,
        confidenceBps: 0,
        evidenceRefs: [...evidence.evidenceRefs],
      });
    }
    let accountResult;
    try {
      accountResult = await this.#helius.getAccountInfo(mint);
    } catch (error) {
      reasons.add(`MINT_ACCOUNT_${providerError(error)}`);
      const missing = decodeMintAccount(null, null);
      return this.#makeSecurityReport(
        id,
        mint,
        missing,
        null,
        null,
        null,
        0,
        reasons,
        evidence,
      );
    }
    if (!accountResult.account) {
      const missing = decodeMintAccount(null, null);
      return this.#makeSecurityReport(
        id,
        mint,
        missing,
        accountResult.slot,
        null,
        null,
        0,
        new Set(["MINT_ACCOUNT_NOT_FOUND"]),
        evidence,
      );
    }
    const decoded = decodeMintAccount(
      accountResult.account.owner,
      accountResult.account.dataBase64,
    );
    for (const reason of decoded.reasonCodes) reasons.add(reason);
    evidence.evidenceRefs.add(`helius_account:${mint}:${accountResult.slot}`);
    for (const [wallet, role, reasonCode] of [
      [decoded.mintAuthority, "MINT_AUTHORITY", "ACTIVE_MINT_AUTHORITY"],
      [decoded.freezeAuthority, "FREEZE_AUTHORITY", "ACTIVE_FREEZE_AUTHORITY"],
    ] as const) {
      if (!wallet) continue;
      this.#saveRoleEvidence(
        {
          mint,
          wallet,
          role,
          source: "SOLANA_RPC",
          signature: null,
          slot: accountResult.slot,
          observedAtUtc: new Date(this.#now()).toISOString(),
          confidenceBps: 10000,
          reasonCode,
        },
        evidence,
      );
    }

    let supply: Awaited<ReturnType<HeliusRpcClient["getTokenSupply"]>> | null =
      null;
    let largest: Awaited<
      ReturnType<HeliusRpcClient["getTokenLargestAccounts"]>
    > | null = null;
    const [supplyResult, largestResult] = await Promise.allSettled([
      this.#helius.getTokenSupply(mint),
      this.#helius.getTokenLargestAccounts(mint),
    ]);
    if (supplyResult.status === "fulfilled") supply = supplyResult.value;
    else reasons.add(`TOKEN_SUPPLY_${providerError(supplyResult.reason)}`);
    if (largestResult.status === "fulfilled") largest = largestResult.value;
    else reasons.add(`LARGEST_ACCOUNTS_${providerError(largestResult.reason)}`);

    let topHolderConcentrationBps: number | null = null;
    let creatorConcentrationRaw: string | null = null;
    let clusterConcentrationRaw: string | null = null;
    let sampleCount = 0;
    let holderOwnersValidated = false;
    let holderSampleCoverageBps: number | null = null;
    let minSlot = accountResult.slot;
    let maxSlot = accountResult.slot;
    if (supply) {
      minSlot = Math.min(minSlot, supply.slot);
      maxSlot = Math.max(maxSlot, supply.slot);
      if (decoded.supplyRaw !== null && decoded.supplyRaw !== supply.amountRaw)
        reasons.add("MINT_SUPPLY_SNAPSHOT_MISMATCH");
    }
    if (largest && supply) {
      minSlot = Math.min(minSlot, largest.slot);
      maxSlot = Math.max(maxSlot, largest.slot);
      if (largest.accounts.length === 0 && BigInt(supply.amountRaw) > 0n)
        reasons.add("HOLDER_DISTRIBUTION_EMPTY");
      const accounts = largest.accounts.slice(
        0,
        this.#config.security.max_holder_accounts,
      );
      sampleCount = accounts.length;
      const holderInfos =
        accounts.length > 0
          ? await this.#helius
              .getMultipleAccounts(accounts.map((account) => account.address))
              .catch((error: unknown) => {
                reasons.add(`HOLDER_ACCOUNTS_${providerError(error)}`);
                return null;
              })
          : null;
      if (holderInfos) {
        minSlot = Math.min(minSlot, holderInfos.slot);
        maxSlot = Math.max(maxSlot, holderInfos.slot);
        let sampledTotal = 0n;
        let creatorTotal = 0n;
        let clusterTotal = 0n;
        let ownerResultsComplete = true;
        const clusterWallets = new Set(evidence.clusterWallets);
        if (creator) clusterWallets.add(creator);
        if (initiator) clusterWallets.add(initiator);
        for (let index = 0; index < accounts.length; index += 1) {
          const account = accounts[index];
          const info = holderInfos.accounts[index];
          if (!account || !info || !info.dataBase64) {
            ownerResultsComplete = false;
            continue;
          }
          const holding = decodeTokenHolding(
            info.dataBase64,
            mint,
            account.amountRaw,
          );
          if (!holding) {
            ownerResultsComplete = false;
            reasons.add("HOLDER_ACCOUNT_DATA_UNSUPPORTED");
            continue;
          }
          sampledTotal += holding.amount;
          if (creatorWallets.has(holding.owner)) creatorTotal += holding.amount;
          if (clusterWallets.has(holding.owner)) clusterTotal += holding.amount;
        }
        topHolderConcentrationBps = ratioBps(
          sampledTotal,
          BigInt(supply.amountRaw),
        );
        if (ownerResultsComplete) {
          holderSampleCoverageBps = topHolderConcentrationBps;
          creatorConcentrationRaw = creatorTotal.toString();
          clusterConcentrationRaw = clusterTotal.toString();
          holderOwnersValidated = true;
        } else {
          reasons.add("CREATOR_CLUSTER_HOLDER_CONCENTRATION_UNKNOWN");
        }
      }
    }
    if (!supply) reasons.add("TOKEN_SUPPLY_UNKNOWN");
    if (!largest) reasons.add("HOLDER_DISTRIBUTION_UNKNOWN");
    if (largest && largest.accounts.length > 0 && !holderOwnersValidated)
      reasons.add("HOLDER_OWNER_DATA_UNKNOWN");
    if (largest && largest.accounts.length === 0 && supply?.amountRaw === "0")
      holderOwnersValidated = true;
    if (maxSlot - minSlot > this.#config.security.max_snapshot_slot_skew)
      reasons.add("SNAPSHOT_SLOT_SKEW_EXCEEDED");
    const snapshotAgeMs = this.#now() - securityStartedAt;
    if (snapshotAgeMs > this.#config.security.max_snapshot_age_ms)
      reasons.add("SECURITY_SNAPSHOT_STALE");
    evidence.evidenceRefs.add(
      `helius_mint_account:${mint}:${accountResult.slot}`,
    );
    const criticalSnapshotMissing = [
      "TOKEN_SUPPLY_UNKNOWN",
      "HOLDER_DISTRIBUTION_UNKNOWN",
      "HOLDER_DISTRIBUTION_EMPTY",
      "HOLDER_OWNER_DATA_UNKNOWN",
      "CREATOR_CLUSTER_HOLDER_CONCENTRATION_UNKNOWN",
      "HOLDER_ACCOUNT_DATA_UNSUPPORTED",
      "MINT_SUPPLY_SNAPSHOT_MISMATCH",
      "SNAPSHOT_SLOT_SKEW_EXCEEDED",
      "SECURITY_SNAPSHOT_STALE",
    ].some((reason) => reasons.has(reason));
    const reportStatus =
      decoded.status === "SUPPORTED" && criticalSnapshotMissing
        ? "MISSING"
        : decoded.status;
    return TokenRiskReportSchema.parse({
      id,
      mint,
      status: reportStatus,
      programId: decoded.programId,
      mintAuthority: decoded.mintAuthority,
      freezeAuthority: decoded.freezeAuthority,
      supplyRaw: supply?.amountRaw ?? decoded.supplyRaw,
      decimals: supply?.decimals ?? decoded.decimals,
      extensions: decoded.extensions,
      topHolderConcentrationBps,
      creatorConcentrationRaw,
      clusterConcentrationRaw,
      holderSampleCount: sampleCount,
      holderSampleComplete: false,
      holderSampleCoverageBps,
      holderSampleValidated: holderOwnersValidated,
      testTokenClassification: testToken.classification,
      testTokenConfidenceBps: testToken.confidenceBps,
      reasonCodes: [...new Set([...reasons, ...evidence.errors])].sort(),
      source: "HELIUS_RPC",
      asOfSlot: minSlot,
      observedAtUtc: nowUtc,
      confidenceBps:
        decoded.status !== "SUPPORTED"
          ? decoded.confidenceBps
          : criticalSnapshotMissing
            ? 5000
            : decoded.confidenceBps === 10000 &&
                supply &&
                largest &&
                topHolderConcentrationBps !== null
              ? 9000
              : decoded.confidenceBps,
      evidenceRefs: [...evidence.evidenceRefs],
    });
  }

  #makeSecurityReport(
    id: string,
    mint: string,
    decoded: ReturnType<typeof decodeMintAccount>,
    slot: number | null,
    supply: string | null,
    decimals: number | null,
    holderSampleCount: number,
    reasons: Set<string>,
    evidence: AnalysisEvidence,
  ): TokenRiskReport {
    return TokenRiskReportSchema.parse({
      id,
      mint,
      status: decoded.status,
      programId: decoded.programId,
      mintAuthority: decoded.mintAuthority,
      freezeAuthority: decoded.freezeAuthority,
      supplyRaw: supply ?? decoded.supplyRaw,
      decimals,
      extensions: decoded.extensions,
      topHolderConcentrationBps: null,
      creatorConcentrationRaw: null,
      clusterConcentrationRaw: null,
      holderSampleCount,
      holderSampleComplete: false,
      holderSampleCoverageBps: null,
      holderSampleValidated: false,
      testTokenClassification: reasons.has("TEST_TOKEN_METADATA_PATTERN")
        ? "LIKELY_TEST"
        : "UNKNOWN",
      testTokenConfidenceBps: reasons.has("TEST_TOKEN_METADATA_PATTERN")
        ? 7000
        : 0,
      reasonCodes: [...new Set([...decoded.reasonCodes, ...reasons])].sort(),
      source: "HELIUS_RPC",
      asOfSlot: slot,
      observedAtUtc: new Date(this.#now()).toISOString(),
      confidenceBps: decoded.confidenceBps,
      evidenceRefs: [...evidence.evidenceRefs],
    });
  }
}

function decodeTokenHolding(
  dataBase64: string,
  expectedMint: string,
  expectedAmountRaw: string,
): { owner: string; amount: bigint } | null {
  const data = Buffer.from(dataBase64, "base64");
  if (data.toString("base64") !== dataBase64 || data.length < 165) return null;
  const mint = base58Encode(data.subarray(0, 32));
  if (mint !== expectedMint) return null;
  const owner = base58Encode(data.subarray(32, 64));
  const amount = data.readBigUInt64LE(64);
  if (amount.toString() !== expectedAmountRaw) return null;
  return { owner, amount };
}

function providerError(error: unknown): HeliusErrorCode {
  return error instanceof ProviderFailure
    ? error.code
    : error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "PROVIDER_UNAVAILABLE";
}

function unique(values: Array<string | null>): string[] {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

function hashId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function solToLamports(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > 9)
    throw new Error("INVALID_SOL_AMOUNT_CONFIGURATION");
  return (
    BigInt(whole) * 1_000_000_000n +
    BigInt(fraction.padEnd(9, "0") || "0")
  ).toString();
}
