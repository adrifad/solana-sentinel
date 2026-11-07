export type JsonRecord = Record<string, unknown>;

export type HealthPayload = {
  mode?: string;
  checkedAtUtc?: string;
  readiness?: JsonRecord;
  providers?: Array<JsonRecord>;
  completeness?: JsonRecord;
};

export type EntryEvaluation = {
  status: string;
  reasonCode: string | null;
  evaluatedAtUtc: string | null;
  evaluationCount: number;
  orderAttemptCount: number;
  executionOrderId: string | null;
  orderStatus: string | null;
  activity?: string;
  ageMs?: number | null;
};

export type Candidate = {
  token: {
    mint: string;
    name: string | null;
    symbol: string | null;
    firstSeenAtUtc: string;
    monitoringEligible: boolean;
    marketPhase: string;
    creator: string | null;
  };
  analysis: JsonRecord | null;
  decision: {
    id: string;
    status: string;
    reasonCodes: string[];
    decidedAtUtc: string;
    configVersion: string;
  } | null;
  security: {
    status: string;
    reasonCodes: string[];
    observedAtUtc: string;
    testTokenClassification: string;
  } | null;
  tradeCoverage: {
    status: string;
    reasonCode: string | null;
    updatedAtUtc: string;
  } | null;
  tradeReconciliation: {
    status: string;
    pagesScanned: number;
    creditsCharged: number;
    pendingTransactions: number;
    unsupportedTransactions: number;
    reasonCode: string | null;
    updatedAtUtc: string;
  } | null;
  launchBehavior: {
    complete: boolean;
    classification: string;
    reasonCodes: string[];
    independentBuyerEstimate: number | null;
    observedAtUtc: string;
  } | null;
  entryEvaluation: EntryEvaluation;
};

export type CandidatePayload = {
  mode: string;
  automaticEntriesEnabled: boolean;
  schedulerState: string;
  schedulerBlockers: string[];
  totalDiscovered: number;
  sampleLimit: number;
  returnedCount: number;
  monitoringEligibleInSample: number;
  decisionCounts: Record<string, number>;
  entryEvaluationCounts: Record<string, number>;
  entryReasonCounts: Record<string, number>;
  currentlyEvaluatingInSample: number;
  evaluationCountInSample: number;
  orderAttemptCountInSample: number;
  candidates: Candidate[];
  checkedAtUtc: string;
};

export type PaperPayload = {
  mode: string;
  walletId: string;
  solBalanceLamports: string;
  realizedPnlLamports: string;
  unrealizedPnlLamports: string | null;
  positions: Array<{
    mint: string;
    tokenAmountRaw: string;
    costBasisLamports: string;
    unrealizedPnlLamports: string | null;
    monitor?: { status?: string; reasonCode?: string | null } | null;
  }>;
  latestFills: Array<{
    mint: string;
    side: string;
    inputAmountRaw: string;
    outputAmountRaw: string;
    filledAtUtc: string;
  }>;
  readinessBlockers: string[];
  paperAutomaticEntryReady: boolean;
};

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`API_${status}`);
    this.status = status;
  }
}

export async function readApi<T>(
  path: string,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: "GET",
    cache: "no-store",
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new ApiError(response.status);
  return (await response.json()) as T;
}
