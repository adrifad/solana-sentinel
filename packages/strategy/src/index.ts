import type {
  CreatorReputation,
  RiskDecision,
  TokenRiskReport,
} from "@sentinel/domain";
import { RiskDecisionSchema } from "@sentinel/domain";

export type DecisionInput = {
  mint: string;
  configVersion: string;
  security: TokenRiskReport;
  creator: CreatorReputation | null;
  marketPhase: string;
  exitValidation: "PASS" | "FAIL" | "UNKNOWN";
  startedAtMs: number;
  nowMs?: number;
  supportingEvidenceRefs?: string[];
  analysisReasonCodes?: string[];
};

export function evaluateRiskDecision(input: DecisionInput): RiskDecision {
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
  if (!input.security.holderSampleComplete) {
    if (status === "WATCH") status = "QUARANTINE";
    reasons.add("HOLDER_SAMPLE_INCOMPLETE");
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
  if (input.marketPhase === "MIGRATED_UNKNOWN_VENUE") {
    if (status !== "REJECT") status = "QUARANTINE";
    reasons.add("MIGRATED_VENUE_UNSUPPORTED");
  }
  if (input.exitValidation === "FAIL") {
    if (status !== "REJECT") status = "QUARANTINE";
    reasons.add("EXIT_VALIDATION_FAILED");
  } else if (input.exitValidation === "UNKNOWN") {
    if (status === "WATCH") status = "WATCH";
    reasons.add("EXIT_VALIDATION_UNKNOWN");
  }
  if (
    status === "WATCH" &&
    input.security.status === "SUPPORTED" &&
    input.creator?.historyComplete === true &&
    input.creator.suspiciousIndicators.length === 0 &&
    input.marketPhase === "PUMP_CURVE" &&
    input.exitValidation === "PASS"
  ) {
    status = "BUY_ELIGIBLE";
    reasons.add("MANDATORY_CHECKS_PASSED");
  }
  const decidedAtUtc = new Date(now).toISOString();
  const evidenceRefs = [
    input.security.id,
    ...(input.creator?.evidenceRefs ?? []),
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
