const LAMPORTS_PER_SOL = 1_000_000_000n;

type JsonRecord = Record<string, unknown> & {
  analysisReadiness?: unknown;
  analysisReady?: unknown;
  blockers?: unknown;
  buys?: unknown;
  closedTradeCount?: unknown;
  costBasisLamports?: unknown;
  createdTokens?: unknown;
  dateAsiaJakarta?: unknown;
  discoveries?: unknown;
  discoveryReady?: unknown;
  entryCostLamports?: unknown;
  entrySource?: unknown;
  exitReasonCodes?: unknown;
  filledAtUtc?: unknown;
  heliusRequestBudget?: unknown;
  inputAmountRaw?: unknown;
  latestFills?: unknown;
  migrations?: unknown;
  mint?: unknown;
  mode?: unknown;
  monitor?: unknown;
  networkFeeLamports?: unknown;
  observedAtUtc?: unknown;
  openPositions?: unknown;
  outputAmountRaw?: unknown;
  paperAutomaticEntryReady?: unknown;
  paperRuntimeReady?: unknown;
  positionId?: unknown;
  positions?: unknown;
  processHealth?: unknown;
  provider?: unknown;
  providers?: unknown;
  readiness?: unknown;
  realizedPnlLamports?: unknown;
  realizedPnlPercentBps?: unknown;
  reasonCode?: unknown;
  recoveredPaperOrders?: unknown;
  recoveryStatus?: unknown;
  remaining?: unknown;
  requestsRemaining?: unknown;
  requestsUsed?: unknown;
  retryStatus?: unknown;
  sells?: unknown;
  side?: unknown;
  solBalanceLamports?: unknown;
  state?: unknown;
  status?: unknown;
  summary?: unknown;
  thresholdPercent?: unknown;
  tokenAmountRaw?: unknown;
  tokenDecimals?: unknown;
  tokenName?: unknown;
  used?: unknown;
  unrealizedPnlLamports?: unknown;
  venue?: unknown;
  venueFeeRaw?: unknown;
  walletId?: unknown;
  winningSells?: unknown;
  winningTrades?: unknown;
};

export function formatSol(lamports: unknown): string {
  if (typeof lamports !== "string" || !/^-?\d+$/.test(lamports))
    return "unknown SOL";
  const raw = BigInt(lamports);
  const negative = raw < 0n;
  const absolute = negative ? -raw : raw;
  const whole = absolute / LAMPORTS_PER_SOL;
  const fraction = (absolute % LAMPORTS_PER_SOL)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""} SOL`;
}

export function formatTokenAmount(
  rawValue: unknown,
  decimalsValue: unknown,
): string {
  if (
    typeof rawValue !== "string" ||
    !/^\d+$/.test(rawValue) ||
    typeof decimalsValue !== "number" ||
    !Number.isInteger(decimalsValue) ||
    decimalsValue < 0 ||
    decimalsValue > 255
  )
    return typeof rawValue === "string"
      ? `${rawValue} raw units`
      : "unknown amount";
  const raw = BigInt(rawValue);
  if (decimalsValue === 0) return raw.toString();
  const base = 10n ** BigInt(decimalsValue);
  const whole = raw / base;
  const fraction = (raw % base)
    .toString()
    .padStart(decimalsValue, "0")
    .replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

export function formatTokenPrice(
  solLamports: unknown,
  tokenRaw: unknown,
  decimals: unknown,
): string {
  if (
    typeof solLamports !== "string" ||
    !/^\d+$/.test(solLamports) ||
    typeof tokenRaw !== "string" ||
    !/^\d+$/.test(tokenRaw) ||
    BigInt(tokenRaw) === 0n ||
    typeof decimals !== "number" ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  )
    return "unknown";
  const nanosPerWholeToken =
    (BigInt(solLamports) * 10n ** BigInt(decimals)) / BigInt(tokenRaw);
  if (nanosPerWholeToken === 0n) return "<0.000000001 SOL/token";
  const whole = nanosPerWholeToken / LAMPORTS_PER_SOL;
  const fraction = (nanosPerWholeToken % LAMPORTS_PER_SOL)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} SOL/token`;
}

export function safeText(value: unknown, fallback = "unknown"): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
}

export function formatCommandResponse(
  command: string,
  health: JsonRecord,
  paper: JsonRecord | null,
): string {
  const readiness = record(health.readiness);
  const mode = safeText(health.mode, "unknown");
  if (command === "status") {
    const blockers = stringList(readiness.blockers);
    return [
      `Solana Sentinel — ${mode}`,
      `Process: ${readiness.processHealth === false ? "degraded" : "running"}`,
      `Discovery: ${readiness.discoveryReady === true ? "ready" : "blocked"}`,
      `Analysis: ${readiness.analysisReadiness === true ? "ready" : "blocked"}`,
      `PAPER runtime: ${readiness.paperRuntimeReady === true ? "ready" : "inactive"}`,
      `Automatic entries: ${readiness.paperAutomaticEntryReady === true ? "ready" : "disabled or blocked"}`,
      blockers.length
        ? `Blockers: ${blockers.join(", ")}`
        : "Blockers: none reported",
    ].join("\n");
  }
  if (command === "health") {
    const providers = Array.isArray(health.providers) ? health.providers : [];
    const providerLines = providers.slice(0, 12).map((item) => {
      const provider = record(item);
      return `${safeText(provider.provider)}: ${safeText(provider.state)}`;
    });
    const budget = record(readiness.heliusRequestBudget);
    const blockers = stringList(readiness.blockers);
    return [
      "System health",
      ...providerLines,
      budget.used === undefined
        ? "Helius budget: unavailable"
        : `Helius budget: ${safeText(budget.used)} used, ${safeText(budget.remaining)} remaining`,
      `Blockers: ${blockers.length ? blockers.join(", ") : "none reported"}`,
    ].join("\n");
  }
  if (!paper)
    return "PAPER data is unavailable while the system is not in PAPER mode.";
  const positions = Array.isArray(paper.positions) ? paper.positions : [];
  if (command === "portfolio")
    return [
      "PAPER / VIRTUAL portfolio",
      `Wallet: ${safeText(paper.walletId)}`,
      `Virtual SOL: ${formatSol(paper.solBalanceLamports)}`,
      `Realized PnL: ${formatSol(paper.realizedPnlLamports)}`,
      `Unrealized PnL: ${paper.unrealizedPnlLamports === null ? "unavailable" : formatSol(paper.unrealizedPnlLamports)}`,
      `Open positions: ${positions.length}`,
    ].join("\n");
  if (command === "positions") {
    if (positions.length === 0) return "No open PAPER / VIRTUAL positions.";
    return [
      "Open PAPER / VIRTUAL positions",
      ...positions.slice(0, 20).map((item) => {
        const position = record(item);
        const monitor = record(position.monitor);
        return [
          `${safeText(position.positionId)} | ${safeText(position.mint)}`,
          `Tokens: ${formatTokenAmount(position.tokenAmountRaw, position.tokenDecimals)}`,
          `Cost basis: ${formatSol(position.costBasisLamports)}`,
          `Unrealized PnL: ${position.unrealizedPnlLamports === null ? "unavailable" : formatSol(position.unrealizedPnlLamports)}`,
          `Monitor: ${safeText(monitor.status, "unknown")}${monitor.reasonCode ? ` (${safeText(monitor.reasonCode)})` : ""}`,
        ].join("\n");
      }),
    ].join("\n\n");
  }
  if (command === "trades") {
    const fills = Array.isArray(paper.latestFills) ? paper.latestFills : [];
    if (fills.length === 0) return "No PAPER / VIRTUAL fills recorded.";
    return [
      "Recent PAPER / VIRTUAL fills",
      ...fills.slice(0, 12).map((item) => {
        const fill = record(item);
        const isBuy = fill.side === "BUY";
        return [
          `${safeText(fill.side)} ${safeText(fill.tokenName, safeText(fill.mint))}`,
          `Mint: ${safeText(fill.mint)}`,
          `Amount: ${formatTokenAmount(isBuy ? fill.outputAmountRaw : fill.inputAmountRaw, fill.tokenDecimals)}`,
          `Realized PnL: ${fill.realizedPnlLamports ? formatSol(fill.realizedPnlLamports) : "not realized"}`,
          `Fees: ${formatSol((decimalOrZero(fill.venueFeeRaw) + decimalOrZero(fill.networkFeeLamports)).toString())}`,
          `Source: ${safeText(fill.entrySource)} | ${safeText(fill.filledAtUtc)}`,
        ].join("\n");
      }),
    ].join("\n");
  }
  if (command === "pnl") {
    const closes = Number(paper.closedTradeCount ?? 0);
    const wins = Number(paper.winningTrades ?? 0);
    const winRate =
      closes > 0 ? `${((wins * 100) / closes).toFixed(1)}%` : "n/a";
    return [
      "PAPER / VIRTUAL PnL",
      `Realized: ${formatSol(paper.realizedPnlLamports)}`,
      `Unrealized: ${paper.unrealizedPnlLamports === null ? "unavailable" : formatSol(paper.unrealizedPnlLamports)}`,
      `Closed sells: ${closes}; wins: ${wins}; win rate: ${winRate}`,
    ].join("\n");
  }
  return "Command response unavailable.";
}

export function formatNotification(
  eventType: string,
  payload: JsonRecord,
): string {
  const mint = safeText(payload.mint);
  const token = safeText(payload.tokenName, mint);
  if (eventType === "PAPER_FILL") {
    const side = payload.side === "BUY" ? "BUY FILLED" : "SELL FILLED";
    const feeLamports =
      decimalOrZero(payload.venueFeeRaw) +
      decimalOrZero(payload.networkFeeLamports);
    const lines = [
      `PAPER / VIRTUAL — ${side}`,
      `Token: ${token}`,
      `Mint: ${mint}`,
      `Venue: ${safeText(payload.venue)}`,
      `Entry source: ${safeText(payload.entrySource)}`,
    ];
    if (payload.side === "BUY") {
      lines.push(`Virtual entry: ${formatSol(payload.inputAmountRaw)}`);
      lines.push(
        `Entry price: ${formatTokenPrice(payload.entryCostLamports ?? payload.inputAmountRaw, payload.outputAmountRaw, payload.tokenDecimals)}`,
      );
      lines.push(
        `Token amount: ${formatTokenAmount(payload.outputAmountRaw, payload.tokenDecimals)}`,
      );
    } else {
      lines.push(
        `Exit reason: ${stringList(payload.exitReasonCodes).join(", ") || "operator or strategy exit"}`,
      );
      lines.push(`Realized PnL: ${formatSol(payload.realizedPnlLamports)}`);
      if (typeof payload.realizedPnlPercentBps === "string")
        lines.push(
          `Realized PnL: ${formatBasisPoints(payload.realizedPnlPercentBps)}`,
        );
      lines.push(
        `Exit price: ${formatTokenPrice(payload.outputAmountRaw, payload.inputAmountRaw, payload.tokenDecimals)}`,
      );
    }
    lines.push(`Fees: ${formatSol(feeLamports.toString())}`);
    lines.push(`Filled at: ${safeText(payload.filledAtUtc)}`);
    return lines.join("\n");
  }
  if (eventType === "EXIT_FAILED")
    return `PAPER / VIRTUAL — Exit failed\nToken: ${mint}\nTrigger: ${stringList(payload.exitReasonCodes).join(", ") || "manual or strategy exit"}\nReason: ${safeText(payload.reasonCode)}\nOrder status: ${safeText(payload.status)}\nRetry: ${safeText(payload.retryStatus)}`;
  if (eventType === "POSITION_UNPRICEABLE")
    return `PAPER / VIRTUAL — Position requires attention\nMint: ${mint}\nState: ${safeText(payload.status)}\nCost basis exposure: ${formatSol(payload.costBasisLamports)}\nQuote/risk reason: ${safeText(payload.reasonCode)}\nExposure remains virtual and open until a valid exit fill is recorded.`;
  if (eventType === "PROVIDER_DISCONNECTED")
    return `Provider disconnected\nProvider: ${safeText(payload.provider)}\nReason: ${safeText(payload.reasonCode)}\nAt: ${safeText(payload.observedAtUtc)}`;
  if (eventType === "PROVIDER_RECOVERED")
    return `Provider recovered\nProvider: ${safeText(payload.provider)}\nStatus: ${safeText(payload.recoveryStatus)}\nAt: ${safeText(payload.observedAtUtc)}`;
  if (eventType === "HELIUS_BUDGET_WARNING")
    return `Helius RPC budget warning (${safeText(payload.thresholdPercent)}%)\nRequests used: ${safeText(payload.requestsUsed)}\nRemaining: ${safeText(payload.requestsRemaining)}`;
  if (eventType === "WORKER_RESTART")
    return `Solana Sentinel worker started\nMode: ${safeText(payload.mode)}\nRecovered PAPER orders: ${safeText(payload.recoveredPaperOrders)}\nOpen PAPER positions: ${safeText(payload.openPositions)}\nAt: ${safeText(payload.observedAtUtc)}`;
  if (eventType === "DAILY_SUMMARY") return formatDailySummary(payload);
  return `Solana Sentinel alert\nType: ${safeText(eventType)}`;
}

export function formatDailySummary(payload: JsonRecord): string {
  const summary = record(payload.summary);
  const sells = Number(summary.sells ?? 0);
  const wins = Number(summary.winningSells ?? 0);
  const winRate = sells > 0 ? `${((wins * 100) / sells).toFixed(1)}%` : "n/a";
  return [
    `Daily summary — ${safeText(payload.dateAsiaJakarta)}`,
    `Mode: ${safeText(payload.mode)}`,
    `Discoveries: ${formatCount(summary.discoveries)} (created ${formatCount(summary.createdTokens)}, migrated ${formatCount(summary.migrations)})`,
    `PAPER / VIRTUAL fills: ${safeText(summary.buys ?? 0)} BUY / ${sells} SELL`,
    `Win rate: ${winRate}`,
    `Realized PnL: ${formatSol(summary.realizedPnlLamports)}`,
    `Open positions: ${formatCount(summary.openPositions)}`,
  ].join("\n");
}

function formatCount(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : "unknown";
}

function decimalOrZero(value: unknown): bigint {
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : 0n;
}

function formatBasisPoints(value: string): string {
  if (!/^-?\d+$/.test(value)) return "unknown";
  const basisPoints = BigInt(value);
  const sign = basisPoints < 0n ? "-" : "+";
  const absolute = basisPoints < 0n ? -basisPoints : basisPoints;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}%`;
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .slice(0, 20)
    : [];
}
