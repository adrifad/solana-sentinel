import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  CreatorReputationSchema,
  MarketEventSchema,
  LaunchBehaviorSnapshotSchema,
  LaunchTradeObservationSchema,
  PaperOrderIntentSchema,
  QuoteResultSchema,
  RiskDecisionSchema,
  TokenRiskReportSchema,
  WalletRoleEvidenceSchema,
  utcNow,
} from "@sentinel/domain";
import type {
  CreatorReputation,
  MarketEvent,
  LaunchBehaviorSnapshot,
  LaunchTradeObservation,
  QuoteResult,
  ProviderHealth,
  RiskDecision,
  TokenRiskReport,
  WalletRoleEvidence,
  PaperOrderIntent,
} from "@sentinel/domain";

const WSOL_MINT = "So11111111111111111111111111111111111111112";

type SqlRow = Record<
  string,
  null | number | bigint | string | NodeJS.NonSharedUint8Array
>;
type JobChainTimeStatus =
  "UNKNOWN" | "RESOLVED" | "UNAVAILABLE" | "PROVIDER_ERROR";

export type ManualPaperRequest = {
  id: string;
  idempotencyKey: string;
  requestType: "ENTRY" | "EXIT";
  walletId: string;
  mint: string;
  positionId: string | null;
  requestedAmountRaw: string;
  requestedSizeSol: string | null;
  entrySource: "MANUAL";
  status: "PENDING" | "PROCESSING" | "FILLED" | "REJECTED" | "UNFILLABLE";
  reasonCode: string | null;
  originalCoverageStatus: string | null;
  coverageExceptionReason: string | null;
  evidence: Record<string, unknown>;
  executionOrderId: string | null;
  attempts: number;
  createdAtUtc: string;
  expiresAtUtc: string | null;
  updatedAtUtc: string;
  completedAtUtc: string | null;
};

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

  listAppliedMigrations(): Array<{ version: number; appliedAtUtc: string }> {
    const rows = this.#db
      .prepare(
        "SELECT version, applied_at_utc FROM schema_migrations ORDER BY version",
      )
      .all() as SqlRow[];
    return rows.map((row) => ({
      version: Number(row["version"]),
      appliedAtUtc: String(row["applied_at_utc"]),
    }));
  }

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
      "006-market-intelligence.sql",
      "007-paper-ledger.sql",
      "008-runtime-hardening.sql",
      "009-paper-runtime.sql",
      "010-trade-evidence.sql",
      "011-manual-paper-requests.sql",
      "012-manual-paper-request-expiry.sql",
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
    this.#db.exec(`
      CREATE TRIGGER IF NOT EXISTS paper_ledger_no_update
      BEFORE UPDATE ON paper_ledger_entries BEGIN
        SELECT RAISE(ABORT, 'paper ledger entries are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS paper_ledger_no_delete
      BEFORE DELETE ON paper_ledger_entries BEGIN
        SELECT RAISE(ABORT, 'paper ledger entries are immutable');
      END;
    `);
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
        (id, provider, kind, mint, signature, slot, provider_slot, observed_at_utc, received_at_utc, first_seen_at_utc, idempotency_key, payload_ref, sanitized_payload, ingestion_latency_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.provider,
          event.kind,
          event.mint,
          event.txSignature ?? null,
          event.slot ?? null,
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
          event.kind === "TOKEN_MIGRATED" ? null : (event.slot ?? null),
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
          creator = CASE
            WHEN tokens.market_phase = 'MIGRATED_UNKNOWN_VENUE' OR excluded.market_phase = 'MIGRATED_UNKNOWN_VENUE'
            THEN (SELECT wallet_pubkey FROM wallet_role_evidence WHERE mint = tokens.mint
              AND role = 'CLAIMED_CREATOR' AND source = 'PUMP_IDL_CREATE_EVENT' AND confidence_bps = 10000
              ORDER BY slot ASC LIMIT 1)
            ELSE COALESCE(tokens.creator, excluded.creator) END,
          launch_initiator = CASE
            WHEN tokens.market_phase = 'MIGRATED_UNKNOWN_VENUE' OR excluded.market_phase = 'MIGRATED_UNKNOWN_VENUE'
            THEN (SELECT wallet_pubkey FROM wallet_role_evidence WHERE mint = tokens.mint
              AND role = 'LAUNCH_INITIATOR' AND source = 'PUMP_IDL_CREATE_EVENT' AND confidence_bps = 10000
              ORDER BY slot ASC LIMIT 1)
            ELSE COALESCE(tokens.launch_initiator, excluded.launch_initiator) END,
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
          event.kind === "TOKEN_CREATED" ? (event.creator ?? null) : null,
          event.kind === "TOKEN_CREATED"
            ? (event.launchInitiator ?? null)
            : null,
          null,
          phase,
          event.name ?? null,
          event.symbol ?? null,
          event.uri ?? null,
          eligible ? 1 : 0,
        );
      if (eligible && heliusEnabled && event.kind === "TOKEN_CREATED") {
        const now = utcNow();
        this.#db
          .prepare(
            `INSERT OR IGNORE INTO enrichment_jobs
            (event_id, mint, status, next_attempt_at_utc, created_at_utc, updated_at_utc)
            VALUES (?, ?, 'PENDING', ?, ?, ?)`,
          )
          .run(event.id, event.mint, now, now, now);
      }
      if (event.kind === "TOKEN_MIGRATED") {
        const now = utcNow();
        this.#db
          .prepare(
            `INSERT OR IGNORE INTO migration_recovery_jobs
            (event_id, mint, signature, status, next_attempt_at_utc, created_at_utc, updated_at_utc)
            VALUES (?, ?, ?, 'PENDING', ?, ?, ?)`,
          )
          .run(event.id, event.mint, event.txSignature ?? null, now, now, now);
      } else {
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
    migrationRecoveryStatus: string | null;
  } | null {
    const row = this.#db
      .prepare(
        `SELECT e.mint, e.kind, e.signature, e.slot, e.received_at_utc, t.creator, t.launch_initiator, t.monitoring_eligible,
        j.status AS migration_recovery_status
        FROM market_events e JOIN tokens t USING(mint) LEFT JOIN migration_recovery_jobs j ON j.event_id = e.id WHERE e.id = ?`,
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
          migrationRecoveryStatus:
            row["migration_recovery_status"] === null
              ? null
              : String(row["migration_recovery_status"]),
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

  tryConsumeJupiterRequest(maxRequestsPerUtcDay: number): boolean {
    const utcDay = utcNow().slice(0, 10);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO external_request_budget(provider, utc_day, requests_used)
          VALUES ('jupiter', ?, 0)`,
        )
        .run(utcDay);
      const result = this.#db
        .prepare(
          `UPDATE external_request_budget SET requests_used = requests_used + 1
          WHERE provider = 'jupiter' AND utc_day = ? AND requests_used < ?`,
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

  claimMigrationRecoveryJob(): {
    eventId: string;
    mint: string;
    signature: string | null;
    eventSlot: number | null;
    monitoringEligible: boolean;
    attempts: number;
  } | null {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const now = utcNow();
      const row = this.#db
        .prepare(
          `SELECT j.event_id, j.mint, j.signature, j.attempts, e.provider_slot, t.monitoring_eligible
          FROM migration_recovery_jobs j JOIN market_events e ON e.id = j.event_id
          JOIN tokens t ON t.mint = j.mint
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
          `UPDATE migration_recovery_jobs SET status = 'PROCESSING', attempts = attempts + 1, updated_at_utc = ?
          WHERE event_id = ? AND status = 'PENDING'`,
        )
        .run(now, String(row["event_id"]));
      this.#db.exec("COMMIT");
      return Number(changed.changes) === 1
        ? {
            eventId: String(row["event_id"]),
            mint: String(row["mint"]),
            signature:
              row["signature"] === null ? null : String(row["signature"]),
            eventSlot:
              row["provider_slot"] === null
                ? null
                : Number(row["provider_slot"]),
            monitoringEligible: row["monitoring_eligible"] === 1,
            attempts: Number(row["attempts"]) + 1,
          }
        : null;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  resolveMigrationEvent(input: {
    eventId: string;
    mint: string;
    signature: string;
    slot: number;
    blockTime: number | null;
  }): void {
    if (!Number.isSafeInteger(input.slot) || input.slot < 0)
      throw new Error("MIGRATION_SLOT_INVALID");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const event = this.#db
        .prepare(
          "SELECT kind, mint, signature, slot, provider_slot FROM market_events WHERE id = ?",
        )
        .get(input.eventId) as SqlRow | undefined;
      if (
        !event ||
        event["kind"] !== "TOKEN_MIGRATED" ||
        event["mint"] !== input.mint ||
        event["signature"] !== input.signature ||
        (event["provider_slot"] !== null &&
          Number(event["provider_slot"]) !== input.slot)
      )
        throw new Error("MIGRATION_EVENT_CONTRADICTS_TRANSACTION");
      const token = this.#db
        .prepare("SELECT migration_slot FROM tokens WHERE mint = ?")
        .get(input.mint) as SqlRow | undefined;
      if (
        !token ||
        (token["migration_slot"] !== null &&
          Number(token["migration_slot"]) !== input.slot)
      )
        throw new Error("MIGRATION_SLOT_CONFLICT");
      const chainTime =
        input.blockTime === null
          ? null
          : new Date(input.blockTime * 1000).toISOString();
      this.#db
        .prepare(
          `UPDATE market_events SET slot = ?, observed_at_utc = COALESCE(?, observed_at_utc),
          chain_time_status = CASE WHEN ? IS NULL THEN chain_time_status ELSE 'RESOLVED' END,
          chain_time_error_code = CASE WHEN ? IS NULL THEN chain_time_error_code ELSE NULL END
          WHERE id = ?`,
        )
        .run(input.slot, chainTime, chainTime, chainTime, input.eventId);
      this.#db
        .prepare(
          `UPDATE tokens SET migration_slot = ?, market_phase = 'MIGRATED_UNKNOWN_VENUE'
          WHERE mint = ?`,
        )
        .run(input.slot, input.mint);
      this.#db
        .prepare(
          `INSERT INTO discovery_checkpoints(provider, last_slot, last_signature, last_event_id, updated_at_utc)
          VALUES ('pumpportal', ?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET
          last_slot = excluded.last_slot, last_signature = excluded.last_signature,
          last_event_id = excluded.last_event_id, updated_at_utc = excluded.updated_at_utc
          WHERE discovery_checkpoints.last_slot IS NULL OR excluded.last_slot >= discovery_checkpoints.last_slot`,
        )
        .run(input.slot, input.signature, input.eventId, utcNow());
      this.#db
        .prepare(
          `UPDATE migration_recovery_jobs SET status = 'COMPLETE', resolved_slot = ?, error_code = NULL,
          updated_at_utc = ? WHERE event_id = ? AND mint = ? AND signature = ?`,
        )
        .run(input.slot, utcNow(), input.eventId, input.mint, input.signature);
      this.#enqueueMigrationAnalysis(input.eventId, input.mint);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  finishMigrationRecoveryJob(
    eventId: string,
    status: "FAILED" | "PENDING",
    errorCode: string,
    retryDelayMs = 0,
  ): void {
    const now = utcNow();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          `UPDATE migration_recovery_jobs SET status = ?, error_code = ?, next_attempt_at_utc = ?, updated_at_utc = ?
          WHERE event_id = ? AND status = 'PROCESSING'`,
        )
        .run(
          status,
          errorCode,
          new Date(Date.now() + retryDelayMs).toISOString(),
          now,
          eventId,
        );
      if (status === "FAILED") {
        const row = this.#db
          .prepare(
            "SELECT mint FROM migration_recovery_jobs WHERE event_id = ?",
          )
          .get(eventId) as SqlRow | undefined;
        if (row) this.#enqueueMigrationAnalysis(eventId, String(row["mint"]));
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  recoverInterruptedMigrationJobs(): number {
    const result = this.#db
      .prepare(
        `UPDATE migration_recovery_jobs SET status = 'PENDING', updated_at_utc = ? WHERE status = 'PROCESSING'`,
      )
      .run(utcNow());
    return Number(result.changes);
  }

  getMigrationRecoveryStatus(mint: string): Array<Record<string, unknown>> {
    return this.#db
      .prepare(
        `SELECT j.event_id AS eventId, j.signature, e.provider_slot AS providerSlot, j.resolved_slot AS resolvedSlot,
        j.status, j.attempts, j.error_code AS errorCode, j.updated_at_utc AS updatedAtUtc
        FROM migration_recovery_jobs j JOIN market_events e ON e.id = j.event_id
        WHERE j.mint = ? ORDER BY j.created_at_utc DESC LIMIT 20`,
      )
      .all(mint) as Array<Record<string, unknown>>;
  }

  #enqueueMigrationAnalysis(eventId: string, mint: string): void {
    const row = this.#db
      .prepare("SELECT received_at_utc FROM market_events WHERE id = ?")
      .get(eventId) as SqlRow | undefined;
    if (!row) return;
    const at = String(row["received_at_utc"]);
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO migration_analysis_jobs(event_id, mint, status, next_attempt_at_utc, created_at_utc, updated_at_utc)
        VALUES (?, ?, 'PENDING', ?, ?, ?)`,
      )
      .run(eventId, mint, at, at, at);
  }

  recordProviderFrameDiagnostic(input: {
    classification:
      | "PROVIDER_ERROR"
      | "PROVIDER_CONTROL"
      | "UNSUPPORTED_FRAME"
      | "MALFORMED_FRAME";
    reasonCode: string;
    sanitizedPayload: string;
    observedAtUtc: string;
  }): void {
    const payload = input.sanitizedPayload.slice(0, 4096);
    this.#db
      .prepare(
        `INSERT INTO provider_frame_diagnostics(provider, classification, reason_code, sanitized_payload, observed_at_utc)
        VALUES ('pumpportal', ?, ?, ?, ?)`,
      )
      .run(
        input.classification,
        input.reasonCode.slice(0, 80),
        payload,
        input.observedAtUtc,
      );
  }

  listProviderFrameDiagnostics(limit = 50): Array<Record<string, unknown>> {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    return this.#db
      .prepare(
        `SELECT classification, reason_code AS reasonCode, sanitized_payload AS sanitizedPayload,
        observed_at_utc AS observedAtUtc FROM provider_frame_diagnostics
        ORDER BY observed_at_utc DESC, id DESC LIMIT ?`,
      )
      .all(safeLimit) as Array<Record<string, unknown>>;
  }

  getAnalysisOutcome(mint: string): Array<Record<string, unknown>> {
    return this.#db
      .prepare(
        `SELECT * FROM (
          SELECT j.event_id AS eventId, e.kind, j.status, j.attempts, j.updated_at_utc AS updatedAtUtc, j.created_at_utc AS createdAtUtc
          FROM analysis_jobs j JOIN market_events e ON e.id = j.event_id WHERE j.mint = ?
          UNION ALL
          SELECT j.event_id AS eventId, e.kind, j.status, j.attempts, j.updated_at_utc AS updatedAtUtc, j.created_at_utc AS createdAtUtc
          FROM migration_analysis_jobs j JOIN market_events e ON e.id = j.event_id WHERE j.mint = ?
        ) ORDER BY createdAtUtc DESC LIMIT 20`,
      )
      .all(mint, mint) as Array<Record<string, unknown>>;
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
          `SELECT event_id, mint, attempts, 'CREATE' AS job_type, created_at_utc FROM analysis_jobs
          WHERE status = 'PENDING' AND next_attempt_at_utc <= ?
          UNION ALL
          SELECT event_id, mint, attempts, 'MIGRATION' AS job_type, created_at_utc FROM migration_analysis_jobs
          WHERE status = 'PENDING' AND next_attempt_at_utc <= ?
          ORDER BY created_at_utc LIMIT 1`,
        )
        .get(now, now) as SqlRow | undefined;
      if (!row) {
        this.#db.exec("COMMIT");
        return null;
      }
      const table =
        row["job_type"] === "MIGRATION"
          ? "migration_analysis_jobs"
          : "analysis_jobs";
      const changed = this.#db
        .prepare(
          `UPDATE ${table} SET status = 'PROCESSING', attempts = attempts + 1, updated_at_utc = ?
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
    const args = [
      retryDelayMs > 0 ? "PENDING" : "COMPLETE",
      new Date(Date.now() + retryDelayMs).toISOString(),
      now,
      eventId,
    ] as const;
    for (const table of ["analysis_jobs", "migration_analysis_jobs"])
      this.#db
        .prepare(
          `UPDATE ${table} SET status = ?, next_attempt_at_utc = ?, updated_at_utc = ?
          WHERE event_id = ?`,
        )
        .run(...args);
  }

  recoverInterruptedAnalysisJobs(): number {
    const now = utcNow();
    let changed = 0;
    for (const table of ["analysis_jobs", "migration_analysis_jobs"])
      changed += Number(
        this.#db
          .prepare(
            `UPDATE ${table} SET status = 'PENDING', updated_at_utc = ?
            WHERE status = 'PROCESSING'`,
          )
          .run(now).changes,
      );
    return changed;
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

  getVerifiedCreatorWallet(mint: string): string | null {
    const row = this.#db
      .prepare(
        `SELECT wallet_pubkey FROM wallet_role_evidence
        WHERE mint = ? AND role = 'CLAIMED_CREATOR' AND source = 'PUMP_IDL_CREATE_EVENT'
          AND confidence_bps = 10000
        ORDER BY slot ASC LIMIT 1`,
      )
      .get(mint) as SqlRow | undefined;
    return row ? String(row["wallet_pubkey"]) : null;
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

  saveWalletTokenOutflow(input: {
    id: string;
    wallet: string;
    mint: string;
    signature: string;
    slot: number;
    beforeAmountRaw: string;
    afterAmountRaw: string;
    observedAtUtc: string | null;
    reasonCode: string;
    confidenceBps: number;
  }): void {
    if (
      !/^\d+$/.test(input.beforeAmountRaw) ||
      !/^\d+$/.test(input.afterAmountRaw) ||
      input.confidenceBps < 0 ||
      input.confidenceBps > 10000
    )
      throw new Error("INVALID_CREATOR_ACTIVITY_EVIDENCE");
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO wallet_token_outflows
        (id, wallet_pubkey, mint, signature, slot, before_amount_raw, after_amount_raw,
        observed_at_utc, reason_code, confidence_bps)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.wallet,
        input.mint,
        input.signature,
        input.slot,
        input.beforeAmountRaw,
        input.afterAmountRaw,
        input.observedAtUtc,
        input.reasonCode,
        input.confidenceBps,
      );
  }

  listWalletTokenOutflows(
    wallet: string,
    asOfSlot: number,
  ): Array<Record<string, unknown>> {
    const rows = this.#db
      .prepare(
        `SELECT id, mint, signature, slot, before_amount_raw, after_amount_raw,
        observed_at_utc, reason_code, confidence_bps FROM wallet_token_outflows
        WHERE wallet_pubkey = ? AND slot <= ? ORDER BY slot, signature`,
      )
      .all(wallet, asOfSlot) as SqlRow[];
    return rows.map((row) => ({
      id: String(row["id"]),
      mint: String(row["mint"]),
      signature: String(row["signature"]),
      slot: Number(row["slot"]),
      beforeAmountRaw: String(row["before_amount_raw"]),
      afterAmountRaw: String(row["after_amount_raw"]),
      observedAtUtc:
        row["observed_at_utc"] === null ? null : String(row["observed_at_utc"]),
      reasonCode: String(row["reason_code"]),
      confidenceBps: Number(row["confidence_bps"]),
    }));
  }

  saveLaunchTradeObservation(input: LaunchTradeObservation): void {
    const observation = LaunchTradeObservationSchema.parse(input);
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO launch_trade_observations
        (id, event_index, mint, signature, slot, block_time_utc, event_time_utc,
        event_time_source, received_at_utc, ingested_at_utc, side, trader_wallet,
        token_amount_raw, quote_amount_raw, quote_mint, venue, source, decoder_version,
        validation_status, validation_confidence_bps, payload_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        observation.id,
        observation.eventIndex,
        observation.mint,
        observation.signature,
        observation.slot,
        observation.blockTimeUtc,
        observation.eventTimeUtc,
        observation.eventTimeSource,
        observation.receivedAtUtc,
        observation.ingestedAtUtc,
        observation.side,
        observation.traderWallet,
        observation.tokenAmountRaw,
        observation.quoteAmountRaw,
        observation.quoteMint,
        observation.venue,
        observation.source,
        observation.decoderVersion,
        observation.validationStatus,
        observation.validationConfidenceBps,
        observation.payloadRef,
      );
  }

  requeueLatestAnalysisForMint(mint: string, delayMs = 0): boolean {
    const nextAttemptAtUtc = new Date(
      Date.now() + Math.max(0, delayMs),
    ).toISOString();
    const changed = this.#db
      .prepare(
        `UPDATE analysis_jobs SET status='PENDING', next_attempt_at_utc=?, updated_at_utc=?
         WHERE event_id=(SELECT id FROM market_events WHERE mint=? AND kind='TOKEN_CREATED'
         ORDER BY first_seen_at_utc ASC, received_at_utc ASC LIMIT 1) AND status='COMPLETE'`,
      )
      .run(nextAttemptAtUtc, utcNow(), mint);
    return Number(changed.changes) === 1;
  }

  recordAnalysisStageTiming(input: {
    eventId: string;
    mint: string;
    stage: string;
    startedAtUtc: string;
    finishedAtUtc: string;
    durationMs: number;
  }): void {
    if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0)
      throw new Error("ANALYSIS_STAGE_DURATION_INVALID");
    this.#db
      .prepare(
        `INSERT INTO analysis_stage_timings
         (event_id, mint, stage, started_at_utc, finished_at_utc, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.eventId,
        input.mint,
        input.stage,
        input.startedAtUtc,
        input.finishedAtUtc,
        input.durationMs,
      );
  }

  getAnalysisLatencySummary(): Array<{
    stage: string;
    sampleCount: number;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
  }> {
    const groups = this.#db
      .prepare(
        "SELECT stage, duration_ms FROM analysis_stage_timings ORDER BY stage, duration_ms",
      )
      .all() as SqlRow[];
    const byStage = new Map<string, number[]>();
    for (const row of groups) {
      const stage = String(row["stage"]);
      const values = byStage.get(stage) ?? [];
      values.push(Number(row["duration_ms"]));
      byStage.set(stage, values);
    }
    return [...byStage].map(([stage, values]) => ({
      stage,
      sampleCount: values.length,
      p50Ms: percentile(values, 0.5),
      p95Ms: values.length >= 20 ? percentile(values, 0.95) : null,
      p99Ms: values.length >= 100 ? percentile(values, 0.99) : null,
    }));
  }

  listLaunchTradeObservations(
    mint: string,
    fromUtc: string,
    throughUtc: string,
    throughSlot: number | null,
    limit = 5000,
  ): LaunchTradeObservation[] {
    const safeLimit = Math.max(1, Math.min(10000, Math.trunc(limit)));
    const rows = this.#db
      .prepare(
        `SELECT * FROM launch_trade_observations WHERE mint = ?
        AND received_at_utc >= ? AND received_at_utc <= ?
        AND (? IS NULL OR slot IS NULL OR slot <= ?)
        ORDER BY received_at_utc, slot LIMIT ?`,
      )
      .all(
        mint,
        fromUtc,
        throughUtc,
        throughSlot,
        throughSlot,
        safeLimit,
      ) as SqlRow[];
    return rows.map((row) =>
      LaunchTradeObservationSchema.parse({
        id: row["id"],
        eventIndex: row["event_index"],
        mint: row["mint"],
        signature: row["signature"],
        slot: row["slot"],
        blockTimeUtc: row["block_time_utc"],
        eventTimeUtc: row["event_time_utc"],
        eventTimeSource: row["event_time_source"],
        receivedAtUtc: row["received_at_utc"],
        ingestedAtUtc: row["ingested_at_utc"],
        side: row["side"],
        traderWallet: row["trader_wallet"],
        tokenAmountRaw: row["token_amount_raw"],
        quoteAmountRaw: row["quote_amount_raw"],
        quoteMint: row["quote_mint"],
        venue: row["venue"],
        source: row["source"],
        decoderVersion: row["decoder_version"],
        validationStatus: row["validation_status"],
        validationConfidenceBps: row["validation_confidence_bps"],
        payloadRef: row["payload_ref"],
      }),
    );
  }

  recordTradeObservationCoverage(input: {
    mint: string;
    source: string;
    status:
      "COMPLETE" | "PARTIAL" | "GAP_DETECTED" | "RECONCILING" | "UNVERIFIED";
    windowStartedAtUtc: string;
    windowExpiresAtUtc: string;
    lastEventAtUtc: string | null;
    reconnectCount: number;
    reasonCode: string;
    updatedAtUtc: string;
  }): void {
    const id = createHash("sha256")
      .update(`${input.source}:${input.mint}:${input.windowStartedAtUtc}`)
      .digest("hex");
    this.#db
      .prepare(
        `INSERT INTO trade_observation_coverage
        (id, mint, source, status, window_started_at_utc, window_expires_at_utc,
         last_event_at_utc, reconnect_count, reason_code, updated_at_utc)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = CASE
            WHEN trade_observation_coverage.status IN ('GAP_DETECTED', 'PARTIAL')
              AND excluded.status = 'UNVERIFIED'
            THEN trade_observation_coverage.status
            ELSE excluded.status
          END,
          window_expires_at_utc = MAX(trade_observation_coverage.window_expires_at_utc, excluded.window_expires_at_utc),
          last_event_at_utc = COALESCE(excluded.last_event_at_utc, trade_observation_coverage.last_event_at_utc),
          reconnect_count = MAX(trade_observation_coverage.reconnect_count, excluded.reconnect_count),
          reason_code = CASE
            WHEN trade_observation_coverage.status IN ('GAP_DETECTED', 'PARTIAL')
              AND excluded.status = 'UNVERIFIED'
            THEN trade_observation_coverage.reason_code
            ELSE excluded.reason_code
          END,
          updated_at_utc = excluded.updated_at_utc`,
      )
      .run(
        id,
        input.mint,
        input.source,
        input.status,
        input.windowStartedAtUtc,
        input.windowExpiresAtUtc,
        input.lastEventAtUtc,
        input.reconnectCount,
        input.reasonCode,
        input.updatedAtUtc,
      );
  }

  getLatestTradeObservationCoverage(mint: string): {
    mint: string;
    source: string;
    status: string;
    windowStartedAtUtc: string;
    windowExpiresAtUtc: string;
    lastEventAtUtc: string | null;
    reconnectCount: number;
    reasonCode: string;
    updatedAtUtc: string;
  } | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM trade_observation_coverage WHERE mint = ?
        ORDER BY updated_at_utc DESC, window_started_at_utc DESC LIMIT 1`,
      )
      .get(mint) as SqlRow | undefined;
    if (!row) return null;
    return {
      mint: String(row["mint"]),
      source: String(row["source"]),
      status: String(row["status"]),
      windowStartedAtUtc: String(row["window_started_at_utc"]),
      windowExpiresAtUtc: String(row["window_expires_at_utc"]),
      lastEventAtUtc:
        row["last_event_at_utc"] === null
          ? null
          : String(row["last_event_at_utc"]),
      reconnectCount: Number(row["reconnect_count"]),
      reasonCode: String(row["reason_code"]),
      updatedAtUtc: String(row["updated_at_utc"]),
    };
  }

  tryConsumeHeliusTradeEvent(maxEventsPerUtcDay: number): boolean {
    if (!Number.isSafeInteger(maxEventsPerUtcDay) || maxEventsPerUtcDay < 1)
      return false;
    const utcDay = utcNow().slice(0, 10);
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO trade_event_budget(provider, utc_day, events_used) VALUES ('helius_logs', ?, 0)",
      )
      .run(utcDay);
    const result = this.#db
      .prepare(
        "UPDATE trade_event_budget SET events_used = events_used + 1 WHERE provider = 'helius_logs' AND utc_day = ? AND events_used < ?",
      )
      .run(utcDay, maxEventsPerUtcDay);
    return Number(result.changes) === 1;
  }

  saveLaunchBehaviorSnapshot(input: LaunchBehaviorSnapshot): void {
    const snapshot = LaunchBehaviorSnapshotSchema.parse(input);
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO launch_behavior_snapshots
        (id, mint, window_seconds, observed_at_utc, through_slot, complete, gap_reason, snapshot_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        snapshot.mint,
        snapshot.windowSeconds,
        snapshot.observedAtUtc,
        snapshot.throughSlot,
        snapshot.complete ? 1 : 0,
        snapshot.gapReason,
        JSON.stringify(snapshot),
      );
  }

  listLaunchBehaviorSnapshots(
    mint: string,
    limit = 100,
  ): LaunchBehaviorSnapshot[] {
    const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    const rows = this.#db
      .prepare(
        `SELECT snapshot_json FROM launch_behavior_snapshots
        WHERE mint = ? ORDER BY observed_at_utc DESC LIMIT ?`,
      )
      .all(mint, safeLimit) as SqlRow[];
    return rows.map((row) =>
      LaunchBehaviorSnapshotSchema.parse(
        JSON.parse(String(row["snapshot_json"])),
      ),
    );
  }

  saveQuoteResult(input: QuoteResult): void {
    const quote = QuoteResultSchema.parse(input);
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO market_quotes
        (id, mint, venue, snapshot_slot, observed_at_utc, validation_status, quote_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        quote.id,
        quote.mint,
        quote.venue,
        quote.snapshotSlot,
        quote.observedAtUtc,
        quote.validationStatus,
        JSON.stringify(quote),
      );
  }

  initializePaperAccount(
    walletId: string,
    initialSolLamports: string,
    createdAtUtc: string,
  ): {
    walletId: string;
    initialSolLamports: string;
    createdAtUtc: string;
    configuredInitialBalanceMatches: boolean;
  } {
    if (!/^\d+$/.test(initialSolLamports) || BigInt(initialSolLamports) <= 0n)
      throw new Error("PAPER_INITIAL_BALANCE_INVALID");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.#db
        .prepare("SELECT * FROM paper_accounts WHERE wallet_id = ?")
        .get(walletId) as SqlRow | undefined;
      if (prior) {
        this.#db.exec("COMMIT");
        return {
          walletId,
          initialSolLamports: String(prior["initial_sol_lamports"]),
          createdAtUtc: String(prior["created_at_utc"]),
          configuredInitialBalanceMatches:
            String(prior["initial_sol_lamports"]) === initialSolLamports,
        };
      }
      this.#db
        .prepare(
          "INSERT INTO paper_accounts(wallet_id, initial_sol_lamports, created_at_utc) VALUES (?, ?, ?)",
        )
        .run(walletId, initialSolLamports, createdAtUtc);
      const journalId = `paper-opening:${walletId}`;
      this.#db
        .prepare(
          `INSERT INTO paper_journals(id, wallet_id, order_id, journal_type, created_at_utc, evidence_json)
           VALUES (?, ?, NULL, 'OPENING_BALANCE', ?, '{}')`,
        )
        .run(journalId, walletId, createdAtUtc);
      this.#insertPaperLedgerPair({
        journalId,
        walletId,
        assetMint: WSOL_MINT,
        leftAccount: "WALLET",
        leftDelta: BigInt(initialSolLamports),
        rightAccount: "OPENING_EQUITY",
        rightDelta: -BigInt(initialSolLamports),
        createdAtUtc,
      });
      this.#db.exec("COMMIT");
      return {
        walletId,
        initialSolLamports,
        createdAtUtc,
        configuredInitialBalanceMatches: true,
      };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getPaperAccountInitialization(
    walletId: string,
  ): { initialSolLamports: string; createdAtUtc: string } | null {
    const row = this.#db
      .prepare(
        "SELECT initial_sol_lamports, created_at_utc FROM paper_accounts WHERE wallet_id = ?",
      )
      .get(walletId) as SqlRow | undefined;
    return row
      ? {
          initialSolLamports: String(row["initial_sol_lamports"]),
          createdAtUtc: String(row["created_at_utc"]),
        }
      : null;
  }

  createPaperOrder(intentInput: PaperOrderIntent): {
    id: string;
    walletId: string;
    idempotencyKey: string;
    mint: string;
    side: "BUY" | "SELL";
    inputAmountRaw: string;
    status:
      "PENDING" | "SIMULATED_FILLED" | "REJECTED" | "UNFILLABLE" | "EXPIRED";
    reasonCode: string | null;
    createdAtUtc: string;
    entrySource: "AUTOMATIC" | "MANUAL";
  } {
    const intent = PaperOrderIntentSchema.parse(intentInput);
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO paper_orders
         (id, wallet_id, idempotency_key, mint, side, input_amount_raw, intent_json, status, created_at_utc, entry_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      )
      .run(
        intent.id,
        intent.walletId,
        intent.idempotencyKey,
        intent.mint,
        intent.side,
        intent.exactInputAmountRaw,
        JSON.stringify(intent),
        intent.createdAtUtc,
        intent.entrySource ?? "AUTOMATIC",
      );
    const row = this.#db
      .prepare("SELECT * FROM paper_orders WHERE idempotency_key = ?")
      .get(intent.idempotencyKey) as SqlRow | undefined;
    if (!row || String(row["intent_json"]) !== JSON.stringify(intent))
      throw new Error("PAPER_ORDER_IDEMPOTENCY_CONFLICT");
    return mapPaperOrder(row);
  }

  getPaperOrder(orderId: string) {
    const row = this.#db
      .prepare("SELECT * FROM paper_orders WHERE id = ?")
      .get(orderId) as SqlRow | undefined;
    return row ? mapPaperOrder(row) : null;
  }

  synchronizePendingManualOrderExpiry(
    orderId: string,
    expiresAtUtc: string,
  ): void {
    const row = this.#db
      .prepare(
        "SELECT intent_json, status, entry_source FROM paper_orders WHERE id = ?",
      )
      .get(orderId) as SqlRow | undefined;
    if (!row || row["status"] !== "PENDING" || row["entry_source"] !== "MANUAL")
      return;
    const intent = PaperOrderIntentSchema.parse(
      JSON.parse(String(row["intent_json"])),
    );
    if (intent.expiresAtUtc) return;
    this.#db
      .prepare(
        "UPDATE paper_orders SET intent_json = ? WHERE id = ? AND status = 'PENDING'",
      )
      .run(JSON.stringify({ ...intent, expiresAtUtc }), orderId);
  }

  listPendingPaperOrderIntents(
    limit = 100,
    excludeManual = false,
  ): PaperOrderIntent[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.#db
      .prepare(
        "SELECT intent_json FROM paper_orders WHERE status = 'PENDING' AND (? = 0 OR entry_source != 'MANUAL') ORDER BY created_at_utc, id LIMIT ?",
      )
      .all(excludeManual ? 1 : 0, safeLimit) as SqlRow[];
    return rows.map((row) =>
      PaperOrderIntentSchema.parse(JSON.parse(String(row["intent_json"]))),
    );
  }

  createManualPaperRequest(input: {
    id: string;
    idempotencyKey: string;
    requestType: "ENTRY" | "EXIT";
    walletId: string;
    mint: string;
    positionId?: string | null;
    requestedAmountRaw: string;
    requestedSizeSol?: string | null;
    originalCoverageStatus?: string | null;
    coverageExceptionReason?: string | null;
    evidence?: Record<string, unknown>;
    createdAtUtc: string;
    expiresAtUtc?: string | null;
  }): ManualPaperRequest {
    if (
      !/^\d+$/.test(input.requestedAmountRaw) ||
      BigInt(input.requestedAmountRaw) <= 0n
    )
      throw new Error("MANUAL_PAPER_AMOUNT_INVALID");
    if (
      input.expiresAtUtc &&
      (!Number.isFinite(Date.parse(input.expiresAtUtc)) ||
        Date.parse(input.expiresAtUtc) <= Date.parse(input.createdAtUtc))
    )
      throw new Error("MANUAL_PAPER_EXPIRY_INVALID");
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO manual_paper_requests
        (id, idempotency_key, request_type, wallet_id, mint, position_id,
         requested_amount_raw, requested_size_sol, status, original_coverage_status,
         coverage_exception_reason, evidence_json, created_at_utc, updated_at_utc,
         expires_at_utc)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.idempotencyKey,
        input.requestType,
        input.walletId,
        input.mint,
        input.positionId ?? null,
        input.requestedAmountRaw,
        input.requestedSizeSol ?? null,
        input.originalCoverageStatus ?? null,
        input.coverageExceptionReason ?? null,
        JSON.stringify(input.evidence ?? {}),
        input.createdAtUtc,
        input.createdAtUtc,
        input.expiresAtUtc ?? null,
      );
    const row = this.#db
      .prepare("SELECT * FROM manual_paper_requests WHERE idempotency_key = ?")
      .get(input.idempotencyKey) as SqlRow | undefined;
    if (!row) throw new Error("MANUAL_PAPER_REQUEST_CONFLICT");
    const request = mapManualPaperRequest(row);
    if (
      request.requestType !== input.requestType ||
      request.walletId !== input.walletId ||
      request.mint !== input.mint ||
      request.positionId !== (input.positionId ?? null) ||
      request.requestedAmountRaw !== input.requestedAmountRaw
    )
      throw new Error("MANUAL_PAPER_IDEMPOTENCY_CONFLICT");
    return request;
  }

  getManualPaperRequest(id: string): ManualPaperRequest | null {
    const row = this.#db
      .prepare("SELECT * FROM manual_paper_requests WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? mapManualPaperRequest(row) : null;
  }

  getManualPaperRequestByIdempotencyKey(
    key: string,
  ): ManualPaperRequest | null {
    const row = this.#db
      .prepare("SELECT * FROM manual_paper_requests WHERE idempotency_key = ?")
      .get(key) as SqlRow | undefined;
    return row ? mapManualPaperRequest(row) : null;
  }

  listManualPaperRequests(walletId: string, limit = 50): ManualPaperRequest[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM manual_paper_requests WHERE wallet_id = ? ORDER BY created_at_utc DESC LIMIT ?",
      )
      .all(walletId, Math.max(1, Math.min(200, Math.trunc(limit)))) as SqlRow[];
    return rows.map(mapManualPaperRequest);
  }

  claimManualPaperRequest(
    walletId: string,
    nowUtc: string,
  ): ManualPaperRequest | null {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db
        .prepare(
          `SELECT * FROM manual_paper_requests WHERE wallet_id = ? AND status = 'PENDING'
           AND (next_attempt_at_utc IS NULL OR next_attempt_at_utc <= ?)
           ORDER BY created_at_utc, id LIMIT 1`,
        )
        .get(walletId, nowUtc) as SqlRow | undefined;
      if (!row) {
        this.#db.exec("COMMIT");
        return null;
      }
      this.#db
        .prepare(
          `UPDATE manual_paper_requests SET status = 'PROCESSING', attempts = attempts + 1,
           claimed_at_utc = ?, updated_at_utc = ? WHERE id = ? AND status = 'PENDING'`,
        )
        .run(nowUtc, nowUtc, String(row["id"]));
      const claimed = this.#db
        .prepare("SELECT * FROM manual_paper_requests WHERE id = ?")
        .get(String(row["id"])) as SqlRow;
      this.#db.exec("COMMIT");
      return mapManualPaperRequest(claimed);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  finishManualPaperRequest(input: {
    id: string;
    status: "PENDING" | "FILLED" | "REJECTED" | "UNFILLABLE";
    reasonCode: string | null;
    executionOrderId?: string | null;
    evidence?: Record<string, unknown>;
    coverageExceptionReason?: string | null;
    nextAttemptAtUtc?: string | null;
    completedAtUtc?: string | null;
    resetExecutionOrder?: boolean;
  }): void {
    this.#db
      .prepare(
        `UPDATE manual_paper_requests SET status = ?, reason_code = ?,
         execution_order_id = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, execution_order_id) END,
         coverage_exception_reason = COALESCE(?, coverage_exception_reason),
         evidence_json = CASE WHEN ? IS NULL THEN evidence_json ELSE ? END,
         next_attempt_at_utc = ?, updated_at_utc = ?, completed_at_utc = ?
         WHERE id = ? AND status = 'PROCESSING'`,
      )
      .run(
        input.status,
        input.reasonCode,
        input.resetExecutionOrder ? 1 : 0,
        input.executionOrderId ?? null,
        input.coverageExceptionReason ?? null,
        input.evidence === undefined ? null : JSON.stringify(input.evidence),
        input.evidence === undefined ? null : JSON.stringify(input.evidence),
        input.nextAttemptAtUtc ?? null,
        input.completedAtUtc ?? utcNow(),
        input.completedAtUtc ?? null,
        input.id,
      );
  }

  setManualPaperExecutionOrder(id: string, orderId: string): void {
    this.#db
      .prepare(
        `UPDATE manual_paper_requests SET execution_order_id = ?, updated_at_utc = ?
       WHERE id = ? AND status = 'PROCESSING'`,
      )
      .run(orderId, utcNow(), id);
  }

  recoverInterruptedManualPaperRequests(nowUtc: string): number {
    const result = this.#db
      .prepare(
        `UPDATE manual_paper_requests SET status = 'PENDING', updated_at_utc = ?,
         next_attempt_at_utc = NULL WHERE status = 'PROCESSING'`,
      )
      .run(nowUtc);
    return Number(result.changes);
  }

  rejectPaperOrder(
    orderId: string,
    status: "REJECTED" | "UNFILLABLE" | "EXPIRED",
    reasonCode: string,
    completedAtUtc: string,
    arrivalAtUtc: string | null = null,
  ): void {
    this.#db
      .prepare(
        `UPDATE paper_orders SET status = ?, reason_code = ?, arrival_at_utc = COALESCE(?, arrival_at_utc), completed_at_utc = ?
         WHERE id = ? AND status = 'PENDING'`,
      )
      .run(status, reasonCode, arrivalAtUtc, completedAtUtc, orderId);
  }

  applyPaperFill(input: {
    orderId: string;
    quote: QuoteResult;
    outputAmountRaw: string;
    venueFeeRaw: string;
    networkFeeLamports: string;
    extraSlippageBps: number;
    maxSlippageBps: number;
    maxPriceImpactBps: number;
    arrivalAtUtc: string;
    filledAtUtc: string;
    maxTradeInputRaw: string;
    maxExposureLamports: string;
    maxOpenPositions: number;
    maxDailyLossLamports: string;
    maxDrawdownBps: number;
    maxQuoteAgeMs: number;
    pauseNewEntries: boolean;
  }): { status: "SIMULATED_FILLED" | "REJECTED"; reasonCode: string | null } {
    const quote = QuoteResultSchema.parse(input.quote);
    if (
      !/^\d+$/.test(input.outputAmountRaw) ||
      !/^\d+$/.test(input.venueFeeRaw) ||
      !/^\d+$/.test(input.networkFeeLamports) ||
      input.extraSlippageBps < 0 ||
      input.extraSlippageBps > 10000 ||
      input.extraSlippageBps > input.maxSlippageBps
    )
      throw new Error("PAPER_FILL_AMOUNT_INVALID");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db
        .prepare("SELECT * FROM paper_orders WHERE id = ?")
        .get(input.orderId) as SqlRow | undefined;
      if (!row) throw new Error("PAPER_ORDER_NOT_FOUND");
      if (row["status"] !== "PENDING") {
        this.#db.exec("COMMIT");
        return {
          status:
            row["status"] === "SIMULATED_FILLED"
              ? "SIMULATED_FILLED"
              : "REJECTED",
          reasonCode:
            row["reason_code"] === null ? null : String(row["reason_code"]),
        };
      }
      const walletId = String(row["wallet_id"]);
      const mint = String(row["mint"]);
      const side = String(row["side"]) as "BUY" | "SELL";
      const amount = BigInt(String(row["input_amount_raw"]));
      const networkFee = BigInt(input.networkFeeLamports);
      const output = BigInt(input.outputAmountRaw);
      const venueFee = BigInt(input.venueFeeRaw);
      const reject = (reasonCode: string) => {
        this.#db
          .prepare(
            `UPDATE paper_orders SET status = 'REJECTED', reason_code = ?, arrival_at_utc = ?, completed_at_utc = ?
             WHERE id = ? AND status = 'PENDING'`,
          )
          .run(
            reasonCode,
            input.arrivalAtUtc,
            input.filledAtUtc,
            input.orderId,
          );
        this.#db.exec("COMMIT");
        return { status: "REJECTED" as const, reasonCode };
      };
      if (input.pauseNewEntries && side === "BUY")
        return reject("PAPER_NEW_ENTRIES_PAUSED");
      const storedQuoteRow = this.#db
        .prepare("SELECT quote_json FROM market_quotes WHERE id = ?")
        .get(quote.id) as SqlRow | undefined;
      if (
        !storedQuoteRow ||
        String(storedQuoteRow["quote_json"]) !== JSON.stringify(quote)
      )
        return reject("PAPER_QUOTE_NOT_PERSISTED");
      if (side === "BUY" && amount > BigInt(input.maxTradeInputRaw))
        return reject("PAPER_MAX_TRADE_EXCEEDED");
      if (
        quote.validationStatus !== "PASS" ||
        quote.mint !== mint ||
        quote.direction !== side ||
        quote.exactInputAmountRaw !== amount.toString() ||
        quote.inputMint !== (side === "BUY" ? WSOL_MINT : mint) ||
        quote.outputMint !== (side === "BUY" ? mint : WSOL_MINT) ||
        quote.venue === null ||
        quote.priceImpactBps === null ||
        quote.priceImpactBps > input.maxPriceImpactBps ||
        quote.feeAmountRaw === null ||
        quote.feeMint !== WSOL_MINT ||
        BigInt(input.venueFeeRaw) !== BigInt(quote.feeAmountRaw) ||
        (side === "BUY" && BigInt(quote.feeAmountRaw) > amount) ||
        !quote.expectedOutputAmountRaw ||
        output > BigInt(quote.expectedOutputAmountRaw) ||
        quote.snapshotSlot === null ||
        quote.snapshotAtUtc === null ||
        Date.parse(quote.observedAtUtc) > Date.parse(input.filledAtUtc) ||
        Date.parse(quote.snapshotAtUtc) > Date.parse(input.filledAtUtc) ||
        (quote.freshnessMs ?? Number.MAX_SAFE_INTEGER) > input.maxQuoteAgeMs ||
        Date.parse(input.filledAtUtc) - Date.parse(quote.snapshotAtUtc) >
          input.maxQuoteAgeMs
      )
        return reject("PAPER_QUOTE_INVALID_OR_STALE");
      if (output <= 0n) return reject("PAPER_OUTPUT_ZERO");
      const balance = (assetMint: string) =>
        this.#sumLedger(walletId, assetMint, "WALLET");
      const position = this.#db
        .prepare(
          "SELECT token_amount_raw, cost_basis_lamports, opened_at_utc FROM paper_positions WHERE wallet_id = ? AND mint = ?",
        )
        .get(walletId, mint) as SqlRow | undefined;
      if (side === "BUY") {
        if (amount + networkFee > balance(WSOL_MINT))
          return reject("PAPER_INSUFFICIENT_SOL");
        const exposure = this.#sumOpenCostBasis(walletId);
        if (exposure + amount + networkFee > BigInt(input.maxExposureLamports))
          return reject("PAPER_MAX_EXPOSURE_EXCEEDED");
        const positionExists =
          position && BigInt(String(position["token_amount_raw"])) > 0n;
        const openRows = this.#db
          .prepare(
            "SELECT token_amount_raw FROM paper_positions WHERE wallet_id = ?",
          )
          .all(walletId) as SqlRow[];
        const openCount = openRows.filter(
          (openRow) => BigInt(String(openRow["token_amount_raw"])) > 0n,
        ).length;
        if (!positionExists && openCount >= input.maxOpenPositions)
          return reject("PAPER_MAX_OPEN_POSITIONS");
        const day = input.filledAtUtc.slice(0, 10);
        const dailyPnl = this.#sumRealizedSince(walletId, day);
        if (dailyPnl <= -BigInt(input.maxDailyLossLamports))
          return reject("PAPER_DAILY_LOSS_LIMIT");
        const latestMark = this.#db
          .prepare(
            "SELECT * FROM paper_equity_marks WHERE wallet_id = ? ORDER BY marked_at_utc DESC LIMIT 1",
          )
          .get(walletId) as SqlRow | undefined;
        if (openCount > 0 && !latestMark)
          return reject("PAPER_RISK_MARK_UNAVAILABLE");
        if (latestMark) {
          if (
            Date.parse(input.filledAtUtc) -
              Date.parse(String(latestMark["marked_at_utc"])) >
            input.maxQuoteAgeMs
          )
            return reject("PAPER_RISK_MARK_STALE");
          if (Number(latestMark["unpriceable_positions"]) > 0)
            return reject("PAPER_UNPRICEABLE_EXPOSURE");
          if (Number(latestMark["drawdown_bps"]) >= input.maxDrawdownBps)
            return reject("PAPER_DRAWDOWN_LIMIT");
        }
      } else if (
        !position ||
        BigInt(String(position["token_amount_raw"])) < amount
      ) {
        return reject("PAPER_INSUFFICIENT_TOKEN_BALANCE");
      } else if (balance(WSOL_MINT) + output < networkFee) {
        return reject("PAPER_INSUFFICIENT_SOL_FOR_NETWORK_FEE");
      }

      const journalId = `paper-fill:${input.orderId}`;
      const fillEvidence = {
        quoteId: quote.id,
        quoteProvenance: quote.provenance,
        snapshotSlot: quote.snapshotSlot,
        snapshotAtUtc: quote.snapshotAtUtc,
        venueFeeRaw: input.venueFeeRaw,
        networkFeeLamports: input.networkFeeLamports,
        extraSlippageBps: input.extraSlippageBps,
      };
      this.#db
        .prepare(
          `INSERT INTO paper_journals(id, wallet_id, order_id, journal_type, created_at_utc, evidence_json)
           VALUES (?, ?, ?, 'TRADE_FILL', ?, ?)`,
        )
        .run(
          journalId,
          walletId,
          input.orderId,
          input.filledAtUtc,
          JSON.stringify(fillEvidence),
        );
      const entries: Array<{ account: string; asset: string; delta: bigint }> =
        [];
      const add = (account: string, asset: string, delta: bigint) =>
        entries.push({ account, asset, delta });
      if (side === "BUY") {
        add("WALLET", WSOL_MINT, -amount);
        add("VENUE_CLEARING", WSOL_MINT, amount - venueFee);
        if (venueFee > 0n) add("VENUE_FEE", WSOL_MINT, venueFee);
        add("WALLET", WSOL_MINT, -networkFee);
        if (networkFee > 0n) add("NETWORK_FEE", WSOL_MINT, networkFee);
        add("WALLET", mint, output);
        add("VENUE_CLEARING", mint, -output);
      } else {
        add("WALLET", mint, -amount);
        add("VENUE_CLEARING", mint, amount);
        add("WALLET", WSOL_MINT, output);
        add("VENUE_CLEARING", WSOL_MINT, -(output + venueFee));
        if (venueFee > 0n) add("VENUE_FEE", WSOL_MINT, venueFee);
        add("WALLET", WSOL_MINT, -networkFee);
        if (networkFee > 0n) add("NETWORK_FEE", WSOL_MINT, networkFee);
      }
      this.#insertPaperJournalEntries(
        journalId,
        walletId,
        entries,
        input.filledAtUtc,
      );
      let realizedOnSell: bigint | null = null;
      if (side === "BUY") {
        const nextTokens =
          BigInt(String(position?.["token_amount_raw"] ?? "0")) + output;
        const nextCostBasis =
          BigInt(String(position?.["cost_basis_lamports"] ?? "0")) +
          amount +
          networkFee;
        this.#db
          .prepare(
            `INSERT INTO paper_positions(wallet_id, mint, token_amount_raw, cost_basis_lamports, opened_at_utc, updated_at_utc)
             VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(wallet_id, mint) DO UPDATE SET
             token_amount_raw = excluded.token_amount_raw, cost_basis_lamports = excluded.cost_basis_lamports,
             opened_at_utc = CASE WHEN paper_positions.token_amount_raw = '0' THEN excluded.opened_at_utc ELSE paper_positions.opened_at_utc END,
             updated_at_utc = excluded.updated_at_utc`,
          )
          .run(
            walletId,
            mint,
            nextTokens.toString(),
            nextCostBasis.toString(),
            input.filledAtUtc,
            input.filledAtUtc,
          );
      } else {
        const currentTokens = BigInt(String(position!["token_amount_raw"]));
        const currentCost = BigInt(String(position!["cost_basis_lamports"]));
        const allocatedCost = (currentCost * amount) / currentTokens;
        realizedOnSell = output - networkFee - allocatedCost;
        const nextTokens = currentTokens - amount;
        const nextCost = currentCost - allocatedCost;
        this.#db
          .prepare(
            `UPDATE paper_positions SET token_amount_raw = ?, cost_basis_lamports = ?, updated_at_utc = ?
             WHERE wallet_id = ? AND mint = ?`,
          )
          .run(
            nextTokens.toString(),
            nextCost.toString(),
            input.filledAtUtc,
            walletId,
            mint,
          );
      }
      this.#db
        .prepare(
          `INSERT INTO paper_fills
           (order_id, wallet_id, mint, side, input_amount_raw, output_amount_raw, venue_fee_raw,
            network_fee_lamports, extra_slippage_bps, quote_id, venue, snapshot_slot,
            snapshot_at_utc, arrival_at_utc, filled_at_utc, evidence_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.orderId,
          walletId,
          mint,
          side,
          amount.toString(),
          output.toString(),
          venueFee.toString(),
          networkFee.toString(),
          input.extraSlippageBps,
          quote.id,
          quote.venue,
          quote.snapshotSlot,
          quote.snapshotAtUtc,
          input.arrivalAtUtc,
          input.filledAtUtc,
          JSON.stringify(fillEvidence),
        );
      if (realizedOnSell !== null)
        this.#db
          .prepare(
            "INSERT INTO paper_realized_pnl(order_id, wallet_id, mint, pnl_lamports, filled_at_utc) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            input.orderId,
            walletId,
            mint,
            realizedOnSell.toString(),
            input.filledAtUtc,
          );
      this.#db
        .prepare(
          `UPDATE paper_orders SET status = 'SIMULATED_FILLED', reason_code = NULL,
           arrival_at_utc = ?, completed_at_utc = ? WHERE id = ? AND status = 'PENDING'`,
        )
        .run(input.arrivalAtUtc, input.filledAtUtc, input.orderId);
      this.#db.exec("COMMIT");
      return { status: "SIMULATED_FILLED", reasonCode: null };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getPaperPortfolioState(walletId: string): {
    solBalanceRaw: string;
    positions: Array<{
      mint: string;
      tokenAmountRaw: string;
      costBasisLamports: string;
      openedAtUtc: string;
      latestMark: {
        markedAtUtc: string;
        sellQuoteId: string;
        sellValueLamports: string;
        unrealizedPnlLamports: string;
        snapshotSlot: number;
      } | null;
    }>;
    realizedPnl: Array<{ pnlLamports: string; filledAtUtc: string }>;
    latestMark: {
      markedAtUtc: string;
      equityLamports: string;
      peakEquityLamports: string;
      drawdownBps: number;
      unpriceablePositions: number;
    } | null;
  } {
    const positions = this.#db
      .prepare(
        "SELECT mint, token_amount_raw, cost_basis_lamports, opened_at_utc FROM paper_positions WHERE wallet_id = ? AND token_amount_raw != '0'",
      )
      .all(walletId) as SqlRow[];
    const realizedPnl = this.#db
      .prepare(
        "SELECT pnl_lamports, filled_at_utc FROM paper_realized_pnl WHERE wallet_id = ? ORDER BY filled_at_utc",
      )
      .all(walletId) as SqlRow[];
    const mark = this.#db
      .prepare(
        "SELECT * FROM paper_equity_marks WHERE wallet_id = ? ORDER BY marked_at_utc DESC LIMIT 1",
      )
      .get(walletId) as SqlRow | undefined;
    return {
      solBalanceRaw: this.#sumLedger(walletId, WSOL_MINT, "WALLET").toString(),
      positions: positions.map((row) => ({
        mint: String(row["mint"]),
        tokenAmountRaw: String(row["token_amount_raw"]),
        costBasisLamports: String(row["cost_basis_lamports"]),
        openedAtUtc: String(row["opened_at_utc"]),
        latestMark: this.getLatestPaperPositionMark(
          walletId,
          String(row["mint"]),
        ),
      })),
      realizedPnl: realizedPnl.map((row) => ({
        pnlLamports: String(row["pnl_lamports"]),
        filledAtUtc: String(row["filled_at_utc"]),
      })),
      latestMark: mark
        ? {
            markedAtUtc: String(mark["marked_at_utc"]),
            equityLamports: String(mark["equity_lamports"]),
            peakEquityLamports: String(mark["peak_equity_lamports"]),
            drawdownBps: Number(mark["drawdown_bps"]),
            unpriceablePositions: Number(mark["unpriceable_positions"]),
          }
        : null,
    };
  }

  recordPaperPositionMark(input: {
    walletId: string;
    mint: string;
    markedAtUtc: string;
    sellQuoteId: string;
    sellValueLamports: string;
    unrealizedPnlLamports: string;
    snapshotSlot: number;
  }): void {
    if (
      !/^\d+$/.test(input.sellValueLamports) ||
      !Number.isSafeInteger(input.snapshotSlot) ||
      input.snapshotSlot < 0
    )
      throw new Error("PAPER_POSITION_MARK_INVALID");
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO paper_position_marks
       (wallet_id, mint, marked_at_utc, sell_quote_id, sell_value_lamports, unrealized_pnl_lamports, snapshot_slot)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.walletId,
        input.mint,
        input.markedAtUtc,
        input.sellQuoteId,
        input.sellValueLamports,
        input.unrealizedPnlLamports,
        input.snapshotSlot,
      );
  }

  getLatestPaperPositionMark(
    walletId: string,
    mint: string,
  ): {
    markedAtUtc: string;
    sellQuoteId: string;
    sellValueLamports: string;
    unrealizedPnlLamports: string;
    snapshotSlot: number;
  } | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM paper_position_marks WHERE wallet_id = ? AND mint = ? ORDER BY marked_at_utc DESC LIMIT 1`,
      )
      .get(walletId, mint) as SqlRow | undefined;
    return row
      ? {
          markedAtUtc: String(row["marked_at_utc"]),
          sellQuoteId: String(row["sell_quote_id"]),
          sellValueLamports: String(row["sell_value_lamports"]),
          unrealizedPnlLamports: String(row["unrealized_pnl_lamports"]),
          snapshotSlot: Number(row["snapshot_slot"]),
        }
      : null;
  }

  listPaperFills(
    walletId: string,
    limit = 50,
  ): Array<Record<string, string | number>> {
    const rows = this.#db
      .prepare(
        `SELECT order_id FROM paper_fills WHERE wallet_id = ? ORDER BY filled_at_utc DESC LIMIT ?`,
      )
      .all(walletId, Math.max(1, Math.min(200, Math.trunc(limit)))) as SqlRow[];
    return rows.flatMap((row) => {
      const fill = this.getPaperFill(String(row["order_id"]));
      return fill ? [fill] : [];
    });
  }

  getPaperPositionMonitorState(
    walletId: string,
    mint: string,
  ): {
    status: "OPEN" | "UNPRICEABLE" | "EXIT_BLOCKED" | "EXIT_PENDING" | "CLOSED";
    reasonCode: string | null;
    retryCount: number;
    nextRetryAtUtc: string | null;
  } | null {
    const row = this.#db
      .prepare(
        "SELECT status, reason_code, retry_count, next_retry_at_utc FROM paper_position_monitor_state WHERE wallet_id = ? AND mint = ?",
      )
      .get(walletId, mint) as SqlRow | undefined;
    if (!row) return null;
    return {
      status: String(row["status"]) as
        "OPEN" | "UNPRICEABLE" | "EXIT_BLOCKED" | "EXIT_PENDING" | "CLOSED",
      reasonCode:
        row["reason_code"] === null ? null : String(row["reason_code"]),
      retryCount: Number(row["retry_count"]),
      nextRetryAtUtc:
        row["next_retry_at_utc"] === null
          ? null
          : String(row["next_retry_at_utc"]),
    };
  }

  listPaperPositionMonitorStates(walletId: string): Array<{
    mint: string;
    status: "OPEN" | "UNPRICEABLE" | "EXIT_BLOCKED" | "EXIT_PENDING" | "CLOSED";
    reasonCode: string | null;
    retryCount: number;
    nextRetryAtUtc: string | null;
  }> {
    const rows = this.#db
      .prepare(
        "SELECT mint, status, reason_code, retry_count, next_retry_at_utc FROM paper_position_monitor_state WHERE wallet_id = ? ORDER BY updated_at_utc, mint",
      )
      .all(walletId) as SqlRow[];
    return rows.map((row) => ({
      mint: String(row["mint"]),
      status: String(row["status"]) as
        "OPEN" | "UNPRICEABLE" | "EXIT_BLOCKED" | "EXIT_PENDING" | "CLOSED",
      reasonCode:
        row["reason_code"] === null ? null : String(row["reason_code"]),
      retryCount: Number(row["retry_count"]),
      nextRetryAtUtc:
        row["next_retry_at_utc"] === null
          ? null
          : String(row["next_retry_at_utc"]),
    }));
  }

  recordPaperPositionMonitorState(input: {
    walletId: string;
    mint: string;
    status: "OPEN" | "UNPRICEABLE" | "EXIT_BLOCKED" | "EXIT_PENDING" | "CLOSED";
    reasonCode: string | null;
    retryCount: number;
    nextRetryAtUtc: string | null;
    updatedAtUtc: string;
  }): void {
    if (!Number.isSafeInteger(input.retryCount) || input.retryCount < 0)
      throw new Error("PAPER_MONITOR_RETRY_COUNT_INVALID");
    this.#db
      .prepare(
        `INSERT INTO paper_position_monitor_state
         (wallet_id, mint, status, reason_code, retry_count, next_retry_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(wallet_id, mint) DO UPDATE SET status=excluded.status,
         reason_code=excluded.reason_code, retry_count=excluded.retry_count,
         next_retry_at_utc=excluded.next_retry_at_utc, updated_at_utc=excluded.updated_at_utc`,
      )
      .run(
        input.walletId,
        input.mint,
        input.status,
        input.reasonCode,
        input.retryCount,
        input.nextRetryAtUtc,
        input.updatedAtUtc,
      );
  }

  recordPaperEquityMark(
    walletId: string,
    equityLamports: string,
    unpriceablePositions: number,
    markedAtUtc: string,
  ): {
    peakEquityLamports: string;
    drawdownBps: number;
  } {
    if (!/^\d+$/.test(equityLamports) || unpriceablePositions < 0)
      throw new Error("PAPER_EQUITY_MARK_INVALID");
    const prior = this.#db
      .prepare(
        "SELECT peak_equity_lamports FROM paper_equity_marks WHERE wallet_id = ? ORDER BY marked_at_utc DESC LIMIT 1",
      )
      .get(walletId) as SqlRow | undefined;
    const initial = this.#db
      .prepare(
        "SELECT initial_sol_lamports FROM paper_accounts WHERE wallet_id = ?",
      )
      .get(walletId) as SqlRow | undefined;
    if (!initial) throw new Error("PAPER_ACCOUNT_NOT_FOUND");
    const priorPeak = BigInt(
      String(
        prior?.["peak_equity_lamports"] ?? initial["initial_sol_lamports"],
      ),
    );
    const equity = BigInt(equityLamports);
    const peak = equity > priorPeak ? equity : priorPeak;
    const drawdown =
      peak === 0n ? 0 : Number(((peak - equity) * 10000n) / peak);
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO paper_equity_marks
         (wallet_id, marked_at_utc, equity_lamports, peak_equity_lamports, drawdown_bps, unpriceable_positions)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        walletId,
        markedAtUtc,
        equityLamports,
        peak.toString(),
        drawdown,
        unpriceablePositions,
      );
    return { peakEquityLamports: peak.toString(), drawdownBps: drawdown };
  }

  getPaperFill(orderId: string): Record<string, string | number> | null {
    const row = this.#db
      .prepare(
        "SELECT f.*, o.entry_source FROM paper_fills f JOIN paper_orders o ON o.id = f.order_id WHERE f.order_id = ?",
      )
      .get(orderId) as SqlRow | undefined;
    if (!row) return null;
    return {
      orderId: String(row["order_id"]),
      walletId: String(row["wallet_id"]),
      mint: String(row["mint"]),
      side: String(row["side"]),
      inputAmountRaw: String(row["input_amount_raw"]),
      outputAmountRaw: String(row["output_amount_raw"]),
      venueFeeRaw: String(row["venue_fee_raw"]),
      networkFeeLamports: String(row["network_fee_lamports"]),
      extraSlippageBps: Number(row["extra_slippage_bps"]),
      quoteId: String(row["quote_id"]),
      venue: String(row["venue"]),
      snapshotSlot: Number(row["snapshot_slot"]),
      snapshotAtUtc: String(row["snapshot_at_utc"]),
      arrivalAtUtc: String(row["arrival_at_utc"]),
      filledAtUtc: String(row["filled_at_utc"]),
      entrySource: String(row["entry_source"] ?? "AUTOMATIC"),
    };
  }

  listPaperLedgerEntries(walletId: string): Array<{
    journalId: string;
    account: string;
    assetMint: string;
    deltaRaw: string;
    createdAtUtc: string;
  }> {
    return (
      this.#db
        .prepare(
          `SELECT journal_id, account, asset_mint, delta_raw, created_at_utc
         FROM paper_ledger_entries WHERE wallet_id = ? ORDER BY created_at_utc, id`,
        )
        .all(walletId) as SqlRow[]
    ).map((row) => ({
      journalId: String(row["journal_id"]),
      account: String(row["account"]),
      assetMint: String(row["asset_mint"]),
      deltaRaw: String(row["delta_raw"]),
      createdAtUtc: String(row["created_at_utc"]),
    }));
  }

  listQuoteResults(mint: string, limit = 50): QuoteResult[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.#db
      .prepare(
        `SELECT quote_json FROM market_quotes WHERE mint = ?
        ORDER BY observed_at_utc DESC LIMIT ?`,
      )
      .all(mint, safeLimit) as SqlRow[];
    return rows.map((row) =>
      QuoteResultSchema.parse(JSON.parse(String(row["quote_json"]))),
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

  #sumLedger(walletId: string, assetMint: string, account: string): bigint {
    const rows = this.#db
      .prepare(
        "SELECT delta_raw FROM paper_ledger_entries WHERE wallet_id = ? AND asset_mint = ? AND account = ?",
      )
      .all(walletId, assetMint, account) as SqlRow[];
    return rows.reduce(
      (total, row) => total + BigInt(String(row["delta_raw"])),
      0n,
    );
  }

  #sumOpenCostBasis(walletId: string): bigint {
    const rows = this.#db
      .prepare(
        "SELECT cost_basis_lamports FROM paper_positions WHERE wallet_id = ? AND token_amount_raw != '0'",
      )
      .all(walletId) as SqlRow[];
    return rows.reduce(
      (total, row) => total + BigInt(String(row["cost_basis_lamports"])),
      0n,
    );
  }

  #sumRealizedSince(walletId: string, utcDate: string): bigint {
    const rows = this.#db
      .prepare(
        "SELECT pnl_lamports FROM paper_realized_pnl WHERE wallet_id = ? AND substr(filled_at_utc, 1, 10) = ?",
      )
      .all(walletId, utcDate) as SqlRow[];
    return rows.reduce(
      (total, row) => total + BigInt(String(row["pnl_lamports"])),
      0n,
    );
  }

  #insertPaperLedgerPair(input: {
    journalId: string;
    walletId: string;
    assetMint: string;
    leftAccount: string;
    leftDelta: bigint;
    rightAccount: string;
    rightDelta: bigint;
    createdAtUtc: string;
  }): void {
    this.#insertPaperJournalEntries(
      input.journalId,
      input.walletId,
      [
        {
          account: input.leftAccount,
          asset: input.assetMint,
          delta: input.leftDelta,
        },
        {
          account: input.rightAccount,
          asset: input.assetMint,
          delta: input.rightDelta,
        },
      ],
      input.createdAtUtc,
    );
  }

  #insertPaperJournalEntries(
    journalId: string,
    walletId: string,
    sourceEntries: Array<{ account: string; asset: string; delta: bigint }>,
    createdAtUtc: string,
  ): void {
    const aggregated = new Map<
      string,
      { account: string; asset: string; delta: bigint }
    >();
    for (const entry of sourceEntries) {
      const key = `${entry.account}:${entry.asset}`;
      const current = aggregated.get(key);
      aggregated.set(key, {
        ...entry,
        delta: (current?.delta ?? 0n) + entry.delta,
      });
    }
    const byAsset = new Map<string, bigint>();
    for (const entry of aggregated.values())
      byAsset.set(entry.asset, (byAsset.get(entry.asset) ?? 0n) + entry.delta);
    if ([...byAsset.values()].some((sum) => sum !== 0n))
      throw new Error("PAPER_JOURNAL_NOT_BALANCED");
    let index = 0;
    for (const entry of aggregated.values()) {
      if (entry.delta === 0n) continue;
      this.#db
        .prepare(
          `INSERT INTO paper_ledger_entries
           (id, journal_id, wallet_id, account, asset_mint, delta_raw, created_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `${journalId}:${index++}`,
          journalId,
          walletId,
          entry.account,
          entry.asset,
          entry.delta.toString(),
          createdAtUtc,
        );
    }
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

function mapPaperOrder(row: SqlRow) {
  return {
    id: String(row["id"]),
    walletId: String(row["wallet_id"]),
    idempotencyKey: String(row["idempotency_key"]),
    mint: String(row["mint"]),
    side: String(row["side"]) as "BUY" | "SELL",
    inputAmountRaw: String(row["input_amount_raw"]),
    status: String(row["status"]) as
      "PENDING" | "SIMULATED_FILLED" | "REJECTED" | "UNFILLABLE" | "EXPIRED",
    reasonCode: row["reason_code"] === null ? null : String(row["reason_code"]),
    createdAtUtc: String(row["created_at_utc"]),
    entrySource: String(row["entry_source"] ?? "AUTOMATIC") as
      "AUTOMATIC" | "MANUAL",
  };
}

function mapManualPaperRequest(row: SqlRow): ManualPaperRequest {
  return {
    id: String(row["id"]),
    idempotencyKey: String(row["idempotency_key"]),
    requestType: String(row["request_type"]) as "ENTRY" | "EXIT",
    walletId: String(row["wallet_id"]),
    mint: String(row["mint"]),
    positionId: row["position_id"] === null ? null : String(row["position_id"]),
    requestedAmountRaw: String(row["requested_amount_raw"]),
    requestedSizeSol:
      row["requested_size_sol"] === null
        ? null
        : String(row["requested_size_sol"]),
    entrySource: "MANUAL",
    status: String(row["status"]) as ManualPaperRequest["status"],
    reasonCode: row["reason_code"] === null ? null : String(row["reason_code"]),
    originalCoverageStatus:
      row["original_coverage_status"] === null
        ? null
        : String(row["original_coverage_status"]),
    coverageExceptionReason:
      row["coverage_exception_reason"] === null
        ? null
        : String(row["coverage_exception_reason"]),
    evidence: JSON.parse(String(row["evidence_json"])) as Record<
      string,
      unknown
    >,
    executionOrderId:
      row["execution_order_id"] === null
        ? null
        : String(row["execution_order_id"]),
    attempts: Number(row["attempts"]),
    createdAtUtc: String(row["created_at_utc"]),
    expiresAtUtc:
      row["expires_at_utc"] === null || row["expires_at_utc"] === undefined
        ? null
        : String(row["expires_at_utc"]),
    updatedAtUtc: String(row["updated_at_utc"]),
    completedAtUtc:
      row["completed_at_utc"] === null ? null : String(row["completed_at_utc"]),
  };
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const index = Math.max(
    0,
    Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1),
  );
  return values[index] ?? null;
}

export function payloadReference(payload: string): string {
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}
