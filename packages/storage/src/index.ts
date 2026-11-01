import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { MarketEventSchema, utcNow } from "@sentinel/domain";
import type { MarketEvent, ProviderHealth } from "@sentinel/domain";

type SqlRow = Record<
  string,
  null | number | bigint | string | NodeJS.NonSharedUint8Array
>;

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
          "SELECT 1 FROM market_events WHERE provider = ? AND idempotency_key = ?",
        )
        .get(event.provider, event.idempotencyKey);
      if (existing) {
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

  recordObservedTimestamp(eventId: string, observedAtUtc: string): void {
    this.#db
      .prepare(
        `UPDATE market_events SET observed_at_utc = ?, observed_time_source = 'helius:getBlockTime' WHERE id = ?`,
      )
      .run(observedAtUtc, eventId);
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
    attempts: number;
  } | null {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const now = utcNow();
      const row = this.#db
        .prepare(
          `SELECT j.event_id, j.mint, j.attempts, e.kind, e.slot
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
