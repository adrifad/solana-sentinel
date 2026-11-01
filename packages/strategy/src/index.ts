import type {
  CreatorReputation,
  RiskDecision,
  TokenRiskReport,
  QuoteResult,
  ExitValidationResult,
  LaunchBehaviorSnapshot,
} from "@sentinel/domain";
import {
  ExitValidationResultSchema,
  RiskDecisionSchema,
} from "@sentinel/domain";

export function validateExitQuotes(input: {
  buy: QuoteResult | null;
  sell: QuoteResult | null;
  maximumAgeMs: number;
  maximumPriceImpactBps: number;
  minimumExitAmountRaw: string;
}): ExitValidationResult {
  const reasonCodes = new Set<string>();
  const evidenceRefs = [
    ...(input.buy ? [input.buy.id] : []),
    ...(input.sell ? [input.sell.id] : []),
  ];
  if (!input.buy || !input.sell) {
    reasonCodes.add("EXIT_QUOTE_MISSING");
    return ExitValidationResultSchema.parse({
      status: "UNKNOWN",
      buyQuoteId: input.buy?.id ?? null,
      sellQuoteId: input.sell?.id ?? null,
      requiredSellAmountRaw: input.buy?.expectedOutputAmountRaw ?? null,
      expectedExitAmountRaw: input.sell?.expectedOutputAmountRaw ?? null,
      reasonCodes: [...reasonCodes],
      evidenceRefs,
    });
  }
  if (
    input.buy.direction !== "BUY" ||
    input.sell.direction !== "SELL" ||
    input.buy.mint !== input.sell.mint ||
    input.buy.expectedOutputAmountRaw === null ||
    input.sell.exactInputAmountRaw !== input.buy.expectedOutputAmountRaw
  ) {
    reasonCodes.add("EXIT_QUOTE_AMOUNT_MISMATCH");
    return exitResult(input.buy, input.sell, "FAIL", reasonCodes, evidenceRefs);
  }
  if (
    input.buy.validationStatus === "FAIL" ||
    input.sell.validationStatus === "FAIL"
  ) {
    reasonCodes.add("EXIT_QUOTE_FAILED");
    return exitResult(input.buy, input.sell, "FAIL", reasonCodes, evidenceRefs);
  }
  if (
    input.buy.validationStatus !== "PASS" ||
    input.sell.validationStatus !== "PASS" ||
    input.buy.snapshotSlot === null ||
    input.sell.snapshotSlot === null ||
    input.buy.priceImpactBps === null ||
    input.sell.priceImpactBps === null ||
    input.buy.freshnessMs === null ||
    input.sell.freshnessMs === null
  ) {
    reasonCodes.add("EXIT_QUOTE_EVIDENCE_INCOMPLETE");
    return exitResult(
      input.buy,
      input.sell,
      "UNKNOWN",
      reasonCodes,
      evidenceRefs,
    );
  }
  if (
    input.buy.freshnessMs > input.maximumAgeMs ||
    input.sell.freshnessMs > input.maximumAgeMs
  ) {
    reasonCodes.add("EXIT_QUOTE_STALE");
    return exitResult(input.buy, input.sell, "FAIL", reasonCodes, evidenceRefs);
  }
  if (
    input.buy.priceImpactBps > input.maximumPriceImpactBps ||
    input.sell.priceImpactBps > input.maximumPriceImpactBps
  ) {
    reasonCodes.add("EXIT_PRICE_IMPACT_TOO_HIGH");
    return exitResult(input.buy, input.sell, "FAIL", reasonCodes, evidenceRefs);
  }
  if (
    input.sell.expectedOutputAmountRaw === null ||
    BigInt(input.sell.expectedOutputAmountRaw) <
      BigInt(input.minimumExitAmountRaw)
  ) {
    reasonCodes.add("EXIT_LIQUIDITY_BELOW_MINIMUM");
    return exitResult(input.buy, input.sell, "FAIL", reasonCodes, evidenceRefs);
  }
  reasonCodes.add("BUY_AND_SELL_QUOTES_VALIDATED");
  return exitResult(input.buy, input.sell, "PASS", reasonCodes, evidenceRefs);
}

function exitResult(
  buy: QuoteResult,
  sell: QuoteResult,
  status: ExitValidationResult["status"],
  reasonCodes: Set<string>,
  evidenceRefs: string[],
): ExitValidationResult {
  return ExitValidationResultSchema.parse({
    status,
    buyQuoteId: buy.id,
    sellQuoteId: sell.id,
    requiredSellAmountRaw: buy.expectedOutputAmountRaw,
    expectedExitAmountRaw: sell.expectedOutputAmountRaw,
    reasonCodes: [...reasonCodes].sort(),
    evidenceRefs,
  });
}

export type DecisionInput = {
  mint: string;
  configVersion: string;
  security: TokenRiskReport;
  creator: CreatorReputation | null;
  marketPhase: string;
  exitValidation: ExitValidationResult;
  startedAtMs: number;
  nowMs?: number;
  supportingEvidenceRefs?: string[];
  analysisReasonCodes?: string[];
  minimumHolderSampleCoverageBps?: number;
  minimumIndependentBuyers?: number;
  launchBehavior?: LaunchBehaviorSnapshot | null;
};

export function evaluateRiskDecision(input: DecisionInput): RiskDecision {
  const exitValidation = ExitValidationResultSchema.parse(input.exitValidation);
  const now = input.nowMs ?? Date.now();
  const reasons = new Set<string>();
  for (const code of input.analysisReasonCodes ?? []) reasons.add(code);
  let status: RiskDecision["status"] = "WATCH";
  if (input.security.status === "UNSAFE") {
    status = "REJECT";
    reasons.add("TOKEN_SECURITY_UNSAFE");
  } else if (input.security.status !== "SUPPORTED") {
    status = "QUARANTINE";
    reasons.add(`TOKEN_SECURITY_${input.security.status}`);
  }
  if (
    input.security.reasonCodes.some((code) =>
      [
        "MINT_AUTHORITY_ACTIVE",
        "FREEZE_AUTHORITY_ACTIVE",
        "NON_TRANSFERABLE_PRESENT",
      ].includes(code),
    )
  ) {
    status = "REJECT";
    for (const code of input.security.reasonCodes) reasons.add(code);
  }
  if (input.security.reasonCodes.includes("TEST_TOKEN_METADATA_PATTERN")) {
    if (status !== "REJECT") status = "QUARANTINE";
    reasons.add("TEST_TOKEN_METADATA_PATTERN");
  }
  const sampledCoverage = input.security.holderSampleCoverageBps;
  const samplePolicyPasses =
    input.security.holderSampleValidated === true &&
    sampledCoverage !== null &&
    sampledCoverage !== undefined &&
    sampledCoverage >= (input.minimumHolderSampleCoverageBps ?? 10000);
  if (!input.security.holderSampleComplete && !samplePolicyPasses) {
    if (status === "WATCH") status = "QUARANTINE";
    reasons.add(
      input.security.holderSampleValidated === true && sampledCoverage !== null
        ? "HOLDER_SAMPLE_COVERAGE_BELOW_POLICY"
        : "HOLDER_SAMPLE_INCOMPLETE",
    );
  } else if (samplePolicyPasses) {
    reasons.add("VALIDATED_HOLDER_SAMPLE_COVERAGE_POLICY_PASSED");
  }
  if (!input.creator) {
    if (status !== "REJECT") status = "QUARANTINE";
    reasons.add("CREATOR_HISTORY_UNAVAILABLE");
  } else {
    if (!input.creator.historyComplete) {
      if (status !== "REJECT") status = "QUARANTINE";
      reasons.add("CREATOR_HISTORY_INCOMPLETE");
    }
    if (Date.parse(input.creator.freshUntilUtc) <= now) {
      if (status !== "REJECT") status = "QUARANTINE";
      reasons.add("CREATOR_CACHE_STALE");
    }
    for (const indicator of input.creator.suspiciousIndicators) {
      if (status !== "REJECT") status = "QUARANTINE";
      reasons.add(indicator);
    }
  }
  const creatorRoleUnavailable = [
    "LAUNCH_SIGNATURE_MISSING",
    "LAUNCH_TRANSACTION_UNAVAILABLE",
    "LAUNCH_TRANSACTION_CONTRADICTS_EVENT",
    "PUMP_CREATE_EVENT_UNVERIFIED",
    "PROVIDER_CREATOR_CLAIM_MISMATCH",
    "PROVIDER_INITIATOR_CLAIM_MISMATCH",
  ].some((code) => input.analysisReasonCodes?.includes(code));
  if (creatorRoleUnavailable) {
    if (status !== "REJECT") status = "QUARANTINE";
    reasons.add("CREATOR_ROLE_EVIDENCE_UNVERIFIED");
  }
  const behavior = input.launchBehavior ?? null;
  const behaviorPasses =
    behavior !== null &&
    behavior.mint === input.mint &&
    behavior.complete &&
    behavior.classification === "ORGANIC_CANDIDATE" &&
    behavior.independentBuyerEstimate >= (input.minimumIndependentBuyers ?? 0);
  if (!behaviorPasses) {
    if (status !== "REJECT") status = "QUARANTINE";
    reasons.add(
      behavior?.complete
        ? behavior.classification === "LIKELY_TEST"
          ? "LAUNCH_BEHAVIOR_LIKELY_TEST"
          : "LAUNCH_BEHAVIOR_BUYER_THRESHOLD_NOT_MET"
        : "LAUNCH_BEHAVIOR_INCOMPLETE",
    );
  } else {
    for (const code of behavior.reasonCodes) reasons.add(code);
  }
  if (input.marketPhase === "MIGRATED_UNKNOWN_VENUE") {
    if (status !== "REJECT") status = "QUARANTINE";
    reasons.add("MIGRATED_VENUE_UNSUPPORTED");
  }
  for (const code of exitValidation.reasonCodes) reasons.add(code);
  if (exitValidation.status === "FAIL") {
    if (status !== "REJECT") status = "QUARANTINE";
    reasons.add("EXIT_VALIDATION_FAILED");
  } else if (exitValidation.status === "UNKNOWN") {
    if (status === "WATCH") status = "WATCH";
    reasons.add("EXIT_VALIDATION_UNKNOWN");
  }
  if (
    status === "WATCH" &&
    input.security.status === "SUPPORTED" &&
    input.creator?.historyComplete === true &&
    input.creator.suspiciousIndicators.length === 0 &&
    behaviorPasses &&
    input.marketPhase === "PUMP_CURVE" &&
    exitValidation.status === "PASS"
  ) {
    status = "BUY_ELIGIBLE";
    reasons.add("MANDATORY_CHECKS_PASSED");
  }
  const decidedAtUtc = new Date(now).toISOString();
  const evidenceRefs = [
    input.security.id,
    ...(input.creator?.evidenceRefs ?? []),
    ...exitValidation.evidenceRefs,
    ...(input.supportingEvidenceRefs ?? []),
  ];
  const candidate = {
    id: `${input.mint}:${decidedAtUtc}:${input.configVersion.slice(0, 12)}`,
    mint: input.mint,
    status,
    reasonCodes: [...reasons].sort(),
    configVersion: input.configVersion,
    evidenceRefs: [...new Set(evidenceRefs)],
    securityReportId: input.security.id,
    decidedAtUtc,
    latencyMs: Math.max(0, now - input.startedAtMs),
  };
  return RiskDecisionSchema.parse(candidate);
}
