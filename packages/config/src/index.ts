import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";

const positiveInt = z.number().int().positive();
const PercentWeights = z
  .object({
    creator_history: z.number().int().nonnegative(),
    token_security: z.number().int().nonnegative(),
    launch_behavior: z.number().int().nonnegative(),
    exit_liquidity: z.number().int().nonnegative(),
    social_confidence: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (weights) => Object.values(weights).reduce((a, b) => a + b, 0) === 100,
    "strategy weights must total 100",
  );

export const AppConfigSchema = z
  .object({
    version: z.literal(1),
    network: z.literal("mainnet-beta"),
    mode: z.enum(["DRY_RUN", "PAPER"]),
    providers: z
      .object({
        helius: z
          .object({
            request_timeout_ms: z.number().int().min(100).max(30000),
            max_requests_per_second: z.number().int().min(1).max(1000),
            max_requests_per_utc_day: positiveInt,
            exit_reserved_requests_per_utc_day: z.number().int().nonnegative(),
            max_concurrent_enrichments: z.number().int().min(1).max(32),
            enable_trade_stream: z.boolean(),
            max_active_trade_subscriptions: z.number().int().min(1).max(5000),
            max_trade_events_per_day: positiveInt,
            trade_verification_concurrency: z.number().int().min(1).max(16),
            max_pending_trade_verifications: z.number().int().min(1).max(10000),
          })
          .strict(),
        pumpportal: z
          .object({
            enable_new_tokens: z.boolean(),
            enable_migrations: z.boolean(),
            enable_token_trades: z.literal(false),
            max_monitored_tokens: positiveInt,
            max_trade_events_per_day: positiveInt,
            max_active_trade_subscriptions: z.number().int().min(1).max(5000),
            observation_window_seconds: z.union([
              z.literal(30),
              z.literal(60),
              z.literal(120),
            ]),
            monitoring_duration_seconds: positiveInt,
            event_processing_concurrency: z.number().int().min(1).max(32),
            max_pending_events: z.number().int().min(1).max(10000),
          })
          .strict(),
        dexscreener: z
          .object({ enabled: z.boolean(), requests_per_second: positiveInt })
          .strict(),
        jupiter: z
          .object({
            enabled: z.boolean(),
            request_timeout_ms: z.number().int().min(100).max(30000),
            max_requests_per_second: z.number().int().min(1).max(100),
            max_requests_per_utc_day: positiveInt,
            max_quote_age_ms: z.number().int().min(100).max(60000),
          })
          .strict(),
      })
      .strict(),
    analysis: z
      .object({
        concurrent_token_analysis: positiveInt,
        creator_history_cache_ttl_seconds: positiveInt,
        creator_history_max_transactions: positiveInt,
        creator_history_page_size: z.number().int().min(1).max(1000),
        creator_tracing_max_depth: z.number().int().min(0).max(8),
        suspicious_launch_count: z.number().int().min(2).max(100),
        suspicious_launch_window_seconds: positiveInt,
        max_analysis_ms: positiveInt,
        token_observation_seconds: positiveInt,
        min_independent_buyers: z.number().int().nonnegative(),
        min_holder_sample_coverage_bps: z.number().int().min(0).max(10000),
        social_enabled: z.boolean(),
      })
      .strict(),
    security: z
      .object({
        require_fresh_mint_state: z.boolean(),
        unknown_policy: z.literal("QUARANTINE"),
        test_token_policy: z.literal("QUARANTINE"),
        reject_untrusted_permanent_delegate: z.boolean(),
        reject_unsafe_mint_authority: z.boolean(),
        reject_unsafe_freeze_authority: z.boolean(),
        reject_unsupported_transfer_hooks: z.boolean(),
        require_sell_quote_for_buy: z.boolean(),
        max_snapshot_age_ms: z.number().int().nonnegative(),
        max_holder_accounts: z.number().int().min(1).max(20),
        max_snapshot_slot_skew: z.number().int().nonnegative().max(10000),
      })
      .strict(),
    strategy: z
      .object({
        entry_mode: z.enum(["FAST", "VALIDATED"]),
        min_opportunity_score: z.number().int().min(0).max(100),
        weights: PercentWeights,
        min_independent_buyers: z.number().int().nonnegative(),
        max_signal_age_ms: positiveInt,
        max_hold_seconds: positiveInt,
      })
      .strict(),
    risk: z
      .object({
        max_trade_sol: z.string().regex(/^\d+(\.\d+)?$/),
        max_exposure_sol: z.string().regex(/^\d+(\.\d+)?$/),
        max_open_positions: positiveInt,
        max_daily_loss_sol: z.string().regex(/^\d+(\.\d+)?$/),
        max_drawdown_bps: z.number().int().positive().max(9999),
        max_price_impact_bps: z.number().int().nonnegative(),
        max_slippage_bps: z.number().int().nonnegative(),
        emergency_pause: z.boolean(),
      })
      .strict()
      .refine(
        (risk) => Number(risk.max_exposure_sol) >= Number(risk.max_trade_sol),
        "max exposure must be at least max trade size",
      ),
    paper: z
      .object({
        initial_sol: z.string().regex(/^\d+(\.\d+)?$/),
        execution_latency_ms: z.number().int().nonnegative(),
        max_quote_age_ms: z.number().int().nonnegative(),
        conservative_extra_slippage_bps: z.number().int().nonnegative(),
        modeled_network_fee_lamports: z.string().regex(/^\d+$/),
        mark_to_sell_quote: z.boolean(),
        reject_when_sell_quote_missing: z.boolean(),
        wallet_id: z.string().min(1).max(80),
        automatic_entries_enabled: z.boolean(),
        manual_entry_request_expiry_ms: z.number().int().min(1000).max(600000),
        manual_exit_request_expiry_ms: z.number().int().min(1000).max(3600000),
        order_size_sol: z.string().regex(/^\d+(\.\d+)?$/),
        stop_loss_bps: z.number().int().min(1).max(10000),
        take_profit_bps: z.number().int().positive(),
        position_monitor_interval_ms: z.number().int().min(250).max(900000),
        exit_retry_base_ms: z.number().int().min(1000).max(300000),
        exit_retry_max_ms: z.number().int().min(1000).max(3600000),
      })
      .strict(),
    observability: z
      .object({
        timezone_display: z.string().min(1),
        raw_event_retention_days: positiveInt,
        decision_retention_days: positiveInt,
        health_stale_feed_seconds: positiveInt,
        audit_config_changes: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    if (
      config.providers.helius.exit_reserved_requests_per_utc_day >
      config.providers.helius.max_requests_per_utc_day
    )
      context.addIssue({
        code: "custom",
        path: ["providers", "helius", "exit_reserved_requests_per_utc_day"],
        message:
          "exit RPC reserve must not exceed the daily Helius request cap",
      });
    const orderSize = solAmountLamports(config.paper.order_size_sol);
    const maxTrade = solAmountLamports(config.risk.max_trade_sol);
    if (orderSize <= 0n || orderSize > maxTrade)
      context.addIssue({
        code: "custom",
        path: ["paper", "order_size_sol"],
        message:
          "paper order size must be positive and no greater than max_trade_sol",
      });
    if (solAmountLamports(config.paper.initial_sol) <= 0n)
      context.addIssue({
        code: "custom",
        path: ["paper", "initial_sol"],
        message: "paper initial balance must be positive",
      });
    if (config.paper.exit_retry_max_ms < config.paper.exit_retry_base_ms)
      context.addIssue({
        code: "custom",
        path: ["paper", "exit_retry_max_ms"],
        message: "exit retry maximum must be at least the base delay",
      });
  });

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type RuntimeEnvironment = {
  APP_MODE?: string;
  APP_CONFIG_PATH?: string;
  DB_PATH?: string;
  PUMPPORTAL_API_KEY?: string;
  HELIUS_API_KEY?: string;
  JUPITER_API_KEY?: string;
  API_HOST?: string;
  API_PORT?: string;
  PAPER_OPERATOR_TOKEN?: string;
  TELEGRAM_ENABLED?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_ALLOWED_USER_IDS?: string;
  API_INTERNAL_URL?: string;
};

export type TelegramRuntimeConfig = {
  enabled: boolean;
  botToken: string | undefined;
  chatId: string | undefined;
  allowedUserIds: string[];
  apiInternalUrl: string;
};

const TelegramEnvironmentSchema = z
  .object({
    enabled: z.enum(["true", "false"]),
    botToken: z.string().trim().max(256),
    chatId: z
      .string()
      .trim()
      .regex(/^(?:-?\d{1,20})?$/),
    allowedUserIds: z
      .string()
      .trim()
      .max(4096)
      .regex(/^(?:\s*-?\d{1,20}\s*(?:,\s*-?\d{1,20}\s*)*)?$/),
    apiInternalUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }),
  })
  .strict();

export type LoadedConfig = {
  config: AppConfig;
  configVersion: string;
  configPath: string;
  dbPath: string;
  pumpPortalApiKey: string | undefined;
  heliusApiKey: string | undefined;
  jupiterApiKey: string | undefined;
  apiHost: string;
  apiPort: number;
  paperOperatorToken: string | undefined;
};

function solAmountLamports(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return (
    BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0") || "0")
  );
}

export async function loadConfig(
  env: RuntimeEnvironment = process.env,
): Promise<LoadedConfig> {
  const configPath = env.APP_CONFIG_PATH ?? "config/default.yaml";
  const parsedYaml: unknown = parse(await readFile(configPath, "utf8"));
  const config = AppConfigSchema.parse(parsedYaml);
  if (
    env.APP_MODE !== undefined &&
    !["DRY_RUN", "PAPER"].includes(env.APP_MODE)
  ) {
    throw new Error(
      "APP_MODE supports DRY_RUN and PAPER only; LIVE is unsupported",
    );
  }
  const effectiveMode = env.APP_MODE ?? config.mode;
  const effectiveConfig = AppConfigSchema.parse({
    ...config,
    mode: effectiveMode,
  });
  const port = env.API_PORT === undefined ? 8787 : Number(env.API_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("API_PORT must be an integer from 1 to 65535");
  const paperOperatorToken = env.PAPER_OPERATOR_TOKEN?.trim() || undefined;
  if (paperOperatorToken && paperOperatorToken.length < 32)
    throw new Error("PAPER_OPERATOR_TOKEN must contain at least 32 characters");
  const dbPath = env.DB_PATH ?? "./data/sentinel.db";
  return {
    configVersion: createHash("sha256")
      .update(JSON.stringify(effectiveConfig))
      .digest("hex"),
    config: effectiveConfig,
    configPath,
    dbPath,
    pumpPortalApiKey: env.PUMPPORTAL_API_KEY || undefined,
    heliusApiKey: env.HELIUS_API_KEY || undefined,
    jupiterApiKey: env.JUPITER_API_KEY || undefined,
    apiHost: env.API_HOST ?? "127.0.0.1",
    apiPort: port,
    paperOperatorToken,
  };
}

function normalizeTelegramId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!/^-?\d{1,20}$/.test(normalized))
    throw new Error("Telegram chat and user IDs must be decimal integers");
  return normalized;
}

export function loadTelegramRuntimeConfig(
  env: RuntimeEnvironment = process.env,
): TelegramRuntimeConfig {
  const parsed = TelegramEnvironmentSchema.safeParse({
    enabled: env.TELEGRAM_ENABLED ?? "false",
    botToken: env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: env.TELEGRAM_CHAT_ID ?? "",
    allowedUserIds: env.TELEGRAM_ALLOWED_USER_IDS ?? "",
    apiInternalUrl: env.API_INTERNAL_URL ?? "http://api:8787",
  });
  if (!parsed.success) throw new Error("TELEGRAM_CONFIGURATION_INVALID");
  const enabled = parsed.data.enabled === "true";
  const botToken = parsed.data.botToken || undefined;
  const chatId = parsed.data.chatId || undefined;
  const allowedUserIds = parsed.data.allowedUserIds
    .split(",")
    .map((value) => normalizeTelegramId(value))
    .filter((value): value is string => value !== undefined);
  const apiUrl = new URL(parsed.data.apiInternalUrl);
  if (enabled) {
    if (!botToken || botToken.length < 20)
      throw new Error(
        "TELEGRAM_BOT_TOKEN is required when Telegram is enabled",
      );
    if (!chatId)
      throw new Error("TELEGRAM_CHAT_ID is required when Telegram is enabled");
    if (allowedUserIds.length === 0)
      throw new Error(
        "TELEGRAM_ALLOWED_USER_IDS must contain at least one ID when Telegram is enabled",
      );
  }
  return {
    enabled,
    botToken,
    chatId,
    allowedUserIds: [...new Set(allowedUserIds)],
    apiInternalUrl: apiUrl.toString().replace(/\/$/, ""),
  };
}

export function isTelegramConfigured(env: RuntimeEnvironment): boolean {
  try {
    return loadTelegramRuntimeConfig(env).enabled;
  } catch {
    return false;
  }
}
