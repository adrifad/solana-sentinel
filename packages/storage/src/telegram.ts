import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

type Row = Record<string, string | number | bigint | null>;

export type TelegramOutboxItem = {
  id: string;
  dedupeKey: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
};

/**
 * Narrow Telegram persistence adapter. It cannot access trading tables or
 * mutate orders, balances, positions, or configuration.
 */
export class TelegramOutboxRepository {
  #db!: DatabaseSync;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  open(): void {
    this.#db = new DatabaseSync(this.path);
    this.#db.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA query_only = OFF;",
    );
    const migration = this.#db
      .prepare("SELECT 1 FROM schema_migrations WHERE version = 14")
      .get();
    if (!migration) {
      this.#db.close();
      throw new Error("TELEGRAM_STORAGE_MIGRATION_REQUIRED");
    }
  }

  claimConsumer(
    botKey: string,
    ownerId: string,
    nowUtc: string,
    leaseUntilUtc: string,
  ): boolean {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#db
        .prepare(
          "SELECT owner_id, lease_until_utc FROM telegram_consumer_leases WHERE bot_key = ?",
        )
        .get(botKey) as Row | undefined;
      if (
        existing &&
        String(existing["owner_id"]) !== ownerId &&
        Date.parse(String(existing["lease_until_utc"])) > Date.parse(nowUtc)
      ) {
        this.#db.exec("ROLLBACK");
        return false;
      }
      this.#db
        .prepare(
          `INSERT INTO telegram_consumer_leases(bot_key, owner_id, lease_until_utc, updated_at_utc)
           VALUES (?, ?, ?, ?) ON CONFLICT(bot_key) DO UPDATE SET
           owner_id = excluded.owner_id, lease_until_utc = excluded.lease_until_utc,
           updated_at_utc = excluded.updated_at_utc`,
        )
        .run(botKey, ownerId, leaseUntilUtc, nowUtc);
      this.#db.exec("COMMIT");
      return true;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  releaseConsumer(botKey: string, ownerId: string): void {
    this.#db
      .prepare(
        "DELETE FROM telegram_consumer_leases WHERE bot_key = ? AND owner_id = ?",
      )
      .run(botKey, ownerId);
  }

  getState(key: string): string | null {
    const row = this.#db
      .prepare("SELECT state_value FROM telegram_bot_state WHERE state_key = ?")
      .get(key) as Row | undefined;
    return row ? String(row["state_value"]) : null;
  }

  setState(key: string, value: string, updatedAtUtc: string): void {
    this.#db
      .prepare(
        `INSERT INTO telegram_bot_state(state_key, state_value, updated_at_utc)
         VALUES (?, ?, ?) ON CONFLICT(state_key) DO UPDATE SET
         state_value = excluded.state_value, updated_at_utc = excluded.updated_at_utc`,
      )
      .run(key, value, updatedAtUtc);
  }

  enqueueDailySummary(
    localDate: string,
    payload: Record<string, unknown>,
    createdAtUtc: string,
  ): boolean {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const lastDate = this.getState("daily_summary_last_queued_date");
      if (lastDate && lastDate >= localDate) {
        this.#db.exec("COMMIT");
        return false;
      }
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO telegram_outbox
           (id, dedupe_key, event_type, payload_json, status, attempts, available_at_utc, created_at_utc)
           VALUES (?, ?, 'DAILY_SUMMARY', ?, 'PENDING', 0, ?, ?)`,
        )
        .run(
          randomUUID(),
          `daily-summary:${localDate}`,
          JSON.stringify(payload),
          createdAtUtc,
          createdAtUtc,
        );
      this.setState("daily_summary_last_queued_date", localDate, createdAtUtc);
      this.#db.exec("COMMIT");
      return true;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  claimNext(
    ownerId: string,
    nowUtc: string,
    leaseUntilUtc: string,
  ): TelegramOutboxItem | null {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db
        .prepare(
          `SELECT * FROM telegram_outbox WHERE
           (status = 'PENDING' AND available_at_utc <= ?) OR
           (status = 'PROCESSING' AND lease_until_utc <= ?)
           ORDER BY created_at_utc, id LIMIT 1`,
        )
        .get(nowUtc, nowUtc) as Row | undefined;
      if (!row) {
        this.#db.exec("COMMIT");
        return null;
      }
      this.#db
        .prepare(
          `UPDATE telegram_outbox SET status = 'PROCESSING', attempts = attempts + 1,
           claimed_by = ?, lease_until_utc = ? WHERE id = ?`,
        )
        .run(ownerId, leaseUntilUtc, String(row["id"]));
      this.#db.exec("COMMIT");
      return {
        id: String(row["id"]),
        dedupeKey: String(row["dedupe_key"]),
        eventType: String(row["event_type"]),
        payload: JSON.parse(String(row["payload_json"])) as Record<
          string,
          unknown
        >,
        attempts: Number(row["attempts"]) + 1,
      };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  markSent(id: string, ownerId: string, sentAtUtc: string): boolean {
    const result = this.#db
      .prepare(
        `UPDATE telegram_outbox SET status = 'SENT', sent_at_utc = ?,
         claimed_by = NULL, lease_until_utc = NULL, last_error_code = NULL
         WHERE id = ? AND status = 'PROCESSING' AND claimed_by = ?`,
      )
      .run(sentAtUtc, id, ownerId);
    return Number(result.changes) === 1;
  }

  scheduleRetry(input: {
    id: string;
    ownerId: string;
    availableAtUtc: string;
    errorCode: string;
    terminal: boolean;
  }): boolean {
    const result = this.#db
      .prepare(
        `UPDATE telegram_outbox SET status = ?, available_at_utc = ?,
         claimed_by = NULL, lease_until_utc = NULL, last_error_code = ?
         WHERE id = ? AND status = 'PROCESSING' AND claimed_by = ?`,
      )
      .run(
        input.terminal ? "FAILED" : "PENDING",
        input.availableAtUtc,
        input.errorCode,
        input.id,
        input.ownerId,
      );
    return Number(result.changes) === 1;
  }

  getQueueDepth(): number {
    const row = this.#db
      .prepare(
        "SELECT COUNT(*) AS count FROM telegram_outbox WHERE status IN ('PENDING', 'PROCESSING')",
      )
      .get() as Row;
    return Number(row["count"] ?? 0);
  }

  close(): void {
    this.#db.close();
  }
}
