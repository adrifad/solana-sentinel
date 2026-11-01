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
    mode: z.literal("DRY_RUN"),
    providers: z
      .object({
        helius: z
          .object({
            request_timeout_ms: z.number().int().min(100).max(30000),
            max_requests_per_second: z.number().int().min(1).max(1000),
          })
          .strict(),
        pumpportal: z
          .object({
            enable_new_tokens: z.boolean(),
            enable_migrations: z.boolean(),
            enable_token_trades: z.literal(false),
            max_monitored_tokens: positiveInt,
            max_trade_events_per_day: positiveInt,
          })
          .strict(),
        dexscreener: z
          .object({ enabled: z.boolean(), requests_per_second: positiveInt })
          .strict(),
        jupiter: z.object({ enabled: z.literal(false) }).strict(),
      })
      .strict(),
    analysis: z
      .object({
        concurrent_token_analysis: positiveInt,
        creator_history_cache_ttl_seconds: positiveInt,
        creator_history_max_transactions: positiveInt,
        creator_tracing_max_depth: z.number().int().min(0).max(8),
        max_analysis_ms: positiveInt,
        token_observation_seconds: positiveInt,
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
  .strict();

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type RuntimeEnvironment = {
  APP_MODE?: string;
  APP_CONFIG_PATH?: string;
  DB_PATH?: string;
  PUMPPORTAL_API_KEY?: string;
  HELIUS_API_KEY?: string;
  API_HOST?: string;
  API_PORT?: string;
};

export type LoadedConfig = {
  config: AppConfig;
  configVersion: string;
  configPath: string;
  dbPath: string;
  pumpPortalApiKey: string | undefined;
  heliusApiKey: string | undefined;
  apiHost: string;
  apiPort: number;
};

export async function loadConfig(
  env: RuntimeEnvironment = process.env,
): Promise<LoadedConfig> {
  const configPath = env.APP_CONFIG_PATH ?? "config/default.yaml";
  const parsedYaml: unknown = parse(await readFile(configPath, "utf8"));
  const config = AppConfigSchema.parse(parsedYaml);
  if (env.APP_MODE !== undefined && env.APP_MODE !== "DRY_RUN") {
    throw new Error(
      "APP_MODE supports DRY_RUN only; paper and live execution are not implemented",
    );
  }
  const port = env.API_PORT === undefined ? 8787 : Number(env.API_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("API_PORT must be an integer from 1 to 65535");
  const dbPath = env.DB_PATH ?? "./data/sentinel.db";
  return {
    config,
    configVersion: createHash("sha256")
      .update(JSON.stringify(config))
      .digest("hex"),
    configPath,
    dbPath,
    pumpPortalApiKey: env.PUMPPORTAL_API_KEY || undefined,
    heliusApiKey: env.HELIUS_API_KEY || undefined,
    apiHost: env.API_HOST ?? "127.0.0.1",
    apiPort: port,
  };
}
