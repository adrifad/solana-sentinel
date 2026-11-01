import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  CreatorReputationSchema,
  MarketEventSchema,
  RiskDecisionSchema,
  TokenRiskReportSchema,
  WalletRoleEvidenceSchema,
  utcNow,
} from "@sentinel/domain";
import type {
  CreatorReputation,
  MarketEvent,
  ProviderHealth,
  RiskDecision,
  TokenRiskReport,
  WalletRoleEvidence,
} from "@sentinel/domain";

type SqlRow = Record<
  string,
  null | number | bigint | string | NodeJS.NonSharedUint8Array
>;
type JobChainTimeStatus =
  "UNKNOWN" | "RESOLVED" | "UNAVAILABLE" | "PROVIDER_ERROR";

export type StoredToken = {
  mint: string;
  firstSeenAtUtc: string;
  lastSeenAtUtc: string;
  createdSlot: number | null;
  creator: string | null;
  launchInitiator: string | null;
  migrationSlot: number | null;
  marketPhase: string;
  name: string | null;
  symbol: string | null;
  uri: string | null;
  mintStateStatus: string;
  mintAccountSlot: number | null;
  mintProgramId: string | null;
  mintStateErrorCode: string | null;
  monitoringEligible: boolean;
  eventCount: number;
};

export class SentinelStore {
  #db!: DatabaseSync;

  constructor(path: string) {
    this.path = path;
  }

  readonly path: string;

  async open(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    this.#db = new DatabaseSync(this.path);
    this.#db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at_utc TEXT NOT NULL)",
    );
    const migrations = [
      "001-initial.sql",
      "002-mint-state-and-provenance.sql",
      "003-discovery-hardening.sql",
      "004-enrichment-and-completeness.sql",
      "005-intelligence-security-decisions.sql",
    ];
    for (const [index, filename] of migrations.entries()) {
      const version = index + 1;
      const alreadyApplied = this.#db
        .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
        .get(version);
      if (alreadyApplied) continue;
      const migrationPath = fileURLToPath(
        new URL(`../migrations/${filename}`, import.meta.url),
      );
      const migration = await readFile(migrationPath, "utf8");
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        applyMigration(this.#db, migration);
        this.#db
          .prepare(
            "INSERT INTO schema_migrations(version, applied_at_utc) VALUES (?, ?)",
          )
          .run(version, utcNow());
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  ingestEvent(
    input: MarketEvent,
    maxMonitoredTokens: number,
    heliusEnabled = false,
  ): {
    inserted: boolean;
    monitoringEligible: boolean;
    ingestionLatencyMs: number;
  } {
    const event = MarketEventSchema.parse(input);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#db
        .prepare(
          "SELECT id, slot, sanitized_payload FROM market_events WHERE provider = ? AND idempotency_key = ?",
        )
        .get(event.provider, event.idempotencyKey) as SqlRow | undefined;
      if (existing) {
        this.#recordEventConflict(existing, event);
        const token = this.#db
          .prepare("SELECT monitoring_eligible FROM tokens WHERE mint = ?")
          .get(event.mint) as SqlRow | undefined;
        this.#db.exec("COMMIT");
        return {
          inserted: false,
          monitoringEligible: token?.["monitoring_eligible"] === 1,
          ingestionLatencyMs: Math.max(
            0,
            Date.now() - Date.parse(event.receivedAtUtc),
          ),
        };
      }

      const known = this.#db
        .prepare("SELECT monitoring_eligible FROM tokens WHERE mint = ?")
        .get(event.mint) as SqlRow | undefined;
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const monitoredToday = this.#db
        .prepare(
          "SELECT COUNT(*) AS count FROM tokens WHERE monitoring_eligible = 1 AND first_seen_at_utc >= ?",
        )
        .get(cutoff) as SqlRow;
      const eligible = known
        ? known["monitoring_eligible"] === 1
        : Number(monitoredToday["count"] ?? 0) < maxMonitoredTokens;
      const ingestionLatencyMs = Math.max(
        0,
        Date.now() - Date.parse(event.receivedAtUtc),
      );
      this.#db
        .prepare(
          `INSERT INTO market_events
        (id, provider, kind, mint, signature, slot, observed_at_utc, received_at_utc, first_seen_at_utc, idempotency_key, payload_ref, sanitized_payload, ingestion_latency_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.provider,
          event.kind,
          event.mint,
          event.txSignature ?? null,
          event.slot ?? null,
          event.observedAtUtc ?? null,
          event.receivedAtUtc,
          event.firstSeenAtUtc,
          event.idempotencyKey,
          event.rawPayloadRef,
          event.sanitizedPayload,
          ingestionLatencyMs,
        );

      this.#db
        .prepare(
          `INSERT INTO discovery_checkpoints(provider, last_slot, last_signature, last_event_id, updated_at_utc)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET
          last_slot = excluded.last_slot, last_signature = excluded.last_signature,
          last_event_id = excluded.last_event_id, updated_at_utc = excluded.updated_at_utc
          WHERE excluded.last_slot IS NOT NULL AND
          (discovery_checkpoints.last_slot IS NULL OR excluded.last_slot >= discovery_checkpoints.last_slot)`,
        )
        .run(
          event.provider,
          event.slot ?? null,
          event.txSignature ?? null,
          event.id,
          event.receivedAtUtc,
        );

      const phase =
        event.kind === "TOKEN_MIGRATED"
          ? "MIGRATED_UNKNOWN_VENUE"
          : "PUMP_CURVE";
      this.#db
        .prepare(
          `INSERT INTO tokens
        (mint, first_seen_at_utc, last_seen_at_utc, created_slot, creator, launch_initiator, migration_slot, market_phase, name, symbol, uri, monitoring_eligible, event_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(mint) DO UPDATE SET
          first_seen_at_utc = MIN(tokens.first_seen_at_utc, excluded.first_seen_at_utc),
          last_seen_at_utc = MAX(tokens.last_seen_at_utc, excluded.last_seen_at_utc),
          created_slot = COALESCE(tokens.created_slot, excluded.created_slot),
          creator = COALESCE(tokens.creator, excluded.creator),
          launch_initiator = COALESCE(tokens.launch_initiator, excluded.launch_initiator),
          migration_slot = COALESCE(tokens.migration_slot, excluded.migration_slot),
          market_phase = CASE WHEN tokens.market_phase = 'MIGRATED_UNKNOWN_VENUE' OR excluded.market_phase = 'MIGRATED_UNKNOWN_VENUE' THEN 'MIGRATED_UNKNOWN_VENUE' ELSE tokens.market_phase END,
          name = COALESCE(tokens.name, excluded.name), symbol = COALESCE(tokens.symbol, excluded.symbol), uri = COALESCE(tokens.uri, excluded.uri),
          event_count = tokens.event_count + 1`,
        )
        .run(
          event.mint,
          event.firstSeenAtUtc,
          event.receivedAtUtc,
          event.kind === "TOKEN_CREATED" ? (event.slot ?? null) : null,
          event.creator ?? null,
          event.launchInitiator ?? null,
          event.kind === "TOKEN_MIGRATED" ? (event.slot ?? null) : null,
          phase,
          event.name ?? null,
          event.symbol ?? null,
          event.uri ?? null,
          eligible ? 1 : 0,
        );
      if (eligible && heliusEnabled) {
        const now = utcNow();
        this.#db
          .prepare(
            `INSERT OR IGNORE INTO enrichment_jobs
            (event_id, mint, status, next_attempt_at_utc, created_at_utc, updated_at_utc)
            VALUES (?, ?, 'PENDING', ?, ?, ?)`,
          )
          .run(event.id, event.mint, now, now, now);
      }
      if (event.kind === "TOKEN_CREATED") {
        const now = utcNow();
        this.#db
          .prepare(
            `INSERT OR IGNORE INTO analysis_jobs
            (event_id, mint, status, next_attempt_at_utc, created_at_utc, updated_at_utc)
            VALUES (?, ?, 'PENDING', ?, ?, ?)`,
          )
          .run(event.id, event.mint, now, now, now);
      }
      this.#db.exec("COMMIT");
      return {
        inserted: true,
        monitoringEligible: eligible,
        ingestionLatencyMs,
      };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  listTokens(limit = 50): StoredToken[] {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = this.#db
      .prepare("SELECT * FROM tokens ORDER BY last_seen_at_utc DESC LIMIT ?")
      .all(safeLimit) as SqlRow[];
    return rows.map(mapToken);
  }

  getToken(mint: string): StoredToken | null {
    const row = this.#db
      .prepare("SELECT * FROM tokens WHERE mint = ?")
      .get(mint) as SqlRow | undefined;
    return row ? mapToken(row) : null;
  }

  getMarketEventSummary(eventId: string): {
    mint: string;
    kind: MarketEvent["kind"];
    signature: string | null;
    slot: number | null;
    receivedAtUtc: string;
    creatorClaim: string | null;
    initiatorClaim: string | null;
    monitoringEligible: boolean;
  } | null {
    const row = this.#db
      .prepare(
        `SELECT e.mint, e.kind, e.signature, e.slot, e.received_at_utc, t.creator, t.launch_initiator, t.monitoring_eligible
        FROM market_events e JOIN tokens t USING(mint) WHERE e.id = ?`,
      )
      .get(eventId) as SqlRow | undefined;
    return row
      ? {
          mint: String(row["mint"]),
          kind: row["kind"] as MarketEvent["kind"],
          signature:
            row["signature"] === null ? null : String(row["signature"]),
          slot: row["slot"] === null ? null : Number(row["slot"]),
          receivedAtUtc: String(row["received_at_utc"]),
          creatorClaim: row["creator"] === null ? null : String(row["creator"]),
          initiatorClaim:
            row["launch_initiator"] === null
              ? null
              : String(row["launch_initiator"]),
          monitoringEligible: row["monitoring_eligible"] === 1,
        }
      : null;
  }

  recordObservedTimestamp(eventId: string, observedAtUtc: string): void {
    this.#db
      .prepare(
        `UPDATE market_events SET observed_at_utc = ?, observed_time_source = 'helius:getBlockTime',
        chain_time_status = 'RESOLVED', chain_time_error_code = NULL WHERE id = ?`,
      )
      .run(observedAtUtc, eventId);
  }

  recordUnavailableTimestamp(eventId: string): void {
    this.#db
      .prepare(
        `UPDATE market_events SET chain_time_status = 'UNAVAILABLE', chain_time_error_code = NULL WHERE id = ?`,
      )
      .run(eventId);
  }

  recordTimestampError(eventId: string, errorCode: string): void {
    this.#db
      .prepare(
        `UPDATE market_events SET chain_time_status = 'PROVIDER_ERROR', chain_time_error_code = ? WHERE id = ?`,
      )
      .run(errorCode, eventId);
  }

  getEventTimestampStatus(eventId: string): {
    status: JobChainTimeStatus;
    errorCode: string | null;
  } | null {
    const row = this.#db
      .prepare(
        "SELECT chain_time_status, chain_time_error_code FROM market_events WHERE id = ?",
      )
      .get(eventId) as SqlRow | undefined;
    return row
      ? {
          status: row["chain_time_status"] as JobChainTimeStatus,
          errorCode:
            row["chain_time_error_code"] === null
              ? null
              : String(row["chain_time_error_code"]),
        }
      : null;
  }

  recordMintAccount(
    mint: string,
    status: "PRESENT" | "NOT_FOUND" | "PROVIDER_ERROR",
    slot: number | null,
    owner: string | null,
    errorCode: string | null,
  ): void {
    this.#db
      .prepare(
        `UPDATE tokens SET mint_state_status = ?, mint_account_slot = ?, mint_program_id = ?, mint_state_error_code = ?
      WHERE mint = ?`,
      )
      .run(status, slot, owner, errorCode, mint);
  }

  tryConsumeHeliusRequest(maxRequestsPerUtcDay: number): boolean {
    const utcDay = utcNow().slice(0, 10);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          "INSERT OR IGNORE INTO helius_request_budget(utc_day, requests_used) VALUES (?, 0)",
        )
        .run(utcDay);
      const result = this.#db
        .prepare(
          `UPDATE helius_request_budget SET requests_used = requests_used + 1
          WHERE utc_day = ? AND requests_used < ?`,
        )
        .run(utcDay, maxRequestsPerUtcDay);
      this.#db.exec("COMMIT");
      return Number(result.changes) === 1;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  claimEnrichmentJob(): {
    eventId: string;
    mint: string;
    kind: MarketEvent["kind"];
    slot: number | null;
    chainTimeStatus: "UNKNOWN" | "RESOLVED" | "UNAVAILABLE" | "PROVIDER_ERROR";
    attempts: number;
  } | null {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const now = utcNow();
      const row = this.#db
        .prepare(
          `SELECT j.event_id, j.mint, j.attempts, e.kind, e.slot, e.chain_time_status
          FROM enrichment_jobs j JOIN market_events e ON e.id = j.event_id
          WHERE j.status = 'PENDING' AND j.next_attempt_at_utc <= ?
          ORDER BY j.created_at_utc LIMIT 1`,
        )
        .get(now) as SqlRow | undefined;
      if (!row) {
        this.#db.exec("COMMIT");
        return null;
      }
      const changed = this.#db
        .prepare(
          `UPDATE enrichment_jobs SET status = 'PROCESSING', attempts = attempts + 1, updated_at_utc = ?
          WHERE event_id = ? AND status = 'PENDING'`,
        )
        .run(now, String(row["event_id"]));
      this.#db.exec("COMMIT");
      return Number(changed.changes) === 1
        ? {
            eventId: String(row["event_id"]),
            mint: String(row["mint"]),
            kind: row["kind"] as MarketEvent["kind"],
            slot: row["slot"] === null ? null : Number(row["slot"]),
            chainTimeStatus: row["chain_time_status"] as JobChainTimeStatus,
            attempts: Number(row["attempts"]) + 1,
          }
        : null;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  finishEnrichmentJob(
    eventId: string,
    status: "COMPLETE" | "FAILED" | "DEFERRED_BUDGET" | "PENDING",
    errorCode: string | null = null,
    retryDelayMs = 0,
  ): void {
    const now = utcNow();
    this.#db
      .prepare(
        `UPDATE enrichment_jobs SET status = ?, last_error_code = ?,
        next_attempt_at_utc = ?, updated_at_utc = ? WHERE event_id = ?`,
      )
      .run(
        status,
        errorCode,
        new Date(Date.now() + retryDelayMs).toISOString(),
        now,
        eventId,
      );
  }

  getEnrichmentJobStatus(eventId: string): string | null {
    const row = this.#db
      .prepare("SELECT status FROM enrichment_jobs WHERE event_id = ?")
      .get(eventId) as SqlRow | undefined;
    return row ? String(row["status"]) : null;
  }

  recoverInterruptedEnrichmentJobs(): number {
    const result = this.#db
      .prepare(
        `UPDATE enrichment_jobs SET status = 'PENDING', updated_at_utc = ?
        WHERE status = 'PROCESSING'`,
      )
      .run(utcNow());
    return Number(result.changes);
  }

  recordStreamDisconnect(errorCode: string): void {
    this.#db
      .prepare(
        `INSERT INTO stream_gaps(provider, disconnected_at_utc, reconciliation_state, error_code)
        SELECT 'pumpportal', ?, 'OPEN', ? WHERE NOT EXISTS
        (SELECT 1 FROM stream_gaps WHERE provider = 'pumpportal' AND reconciliation_state = 'OPEN')`,
      )
      .run(utcNow(), errorCode);
  }

  recordStreamReconnect(): void {
    this.#db
      .prepare(
        `UPDATE stream_gaps SET reconciliation_state = 'UNRECOVERED', reconnected_at_utc = ?
        WHERE provider = 'pumpportal' AND reconciliation_state = 'OPEN'`,
      )
      .run(utcNow());
  }

  recordProviderIssue(provider: string, errorCode: string): void {
    const now = utcNow();
    this.#db
      .prepare(
        `INSERT INTO provider_issue_counters
        (provider, error_code, first_seen_at_utc, last_seen_at_utc, occurrences)
        VALUES (?, ?, ?, ?, 1) ON CONFLICT(provider, error_code) DO UPDATE SET
        last_seen_at_utc = excluded.last_seen_at_utc, occurrences = occurrences + 1`,
      )
      .run(provider, errorCode, now, now);
  }

  getStreamCompleteness(): {
    coverageStatus:
      | "UNKNOWN"
      | "OBSERVED_WITHOUT_KNOWN_GAP"
      | "GAPS_UNRECONCILED"
      | "PROVIDER_ISSUES";
    historyComplete: false;
    unreconciledGapCount: number;
    providerIssueOccurrences: number;
    checkpoint: ReturnType<SentinelStore["getDiscoveryCheckpoint"]>;
  } {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS count FROM stream_gaps
        WHERE provider = 'pumpportal' AND reconciliation_state IN ('OPEN', 'UNRECOVERED')`,
      )
      .get() as SqlRow;
    const unreconciledGapCount = Number(row["count"] ?? 0);
    const issues = this.#db
      .prepare(
        `SELECT COALESCE(SUM(occurrences), 0) AS count FROM provider_issue_counters
        WHERE provider = 'pumpportal'`,
      )
      .get() as SqlRow;
    const providerIssueOccurrences = Number(issues["count"] ?? 0);
    const checkpoint = this.getDiscoveryCheckpoint();
    return {
      coverageStatus:
        unreconciledGapCount > 0
          ? "GAPS_UNRECONCILED"
          : providerIssueOccurrences > 0
            ? "PROVIDER_ISSUES"
            : checkpoint
              ? "OBSERVED_WITHOUT_KNOWN_GAP"
              : "UNKNOWN",
      historyComplete: false,
      unreconciledGapCount,
      providerIssueOccurrences,
      checkpoint,
    };
  }

  eventConflictCount(): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS count FROM provider_event_conflicts")
      .get() as SqlRow;
    return Number(row["count"] ?? 0);
  }

  claimAnalysisJob(): {
    eventId: string;
    mint: string;
    attempts: number;
  } | null {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const now = utcNow();
      const row = this.#db
        .prepare(
          `SELECT event_id, mint, attempts FROM analysis_jobs
          WHERE status = 'PENDING' AND next_attempt_at_utc <= ?
          ORDER BY created_at_utc LIMIT 1`,
        )
        .get(now) as SqlRow | undefined;
      if (!row) {
        this.#db.exec("COMMIT");
        return null;
      }
      const changed = this.#db
        .prepare(
          `UPDATE analysis_jobs SET status = 'PROCESSING', attempts = attempts + 1, updated_at_utc = ?
          WHERE event_id = ? AND status = 'PENDING'`,
        )
        .run(now, String(row["event_id"]));
      this.#db.exec("COMMIT");
      return Number(changed.changes) === 1
        ? {
            eventId: String(row["event_id"]),
            mint: String(row["mint"]),
            attempts: Number(row["attempts"]) + 1,
          }
        : null;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  finishAnalysisJob(eventId: string, retryDelayMs = 0): void {
    const now = utcNow();
    this.#db
      .prepare(
        `UPDATE analysis_jobs SET status = ?, next_attempt_at_utc = ?, updated_at_utc = ?
        WHERE event_id = ?`,
      )
      .run(
        retryDelayMs > 0 ? "PENDING" : "COMPLETE",
        new Date(Date.now() + retryDelayMs).toISOString(),
        now,
        eventId,
      );
  }

  recoverInterruptedAnalysisJobs(): number {
    const result = this.#db
      .prepare(
        `UPDATE analysis_jobs SET status = 'PENDING', updated_at_utc = ?
        WHERE status = 'PROCESSING'`,
      )
      .run(utcNow());
    return Number(result.changes);
  }

  saveWalletTransaction(input: {
    wallet: string;
    signature: string;
    slot: number;
    blockTimeSeconds: number | null;
    fetchedAtUtc: string;
    succeeded: boolean;
    feeLamportsRaw: string;
    confidenceBps: number;
    reasonCode: string;
    sanitizedTransactionJson: string;
  }): void {
    if (input.sanitizedTransactionJson.length > 32768)
      throw new Error("TRANSACTION_EVIDENCE_TOO_LARGE");
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO wallet_transactions
        (wallet_pubkey, signature, slot, block_time_seconds, fetched_at_utc, succeeded,
        fee_lamports_raw, provenance, confidence_bps, reason_code, sanitized_transaction_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'helius:getTransaction', ?, ?, ?)`,
      )
      .run(
        input.wallet,
        input.signature,
        input.slot,
        input.blockTimeSeconds,
        input.fetchedAtUtc,
        input.succeeded ? 1 : 0,
        input.feeLamportsRaw,
        input.confidenceBps,
        input.reasonCode,
        input.sanitizedTransactionJson,
      );
  }

  walletTransactionCount(wallet: string, asOfSlot: number): number {
    const row = this.#db
      .prepare(
        "SELECT COUNT(*) AS count FROM wallet_transactions WHERE wallet_pubkey = ? AND slot <= ?",
      )
      .get(wallet, asOfSlot) as SqlRow;
    return Number(row["count"] ?? 0);
  }

  saveWalletRoleEvidence(input: WalletRoleEvidence): void {
    const evidence = WalletRoleEvidenceSchema.parse(input);
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO wallet_role_evidence
        (id, mint, wallet_pubkey, role, source, signature, slot, observed_at_utc, confidence_bps, reason_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        evidence.id,
        evidence.mint,
        evidence.wallet,
        evidence.role,
        evidence.source,
        evidence.signature,
        evidence.slot,
        evidence.observedAtUtc,
        evidence.confidenceBps,
        evidence.reasonCode,
      );
  }

  listWalletRoleEvidence(mint: string): WalletRoleEvidence[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM wallet_role_evidence WHERE mint = ? ORDER BY slot, role",
      )
      .all(mint) as SqlRow[];
    return rows.map((row) =>
      WalletRoleEvidenceSchema.parse({
        id: row["id"],
        mint: row["mint"],
        wallet: row["wallet_pubkey"],
        role: row["role"],
        source: row["source"],
        signature: row["signature"],
        slot: row["slot"],
        observedAtUtc: row["observed_at_utc"],
        confidenceBps: row["confidence_bps"],
        reasonCode: row["reason_code"],
      }),
    );
  }

  saveCreatorLaunch(input: {
    creator: string;
    mint: string;
    signature: string;
    slot: number;
    blockTimeSeconds: number | null;
    observedAtUtc: string;
    confidenceBps: number;
    idlRevision: string;
  }): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO creator_launches
        (creator_pubkey, mint, signature, slot, block_time_seconds, observed_at_utc,
        source, confidence_bps, idl_revision)
        VALUES (?, ?, ?, ?, ?, ?, 'helius:pump-public-docs/idl/pump.json', ?, ?)`,
      )
      .run(
        input.creator,
        input.mint,
        input.signature,
        input.slot,
        input.blockTimeSeconds,
        input.observedAtUtc,
        input.confidenceBps,
        input.idlRevision,
      );
  }

  listCreatorLaunches(
    creator: string,
    asOfSlot: number,
  ): Array<{
    mint: string;
    signature: string;
    slot: number;
    blockTimeSeconds: number | null;
    observedAtUtc: string;
    confidenceBps: number;
  }> {
    const rows = this.#db
      .prepare(
        `SELECT mint, signature, slot, block_time_seconds, observed_at_utc, confidence_bps
        FROM creator_launches WHERE creator_pubkey = ? AND slot <= ? ORDER BY slot, signature`,
      )
      .all(creator, asOfSlot) as SqlRow[];
    return rows.map((row) => ({
      mint: String(row["mint"]),
      signature: String(row["signature"]),
      slot: Number(row["slot"]),
      blockTimeSeconds:
        row["block_time_seconds"] === null
          ? null
          : Number(row["block_time_seconds"]),
      observedAtUtc: String(row["observed_at_utc"]),
      confidenceBps: Number(row["confidence_bps"]),
    }));
  }

  saveWalletLink(input: {
    id: string;
    sourceWallet: string;
    destinationWallet: string;
    relationType: "DIRECT_FUNDING" | "REPEATED_COSIGNER";
    signature: string;
    slot: number;
    observedAtUtc: string;
    amountLamportsRaw: string | null;
    confidenceBps: number;
    reasonCode: string;
  }): void {
    if (input.sourceWallet === input.destinationWallet) return;
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO wallet_links
        (id, source_wallet, destination_wallet, relation_type, evidence_signature, slot,
        observed_at_utc, amount_lamports_raw, confidence_bps, reason_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sourceWallet,
        input.destinationWallet,
        input.relationType,
        input.signature,
        input.slot,
        input.observedAtUtc,
        input.amountLamportsRaw,
        input.confidenceBps,
        input.reasonCode,
      );
  }

  countSharedCosignerEvidence(
    wallet: string,
    peer: string,
    asOfSlot: number,
  ): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(DISTINCT evidence_signature) AS count FROM wallet_links
        WHERE relation_type = 'REPEATED_COSIGNER' AND slot <= ?
        AND ((source_wallet = ? AND destination_wallet = ?) OR
        (source_wallet = ? AND destination_wallet = ?))`,
      )
      .get(asOfSlot, wallet, peer, peer, wallet) as SqlRow;
    return Number(row["count"] ?? 0);
  }

  listLinkedWallets(
    wallet: string,
    asOfSlot: number,
    minimumConfidenceBps = 8000,
  ): string[] {
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT CASE WHEN source_wallet = ? THEN destination_wallet ELSE source_wallet END AS peer
        FROM wallet_links WHERE relation_type = 'REPEATED_COSIGNER' AND slot <= ? AND confidence_bps >= ?
        AND (source_wallet = ? OR destination_wallet = ?)`,
      )
      .all(wallet, asOfSlot, minimumConfidenceBps, wallet, wallet) as SqlRow[];
    return rows.map((row) => String(row["peer"]));
  }

  getWalletLinks(wallet: string): Array<Record<string, unknown>> {
    const rows = this.#db
      .prepare(
        `SELECT id, source_wallet, destination_wallet, relation_type, evidence_signature,
        slot, observed_at_utc, amount_lamports_raw, confidence_bps, reason_code
        FROM wallet_links WHERE source_wallet = ? OR destination_wallet = ? ORDER BY slot`,
      )
      .all(wallet, wallet) as SqlRow[];
    return rows.map((row) => ({
      id: String(row["id"]),
      sourceWallet: String(row["source_wallet"]),
      destinationWallet: String(row["destination_wallet"]),
      relationType: String(row["relation_type"]),
      signature: String(row["evidence_signature"]),
      slot: Number(row["slot"]),
      observedAtUtc: String(row["observed_at_utc"]),
      amountLamportsRaw:
        row["amount_lamports_raw"] === null
          ? null
          : String(row["amount_lamports_raw"]),
      confidenceBps: Number(row["confidence_bps"]),
      reasonCode: String(row["reason_code"]),
    }));
  }

  getWalletHistoryRefresh(
    wallet: string,
    asOfSlot: number,
  ): {
    asOfSlot: number;
    beforeSignature: string | null;
    scannedCount: number;
    historyComplete: boolean;
    lastFetchedAtUtc: string;
    freshUntilUtc: string;
    lastErrorCode: string | null;
  } | null {
    const row = this.#db
      .prepare(
        "SELECT * FROM wallet_history_refresh WHERE wallet_pubkey = ? AND as_of_slot = ?",
      )
      .get(wallet, asOfSlot) as SqlRow | undefined;
    if (!row) return null;
    return {
      asOfSlot: Number(row["as_of_slot"]),
      beforeSignature:
        row["next_before_signature"] === null
          ? null
          : String(row["next_before_signature"]),
      scannedCount: Number(row["scanned_count"]),
      historyComplete: row["history_complete"] === 1,
      lastFetchedAtUtc: String(row["last_fetched_at_utc"]),
      freshUntilUtc: String(row["fresh_until_utc"]),
      lastErrorCode:
        row["last_error_code"] === null ? null : String(row["last_error_code"]),
    };
  }

  saveWalletHistoryRefresh(input: {
    wallet: string;
    asOfSlot: number;
    beforeSignature: string | null;
    scannedCount: number;
    historyComplete: boolean;
    fetchedAtUtc: string;
    freshUntilUtc: string;
    errorCode: string | null;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO wallet_history_refresh
        (wallet_pubkey, as_of_slot, next_before_signature, scanned_count, history_complete,
        last_fetched_at_utc, fresh_until_utc, last_error_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(wallet_pubkey, as_of_slot) DO UPDATE SET
        next_before_signature = excluded.next_before_signature, scanned_count = excluded.scanned_count,
        history_complete = excluded.history_complete, last_fetched_at_utc = excluded.last_fetched_at_utc,
        fresh_until_utc = excluded.fresh_until_utc, last_error_code = excluded.last_error_code`,
      )
      .run(
        input.wallet,
        input.asOfSlot,
        input.beforeSignature,
        input.scannedCount,
        input.historyComplete ? 1 : 0,
        input.fetchedAtUtc,
        input.freshUntilUtc,
        input.errorCode,
      );
  }

  saveCreatorReputation(input: CreatorReputation): void {
    const reputation = CreatorReputationSchema.parse(input);
    this.#db
      .prepare(
        `INSERT INTO creator_reputation
        (wallet_pubkey, status, launches_observed, suspicious_indicators_json, confidence_bps,
        history_complete, as_of_slot, computed_at_utc, fresh_until_utc, evidence_refs_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(wallet_pubkey) DO UPDATE SET status = excluded.status,
        launches_observed = excluded.launches_observed,
        suspicious_indicators_json = excluded.suspicious_indicators_json,
        confidence_bps = excluded.confidence_bps, history_complete = excluded.history_complete,
        as_of_slot = excluded.as_of_slot, computed_at_utc = excluded.computed_at_utc,
        fresh_until_utc = excluded.fresh_until_utc, evidence_refs_json = excluded.evidence_refs_json
        WHERE creator_reputation.as_of_slot IS NULL OR
        excluded.as_of_slot >= creator_reputation.as_of_slot`,
      )
      .run(
        reputation.wallet,
        reputation.status,
        reputation.launchesObserved,
        JSON.stringify(reputation.suspiciousIndicators),
        reputation.confidenceBps,
        reputation.historyComplete ? 1 : 0,
        reputation.asOfSlot,
        reputation.computedAtUtc,
        reputation.freshUntilUtc,
        JSON.stringify(reputation.evidenceRefs),
      );
    if (reputation.asOfSlot !== null)
      this.#db
        .prepare(
          `INSERT INTO creator_reputation_history(wallet_pubkey, as_of_slot, report_json)
          VALUES (?, ?, ?) ON CONFLICT(wallet_pubkey, as_of_slot)
          DO UPDATE SET report_json = excluded.report_json`,
        )
        .run(
          reputation.wallet,
          reputation.asOfSlot,
          JSON.stringify(reputation),
        );
  }

  getCreatorReputation(
    wallet: string,
    asOfSlot?: number,
  ): CreatorReputation | null {
    if (asOfSlot !== undefined) {
      const snapshot = this.#db
        .prepare(
          `SELECT report_json FROM creator_reputation_history
          WHERE wallet_pubkey = ? AND as_of_slot <= ? ORDER BY as_of_slot DESC LIMIT 1`,
        )
        .get(wallet, asOfSlot) as SqlRow | undefined;
      return snapshot
        ? CreatorReputationSchema.parse(
            JSON.parse(String(snapshot["report_json"])),
          )
        : null;
    }
    const row = this.#db
      .prepare("SELECT * FROM creator_reputation WHERE wallet_pubkey = ?")
      .get(wallet) as SqlRow | undefined;
    if (!row) return null;
    return CreatorReputationSchema.parse({
      wallet: row["wallet_pubkey"],
      status: row["status"],
      launchesObserved: row["launches_observed"],
      suspiciousIndicators: JSON.parse(
        String(row["suspicious_indicators_json"]),
      ),
      confidenceBps: row["confidence_bps"],
      historyComplete: row["history_complete"] === 1,
      asOfSlot: row["as_of_slot"],
      computedAtUtc: row["computed_at_utc"],
      freshUntilUtc: row["fresh_until_utc"],
      evidenceRefs: JSON.parse(String(row["evidence_refs_json"])),
    });
  }

  saveTokenRiskReport(input: TokenRiskReport): void {
    const report = TokenRiskReportSchema.parse(input);
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO token_security_reports(id, mint, as_of_slot, observed_at_utc, report_json)
        VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        report.id,
        report.mint,
        report.asOfSlot,
        report.observedAtUtc,
        JSON.stringify(report),
      );
  }

  getLatestTokenRiskReport(mint: string): TokenRiskReport | null {
    const row = this.#db
      .prepare(
        "SELECT report_json FROM token_security_reports WHERE mint = ? ORDER BY observed_at_utc DESC, id DESC LIMIT 1",
      )
      .get(mint) as SqlRow | undefined;
    return row
      ? TokenRiskReportSchema.parse(JSON.parse(String(row["report_json"])))
      : null;
  }

  saveRiskDecision(input: RiskDecision): void {
    const decision = RiskDecisionSchema.parse(input);
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO risk_decisions
        (id, mint, status, config_version, security_report_id, reason_codes_json,
        evidence_refs_json, decided_at_utc, latency_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.id,
        decision.mint,
        decision.status,
        decision.configVersion,
        decision.securityReportId,
        JSON.stringify(decision.reasonCodes),
        JSON.stringify(decision.evidenceRefs),
        decision.decidedAtUtc,
        decision.latencyMs,
      );
  }

  listRiskDecisions(mint: string, limit = 50): RiskDecision[] {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = this.#db
      .prepare(
        `SELECT * FROM risk_decisions WHERE mint = ? ORDER BY decided_at_utc DESC LIMIT ?`,
      )
      .all(mint, safeLimit) as SqlRow[];
    return rows.map((row) =>
      RiskDecisionSchema.parse({
        id: row["id"],
        mint: row["mint"],
        status: row["status"],
        configVersion: row["config_version"],
        securityReportId: row["security_report_id"],
        reasonCodes: JSON.parse(String(row["reason_codes_json"])),
        evidenceRefs: JSON.parse(String(row["evidence_refs_json"])),
        decidedAtUtc: row["decided_at_utc"],
        latencyMs: row["latency_ms"],
      }),
    );
  }

  saveDryRunTradeIntent(input: {
    id: string;
    mint: string;
    side: "BUY" | "SELL";
    decisionId: string;
    reasonCodes: string[];
    createdAtUtc: string;
  }): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO dry_run_trade_intents
        (id, mode, mint, side, decision_id, reason_codes_json, created_at_utc)
        VALUES (?, 'DRY_RUN', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.mint,
        input.side,
        input.decisionId,
        JSON.stringify(input.reasonCodes),
        input.createdAtUtc,
      );
  }

  #recordEventConflict(existing: SqlRow, incoming: MarketEvent): void {
    const existingSlot = existing["slot"];
    const reasons: string[] = [];
    if (
      existingSlot !== null &&
      incoming.slot !== undefined &&
      Number(existingSlot) !== incoming.slot
    )
      reasons.push("SLOT_MISMATCH");
    let previous: Record<string, unknown> = {};
    try {
      const value: unknown = JSON.parse(String(existing["sanitized_payload"]));
      if (value && typeof value === "object" && !Array.isArray(value))
        previous = value as Record<string, unknown>;
    } catch {
      reasons.push("STORED_PAYLOAD_INVALID");
    }
    let next: Record<string, unknown> = {};
    try {
      const value: unknown = JSON.parse(incoming.sanitizedPayload);
      if (value && typeof value === "object" && !Array.isArray(value))
        next = value as Record<string, unknown>;
    } catch {
      reasons.push("INCOMING_PAYLOAD_INVALID");
    }
    for (const field of ["name", "symbol", "uri", "creator", "traderPublicKey"])
      if (
        typeof previous[field] === "string" &&
        typeof next[field] === "string" &&
        previous[field] !== next[field]
      )
        reasons.push(`${field.toUpperCase()}_MISMATCH`);
    if (reasons.length === 0) return;
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO provider_event_conflicts
        (event_id, incoming_payload_ref, reason_codes, detected_at_utc) VALUES (?, ?, ?, ?)`,
      )
      .run(
        String(existing["id"]),
        incoming.rawPayloadRef,
        JSON.stringify([...new Set(reasons)].sort()),
        utcNow(),
      );
  }

  setProviderHealth(health: ProviderHealth): void {
    this.#db
      .prepare(
        `INSERT INTO provider_health(provider, state, checked_at_utc, last_event_at_utc, reconnect_count, error_code,
      connection_state, last_message_at_utc, last_processed_at_utc, processing_lag_ms, queue_depth)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET state = excluded.state,
      checked_at_utc = excluded.checked_at_utc, last_event_at_utc = excluded.last_event_at_utc,
      reconnect_count = excluded.reconnect_count, error_code = excluded.error_code,
      connection_state = excluded.connection_state, last_message_at_utc = excluded.last_message_at_utc,
      last_processed_at_utc = excluded.last_processed_at_utc, processing_lag_ms = excluded.processing_lag_ms,
      queue_depth = excluded.queue_depth`,
      )
      .run(
        health.provider,
        health.state,
        health.checkedAtUtc,
        health.lastEventAtUtc,
        health.reconnectCount,
        health.errorCode,
        health.connectionState ?? null,
        health.lastMessageAtUtc ?? health.lastEventAtUtc,
        health.lastProcessedAtUtc ?? null,
        health.processingLagMs ?? null,
        health.queueDepth ?? 0,
      );
  }

  listProviderHealth(): Array<
    Omit<ProviderHealth, "provider"> & { provider: string }
  > {
    const rows = this.#db
      .prepare("SELECT * FROM provider_health ORDER BY provider")
      .all() as SqlRow[];
    return rows.map((row) => ({
      provider: String(row["provider"]),
      state: row["state"] as ProviderHealth["state"],
      checkedAtUtc:
        row["checked_at_utc"] === null ? null : String(row["checked_at_utc"]),
      lastEventAtUtc:
        row["last_event_at_utc"] === null
          ? null
          : String(row["last_event_at_utc"]),
      reconnectCount: Number(row["reconnect_count"]),
      errorCode: row["error_code"] === null ? null : String(row["error_code"]),
      ...(row["connection_state"] === null
        ? {}
        : {
            connectionState: String(row["connection_state"]) as NonNullable<
              ProviderHealth["connectionState"]
            >,
          }),
      lastMessageAtUtc:
        row["last_message_at_utc"] === null
          ? null
          : String(row["last_message_at_utc"]),
      lastProcessedAtUtc:
        row["last_processed_at_utc"] === null
          ? null
          : String(row["last_processed_at_utc"]),
      processingLagMs:
        row["processing_lag_ms"] === null
          ? null
          : Number(row["processing_lag_ms"]),
      queueDepth: Number(row["queue_depth"] ?? 0),
    }));
  }

  eventCount(): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS count FROM market_events")
      .get() as SqlRow;
    return Number(row["count"] ?? 0);
  }

  getDiscoveryCheckpoint(provider = "pumpportal"): {
    lastSlot: number | null;
    lastSignature: string | null;
    lastEventId: string | null;
    updatedAtUtc: string;
  } | null {
    const row = this.#db
      .prepare("SELECT * FROM discovery_checkpoints WHERE provider = ?")
      .get(provider) as SqlRow | undefined;
    if (!row) return null;
    return {
      lastSlot: row["last_slot"] === null ? null : Number(row["last_slot"]),
      lastSignature:
        row["last_signature"] === null ? null : String(row["last_signature"]),
      lastEventId:
        row["last_event_id"] === null ? null : String(row["last_event_id"]),
      updatedAtUtc: String(row["updated_at_utc"]),
    };
  }

  close(): void {
    this.#db.close();
  }
}

function applyMigration(db: DatabaseSync, migration: string): void {
  for (const statement of migration
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const addColumn = /^ALTER TABLE (\w+) ADD COLUMN (\w+)/i.exec(statement);
    if (addColumn) {
      const table = addColumn[1];
      const column = addColumn[2];
      if (!table || !column) throw new Error("INVALID_MIGRATION");
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all() as SqlRow[];
      if (columns.some((row) => row["name"] === column)) continue;
    }
    db.exec(`${statement};`);
  }
}

function mapToken(row: SqlRow): StoredToken {
  return {
    mint: String(row["mint"]),
    firstSeenAtUtc: String(row["first_seen_at_utc"]),
    lastSeenAtUtc: String(row["last_seen_at_utc"]),
    createdSlot:
      row["created_slot"] === null ? null : Number(row["created_slot"]),
    creator: row["creator"] === null ? null : String(row["creator"]),
    launchInitiator:
      row["launch_initiator"] === null ? null : String(row["launch_initiator"]),
    migrationSlot:
      row["migration_slot"] === null ? null : Number(row["migration_slot"]),
    marketPhase: String(row["market_phase"]),
    name: row["name"] === null ? null : String(row["name"]),
    symbol: row["symbol"] === null ? null : String(row["symbol"]),
    uri: row["uri"] === null ? null : String(row["uri"]),
    mintStateStatus: String(row["mint_state_status"]),
    mintAccountSlot:
      row["mint_account_slot"] === null
        ? null
        : Number(row["mint_account_slot"]),
    mintProgramId:
      row["mint_program_id"] === null ? null : String(row["mint_program_id"]),
    mintStateErrorCode:
      row["mint_state_error_code"] === null
        ? null
        : String(row["mint_state_error_code"]),
    monitoringEligible: row["monitoring_eligible"] === 1,
    eventCount: Number(row["event_count"]),
  };
}

export function payloadReference(payload: string): string {
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}
