import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  Blocks,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Command,
  ExternalLink,
  Eye,
  Gauge,
  LayoutDashboard,
  Menu,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  WalletCards,
  X,
  Zap,
} from "lucide-react";
import { ApiError, readApi } from "./lib/api.ts";
import type {
  Candidate,
  CandidatePayload,
  HealthPayload,
  PaperPayload,
} from "./lib/api.ts";
import { formatAge, formatReason, formatSol, shortMint } from "./lib/format.ts";

type LoadState = "loading" | "connected" | "degraded" | "offline";
type SectionId = "overview" | "candidates" | "portfolio" | "health";

const navigation: Array<{
  id: SectionId;
  label: string;
  icon: typeof LayoutDashboard;
}> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "candidates", label: "Token candidates", icon: Blocks },
  { id: "portfolio", label: "PAPER portfolio", icon: WalletCards },
  { id: "health", label: "System health", icon: Activity },
];

export default function App() {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [candidateData, setCandidateData] = useState<CandidatePayload | null>(
    null,
  );
  const [paper, setPaper] = useState<PaperPayload | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [activeSection, setActiveSection] = useState<SectionId>("overview");
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [apiFailure, setApiFailure] = useState<string | null>(null);
  const refreshInFlight = useRef(false);

  const refreshDashboard = useCallback(async (): Promise<void> => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    const controller = new AbortController();
    try {
      const results = await Promise.allSettled([
        readApi<HealthPayload>("/api/health", controller.signal),
        readApi<CandidatePayload>(
          "/api/paper/candidates?limit=50",
          controller.signal,
        ),
      ]);
      const healthResult = results[0];
      const candidatesResult = results[1];
      if (healthResult?.status === "fulfilled") setHealth(healthResult.value);
      if (candidatesResult?.status === "fulfilled")
        setCandidateData(candidatesResult.value);

      if (
        healthResult?.status === "rejected" &&
        candidatesResult?.status === "rejected"
      ) {
        setLoadState("offline");
        setApiFailure(errorLabel(healthResult.reason));
      } else if (
        healthResult?.status === "fulfilled" &&
        candidatesResult?.status === "fulfilled"
      ) {
        setLoadState("connected");
        setApiFailure(null);
        if (healthResult.value.mode === "PAPER") {
          const paperResult = await readApi<PaperPayload>(
            "/api/paper/status",
            controller.signal,
          ).catch((error: unknown) => {
            setApiFailure(errorLabel(error));
            return null;
          });
          setPaper(paperResult);
        } else {
          setPaper(null);
        }
      } else {
        setLoadState("degraded");
        const failed = results.find((result) => result.status === "rejected");
        setApiFailure(
          failed?.status === "rejected"
            ? errorLabel(failed.reason)
            : "API response incomplete",
        );
      }
      setLastUpdated(new Date().toISOString());
    } catch (error) {
      setLoadState("offline");
      setApiFailure(errorLabel(error));
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refreshDashboard();
    const timer = setInterval(() => void refreshDashboard(), 15_000);
    return () => clearInterval(timer);
  }, [refreshDashboard]);

  const candidates = candidateData?.candidates ?? [];
  const filteredCandidates = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return candidates;
    return candidates.filter((candidate) =>
      [candidate.token.name, candidate.token.symbol, candidate.token.mint].some(
        (value) => value?.toLowerCase().includes(query),
      ),
    );
  }, [candidates, search]);

  const decisions = candidateData?.decisionCounts ?? {};
  const buyEligible = decisions["BUY_ELIGIBLE"] ?? 0;
  const paperMode = health?.mode === "PAPER";
  const readiness = health?.readiness ?? {};
  const providerStates = health?.providers ?? [];
  const activeBlockers = Array.isArray(readiness["blockers"])
    ? (readiness["blockers"] as string[])
    : [];

  const navigate = (section: SectionId): void => {
    setActiveSection(section);
    setMobileNavigationOpen(false);
    document
      .getElementById(section)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="min-h-screen bg-canvas text-slate-100">
      <div className="flex min-h-screen">
        <aside className="hidden w-[248px] shrink-0 border-r border-line/80 bg-[#0b0d16] lg:flex lg:flex-col">
          <Brand />
          <div className="px-4 pb-5">
            <div className="flex items-center gap-2 px-1 text-[10px] text-muted">
              <span className="rounded-md border border-[#574684]/70 bg-[#29223f]/55 px-2 py-1 font-semibold text-[#c7baff]">
                Mainnet
              </span>
              <span className="text-[#6f7589]">Read-only console</span>
            </div>
          </div>
          <nav className="px-3" aria-label="Main navigation">
            <p className="px-3 pb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[#626a80]">
              Workspace
            </p>
            <div className="space-y-1">
              {navigation.map((item) => (
                <button
                  key={item.id}
                  className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[12px] font-semibold transition-colors ${activeSection === item.id ? "bg-[#1e1a31] text-[#d4caff] shadow-[inset_2px_0_0_#9278ff]" : "text-[#8d93a7] hover:bg-white/[0.04] hover:text-white"}`}
                  onClick={() => navigate(item.id)}
                >
                  <item.icon
                    size={16}
                    strokeWidth={1.8}
                    className={
                      activeSection === item.id
                        ? "text-violet"
                        : "text-[#697087] group-hover:text-[#b5a5ff]"
                    }
                  />
                  {item.label}
                  {item.id === "candidates" && candidateData && (
                    <span className="ml-auto rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-[#adb2c2]">
                      {candidateData.totalDiscovered}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </nav>
          <div className="mt-auto px-4 pb-5">
            <div className="rounded-2xl border border-[#3b315e] bg-[linear-gradient(145deg,rgba(139,114,248,.14),rgba(139,114,248,.035)_65%)] p-4">
              <div className="mb-3 flex size-8 items-center justify-center rounded-xl bg-violet/20 text-[#c8bbff]">
                <ShieldCheck size={16} />
              </div>
              <p className="text-xs font-semibold text-slate-100">
                Virtual by design
              </p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-[#9da2b5]">
                This console reads Sentinel data. It cannot sign or send a
                transaction.
              </p>
              <div className="mt-3 flex items-center gap-1.5 text-[10px] font-semibold text-mint">
                <Check size={12} /> No wallet keys loaded
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2 px-1 text-[10px] text-[#70768b]">
              <span className="size-1.5 rounded-full bg-[#48d6a2]" /> Sentinel
              API
              <span className="ml-auto font-mono">v0.1</span>
            </div>
          </div>
        </aside>

        {mobileNavigationOpen && (
          <div
            className="fixed inset-0 z-50 bg-black/70 lg:hidden"
            onClick={() => setMobileNavigationOpen(false)}
          >
            <aside
              className="h-full w-[280px] border-r border-line bg-[#0b0d16]"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between pr-3">
                <Brand />
                <button
                  className="rounded-lg p-2 text-muted hover:bg-white/5"
                  aria-label="Close navigation"
                  onClick={() => setMobileNavigationOpen(false)}
                >
                  <X size={18} />
                </button>
              </div>
              <nav className="px-3" aria-label="Mobile navigation">
                {navigation.map((item) => (
                  <button
                    key={item.id}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-slate-300 hover:bg-white/5"
                    onClick={() => navigate(item.id)}
                  >
                    <item.icon size={17} />
                    {item.label}
                  </button>
                ))}
              </nav>
            </aside>
          </div>
        )}

        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-30 flex h-[68px] items-center justify-between border-b border-line/80 bg-[#080a12]/90 px-4 backdrop-blur-xl sm:px-7">
            <div className="flex items-center gap-3">
              <button
                className="rounded-lg p-2 text-muted hover:bg-white/5 lg:hidden"
                aria-label="Open navigation"
                onClick={() => setMobileNavigationOpen(true)}
              >
                <Menu size={18} />
              </button>
              <div className="hidden items-center gap-2 text-xs text-[#7d849a] sm:flex">
                <span>Sentinel</span>
                <span className="text-[#444a5d]">/</span>
                <span className="text-slate-200">Operations</span>
              </div>
              <div className="flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.035] px-2.5 py-1.5 text-[10px] font-semibold text-slate-300 lg:hidden">
                <span
                  className={`size-1.5 rounded-full ${loadState === "connected" ? "bg-mint" : loadState === "loading" ? "bg-amber-300" : "bg-rose"}`}
                />
                {paperMode ? "PAPER" : (health?.mode ?? "CONNECTING")}
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              <label className="hidden h-9 w-60 items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 text-muted focus-within:border-[#6e5dc0] md:flex">
                <Search size={14} />
                <input
                  className="min-w-0 flex-1 bg-transparent text-xs text-slate-100 outline-none placeholder:text-[#687087]"
                  placeholder="Search tokens"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <kbd className="rounded border border-white/[0.08] px-1.5 py-0.5 font-mono text-[9px] text-[#6c7286]">
                  /
                </kbd>
              </label>
              <div
                className={`hidden shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border px-3 py-2 text-[10px] font-bold tracking-wide lg:flex ${paperMode ? "border-[#574684] bg-[#29223f]/70 text-[#d0c4ff]" : "border-white/[0.08] bg-white/[0.025] text-slate-300"}`}
              >
                <span
                  className={`size-1.5 rounded-full ${paperMode ? "bg-violet" : "bg-[#9299ad]"}`}
                />
                {paperMode
                  ? "PAPER / VIRTUAL"
                  : (health?.mode ?? "WAITING FOR API")}
              </div>
              <button
                onClick={() => void refreshDashboard()}
                disabled={refreshing}
                className="flex h-9 items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 text-[11px] font-semibold text-[#a8aec0] transition hover:border-[#6654b5] hover:text-white disabled:opacity-60"
                aria-label="Refresh dashboard data"
              >
                <RefreshCw
                  size={14}
                  className={refreshing ? "animate-spin" : ""}
                />
                <span className="hidden sm:inline">Refresh</span>
              </button>
            </div>
          </header>

          <main className="mx-auto max-w-[1600px] px-4 pb-10 pt-7 sm:px-7 lg:px-9">
            <section id="overview" className="scroll-mt-24">
              <div className="mb-7 flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
                <div>
                  <div className="mb-3 flex items-center gap-2 text-[11px] font-medium text-[#9399ad]">
                    <span className="inline-flex size-5 items-center justify-center rounded-md border border-[#514777] bg-[#211d31] text-[#b9a8ff]">
                      <Command size={11} />
                    </span>
                    Solana launch intelligence
                  </div>
                  <h1 className="text-[27px] font-semibold tracking-[-0.045em] text-[#f3f3f9] sm:text-[32px]">
                    Operations overview
                  </h1>
                  <p className="mt-1.5 max-w-2xl text-[12px] leading-relaxed text-[#858ba0]">
                    See what the system found, which safety gates passed, and
                    whether a virtual order was attempted.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[10px] text-[#82889d]">
                  <HealthPill state={loadState} />
                  <span className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2">
                    Updated {lastUpdated ? formatAge(lastUpdated) : "—"}
                  </span>
                </div>
              </div>

              {apiFailure && (
                <div className="mb-5 flex flex-col gap-2 rounded-2xl border border-[#49313d] bg-[#241721]/75 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-3">
                    <CircleAlert
                      size={17}
                      className="mt-0.5 shrink-0 text-rose"
                    />
                    <div>
                      <p className="text-xs font-semibold text-[#ffd0d7]">
                        Dashboard data is unavailable
                      </p>
                      <p className="mt-1 text-[11px] text-[#b58b94]">
                        {apiFailure}. Check that the Sentinel API is running and
                        the candidate diagnostics route is deployed.
                      </p>
                    </div>
                  </div>
                  <code className="rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-1.5 text-[10px] text-[#d5bbc0]">
                    GET /api/paper/candidates
                  </code>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard
                  icon={Blocks}
                  label="Tokens discovered"
                  value={
                    candidateData ? number(candidateData.totalDiscovered) : "—"
                  }
                  detail={
                    candidateData
                      ? `${number(candidateData.monitoringEligibleInSample)} active monitoring leases in sample`
                      : "Waiting for candidate data"
                  }
                  tint="violet"
                />
                <MetricCard
                  icon={ShieldCheck}
                  label="BUY eligible"
                  value={candidateData ? number(buyEligible) : "—"}
                  detail={
                    candidateData
                      ? `${number(candidateData.decisionCounts["WATCH"] ?? 0)} watch · ${number(candidateData.decisionCounts["QUARANTINE"] ?? 0)} quarantined`
                      : "Latest persisted decisions"
                  }
                  tint="mint"
                />
                <MetricCard
                  icon={Zap}
                  label="PAPER order attempts"
                  value={
                    candidateData
                      ? number(candidateData.orderAttemptCountInSample)
                      : "—"
                  }
                  detail={
                    candidateData
                      ? `${number(candidateData.entryEvaluationCounts["FILLED"] ?? 0)} simulated fills in current sample`
                      : "No order data loaded"
                  }
                  tint="amber"
                />
                <MetricCard
                  icon={WalletCards}
                  label="Virtual SOL balance"
                  value={paper ? formatSol(paper.solBalanceLamports) : "—"}
                  detail={
                    paper
                      ? `${paper.positions.length} open ${paper.positions.length === 1 ? "position" : "positions"} · no real wallet`
                      : paperMode
                        ? "PAPER portfolio is not available"
                        : "Visible when mode is PAPER"
                  }
                  tint="violet"
                />
              </div>
            </section>

            <section className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(330px,.85fr)]">
              <Panel id="pipeline" className="overflow-hidden">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line/80 px-5 py-4 sm:px-6">
                  <SectionTitle
                    icon={Gauge}
                    title="Entry pipeline"
                    subtitle="Latest candidate counts · current sample"
                  />
                  <span
                    className={`rounded-lg px-2.5 py-1.5 text-[10px] font-bold ${candidateData?.automaticEntriesEnabled ? "bg-[#202c2c] text-mint" : "bg-[#302528] text-[#f3b6bf]"}`}
                  >
                    {candidateData?.automaticEntriesEnabled
                      ? "AUTO ENTRY ENABLED"
                      : "AUTO ENTRY DISABLED"}
                  </span>
                </div>
                <div className="grid gap-0 divide-y divide-line/70 px-5 sm:grid-cols-5 sm:divide-x sm:divide-y-0 sm:px-2">
                  <FunnelStage
                    label="Detected"
                    count={candidateData?.totalDiscovered ?? null}
                    max={candidateData?.totalDiscovered ?? 0}
                    index="01"
                  />
                  <FunnelStage
                    label="Monitoring"
                    count={candidateData?.monitoringEligibleInSample ?? null}
                    max={candidateData?.totalDiscovered ?? 0}
                    index="02"
                  />
                  <FunnelStage
                    label="Analyzed"
                    count={analyzedCount(candidates)}
                    max={candidateData?.totalDiscovered ?? 0}
                    index="03"
                  />
                  <FunnelStage
                    label="BUY eligible"
                    count={buyEligible}
                    max={candidateData?.totalDiscovered ?? 0}
                    index="04"
                  />
                  <FunnelStage
                    label="Order attempts"
                    count={candidateData?.orderAttemptCountInSample ?? null}
                    max={candidateData?.totalDiscovered ?? 0}
                    index="05"
                  />
                </div>
                <div className="mx-5 mb-5 mt-2 rounded-xl border border-white/[0.06] bg-black/15 px-4 py-3 sm:mx-6">
                  <div className="flex items-start gap-3">
                    <div
                      className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg ${candidateData?.automaticEntriesEnabled ? "bg-[#152a27] text-mint" : "bg-[#2c2228] text-rose"}`}
                    >
                      <ShieldAlert size={15} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-semibold text-[#e6e7ef]">
                        {candidateData?.automaticEntriesEnabled
                          ? "Safety gates are still required"
                          : "The scheduler is not placing automatic entries"}
                      </p>
                      <p className="mt-1 text-[10px] leading-relaxed text-[#8c92a6]">
                        {candidateData?.automaticEntriesEnabled
                          ? candidateData.schedulerBlockers.length
                            ? candidateData.schedulerBlockers
                                .map(formatReason)
                                .join(", ")
                            : "Only current BUY_ELIGIBLE decisions with complete trade coverage, supported security, fresh quotes, and portfolio limits can reach the PAPER engine."
                          : "PAPER mode only enables virtual accounting. Automatic entry is off in configuration; the dashboard will still show candidates and their decisions."}
                      </p>
                    </div>
                    <div className="hidden shrink-0 text-right sm:block">
                      <p className="font-mono text-sm text-slate-200">
                        {number(
                          candidateData?.currentlyEvaluatingInSample ?? 0,
                        )}
                      </p>
                      <p className="mt-1 text-[9px] text-[#777e92]">
                        in progress
                      </p>
                    </div>
                  </div>
                </div>
              </Panel>

              <Panel id="health" className="flex flex-col">
                <div className="flex items-start justify-between border-b border-line/80 px-5 py-4 sm:px-6">
                  <SectionTitle
                    icon={Activity}
                    title="System readiness"
                    subtitle="Connectivity is not trade readiness"
                  />
                  <span
                    className={`mt-1 inline-flex size-2 rounded-full ${loadState === "connected" ? "bg-mint shadow-[0_0_10px_#48d6a2aa]" : loadState === "loading" ? "bg-amber-300" : "bg-rose"}`}
                  />
                </div>
                <div className="space-y-3 px-5 py-4 sm:px-6">
                  <ReadinessRow
                    label="Process health"
                    value={truthy(readiness["processHealth"])}
                  />
                  <ReadinessRow
                    label="Discovery feed"
                    value={truthy(readiness["discoveryReady"])}
                  />
                  <ReadinessRow
                    label="Analysis pipeline"
                    value={readinessStatus(
                      readiness["analysisStatus"],
                      readiness["analysisReadiness"],
                    )}
                  />
                  <ReadinessRow
                    label="Trade observations"
                    value={readinessStatus(
                      readiness["tradeObservationStatus"],
                      readiness["tradeObservationReady"],
                    )}
                  />
                  <ReadinessRow
                    label="PAPER runtime"
                    value={truthy(readiness["paperRuntimeReady"])}
                  />
                  <ReadinessRow
                    label="Automatic entry"
                    value={readinessStatus(
                      readiness["automaticEntryStatus"],
                      candidateData?.automaticEntriesEnabled
                        ? readiness["paperAutomaticEntryReady"]
                        : false,
                    )}
                  />
                  <ReadinessRow
                    label="Experimental PAPER"
                    value={readinessStatus(
                      readiness["paperExperimentalEntryStatus"],
                      readiness["paperExperimentalEntryReady"],
                    )}
                  />
                </div>
                <div className="mt-auto border-t border-line/80 px-5 py-3.5 sm:px-6">
                  <p className="mb-2 text-[9px] font-bold uppercase tracking-[0.15em] text-[#6e7489]">
                    Current blockers
                  </p>
                  <ReasonList
                    reasons={activeBlockers}
                    emptyLabel="No API blockers reported"
                  />
                  <AnalysisDiagnostics
                    readiness={readiness}
                    budget={readiness["heliusRequestBudget"]}
                  />
                </div>
              </Panel>
            </section>

            <section id="candidates" className="mt-5 scroll-mt-24">
              <Panel className="overflow-hidden">
                <div className="flex flex-col gap-3 border-b border-line/80 px-5 py-4 md:flex-row md:items-center md:justify-between md:px-6">
                  <SectionTitle
                    icon={Blocks}
                    title="Token candidates"
                    subtitle={
                      candidateData
                        ? `${number(candidateData.returnedCount)} shown · ${number(candidateData.totalDiscovered)} stored`
                        : "Candidate analysis and entry activity"
                    }
                  />
                  <div className="flex w-full min-w-0 items-center gap-2 md:w-auto">
                    <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-white/[0.08] bg-black/20 px-2.5 text-[#7d8498] md:w-56 md:flex-none">
                      <Search size={13} />
                      <input
                        aria-label="Filter candidates"
                        className="w-full bg-transparent text-[10px] text-white outline-none placeholder:text-[#687087]"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Filter name or mint"
                      />
                    </label>
                    <div className="hidden shrink-0 px-1 text-[10px] text-[#7d8498] sm:block">
                      Newest first
                    </div>
                  </div>
                </div>
                {filteredCandidates.length > 0 ? (
                  <div className="overflow-x-auto overscroll-x-contain">
                    <table className="w-full min-w-[1040px] table-fixed border-collapse text-left">
                      <colgroup>
                        <col className="w-[20%]" />
                        <col className="w-[17%]" />
                        <col className="w-[15%]" />
                        <col className="w-[14%]" />
                        <col className="w-[18%]" />
                        <col className="w-[9%]" />
                        <col className="w-[7%]" />
                      </colgroup>
                      <thead>
                        <tr className="border-b border-line/70 bg-white/[0.012] text-[9px] font-bold uppercase tracking-[0.12em] text-[#71778d]">
                          <th className="px-6 py-3 font-semibold">Token</th>
                          <th className="px-4 py-3 font-semibold">Decision</th>
                          <th className="px-4 py-3 font-semibold">
                            Security / behavior
                          </th>
                          <th className="px-4 py-3 font-semibold">Coverage</th>
                          <th className="px-4 py-3 font-semibold">
                            Entry activity
                          </th>
                          <th className="px-4 py-3 font-semibold">Seen</th>
                          <th className="px-4 py-3 text-center" />
                        </tr>
                      </thead>
                      <tbody>
                        {filteredCandidates.map((candidate) => (
                          <CandidateRow
                            key={candidate.token.mint}
                            candidate={candidate}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState
                    icon={search ? Search : Blocks}
                    title={
                      search
                        ? "No candidate matches this search"
                        : candidateData
                          ? "No tokens discovered yet"
                          : "Candidate data has not loaded"
                    }
                    description={
                      search
                        ? "Try a token name, ticker, or full mint address."
                        : candidateData
                          ? "When the discovery feed records a launch, it will appear here with its analysis and safety status."
                          : "The dashboard will show candidates when the internal API is available."
                    }
                  />
                )}
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line/70 px-5 py-3 text-[10px] text-[#7a8094] sm:px-6">
                  <span>
                    Showing the latest {number(filteredCandidates.length)}{" "}
                    candidate records
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Eye size={12} /> Read only · no transaction controls
                  </span>
                </div>
              </Panel>
            </section>

            <section
              id="portfolio"
              className="mt-5 grid scroll-mt-24 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,.8fr)]"
            >
              <Panel>
                <div className="flex items-start justify-between border-b border-line/80 px-5 py-4 sm:px-6">
                  <SectionTitle
                    icon={WalletCards}
                    title="PAPER portfolio"
                    subtitle="Virtual balances · quote-backed marks only"
                  />
                  <span className="rounded-lg border border-[#574684] bg-[#29223f]/70 px-2.5 py-1 text-[9px] font-bold text-[#c7baff]">
                    VIRTUAL
                  </span>
                </div>
                {paper ? (
                  <div className="p-5 sm:p-6">
                    <div className="grid gap-4 sm:grid-cols-3">
                      <PortfolioMetric
                        label="Virtual SOL"
                        value={formatSol(paper.solBalanceLamports)}
                      />
                      <PortfolioMetric
                        label="Realized PnL"
                        value={formatSol(paper.realizedPnlLamports)}
                      />
                      <PortfolioMetric
                        label="Unrealized PnL"
                        value={
                          paper.unrealizedPnlLamports === null
                            ? "Unavailable"
                            : formatSol(paper.unrealizedPnlLamports)
                        }
                        subdued={paper.unrealizedPnlLamports === null}
                      />
                    </div>
                    <div className="mt-5 flex items-center justify-between border-t border-line/70 pt-4 text-[10px] text-[#858ba0]">
                      <span className="font-mono">
                        Wallet {shortMint(paper.walletId)}
                      </span>
                      <span>{paper.positions.length} open positions</span>
                    </div>
                    <div className="mt-4 space-y-2">
                      {paper.positions.length ? (
                        paper.positions.slice(0, 4).map((position) => (
                          <div
                            key={position.mint}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-black/15 px-3.5 py-3"
                          >
                            <div>
                              <p className="font-mono text-[11px] text-slate-200">
                                {shortMint(position.mint)}
                              </p>
                              <p className="mt-1 text-[9px] text-[#7e8498]">
                                {position.tokenAmountRaw} raw units · basis{" "}
                                {formatSol(position.costBasisLamports)}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="text-[10px] text-slate-200">
                                {position.unrealizedPnlLamports === null
                                  ? "Unpriceable"
                                  : formatSol(position.unrealizedPnlLamports)}
                              </p>
                              <p className="mt-1 text-[9px] text-[#7e8498]">
                                {position.monitor?.reasonCode
                                  ? formatReason(position.monitor.reasonCode)
                                  : (position.monitor?.status ?? "OPEN")}
                              </p>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="rounded-xl border border-dashed border-white/[0.09] px-4 py-7 text-center text-[11px] text-[#777e92]">
                          No open PAPER positions are stored.
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <EmptyState
                    icon={WalletCards}
                    title={
                      paperMode
                        ? "PAPER wallet data unavailable"
                        : "Switch to PAPER to view virtual portfolio"
                    }
                    description={
                      paperMode
                        ? "The API could not provide wallet status. No balances are estimated by the dashboard."
                        : "The dashboard reads balances only from the configured virtual wallet."
                    }
                    compact
                  />
                )}
              </Panel>

              <Panel>
                <div className="border-b border-line/80 px-5 py-4 sm:px-6">
                  <SectionTitle
                    icon={Activity}
                    title="Provider health"
                    subtitle="RPC and streams are shown separately"
                  />
                </div>
                <div className="space-y-2.5 p-5 sm:p-6">
                  {providerStates.length ? (
                    providerStates.slice(0, 8).map((provider, index) => {
                      const name = String(
                        provider["provider"] ?? `Provider ${index + 1}`,
                      );
                      const state = String(provider["state"] ?? "UNKNOWN");
                      const updated =
                        typeof provider["checkedAtUtc"] === "string"
                          ? provider["checkedAtUtc"]
                          : null;
                      return (
                        <div
                          key={name}
                          className="flex items-center gap-3 rounded-xl border border-white/[0.055] bg-black/15 px-3.5 py-3"
                        >
                          <ProviderIcon name={name} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[11px] font-semibold text-slate-200">
                              {providerLabel(name)}
                            </p>
                            <p className="mt-1 text-[9px] text-[#7b8297]">
                              {provider["errorCode"]
                                ? formatReason(String(provider["errorCode"]))
                                : `Checked ${formatAge(updated)}`}
                            </p>
                          </div>
                          <StatusBadge value={state} />
                        </div>
                      );
                    })
                  ) : (
                    <EmptyState
                      icon={Activity}
                      title="Provider status unavailable"
                      description="No provider health records were returned by the API."
                      compact
                    />
                  )}
                  {health?.completeness && (
                    <div className="mt-4 rounded-xl border border-[#443644] bg-[#241b2b]/50 p-3.5">
                      <div className="flex items-center gap-2 text-[#d6c6fb]">
                        <CircleAlert size={14} />
                        <p className="text-[10px] font-semibold">
                          Observation completeness
                        </p>
                      </div>
                      <p className="mt-1.5 text-[10px] leading-relaxed text-[#a394b0]">
                        {String(
                          health.completeness["coverageStatus"] ?? "UNKNOWN",
                        )}{" "}
                        ·{" "}
                        {health.completeness["reasonCode"]
                          ? formatReason(
                              String(health.completeness["reasonCode"]),
                            )
                          : "Historical trade coverage is not established by socket health alone."}
                      </p>
                    </div>
                  )}
                </div>
              </Panel>
            </section>

            <footer className="mt-6 flex flex-col gap-2 border-t border-line/70 pt-4 text-[9px] text-[#62697d] sm:flex-row sm:items-center sm:justify-between">
              <span>Solana Sentinel · operational read-only console</span>
              <span className="flex items-center gap-1.5">
                <ShieldCheck size={11} /> PAPER is virtual. LIVE trading is
                unsupported.
              </span>
            </footer>
          </main>
        </div>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex h-[76px] items-center gap-3 border-b border-line/70 px-5">
      <div className="relative flex size-9 items-center justify-center rounded-[13px] border border-[#6556a6] bg-[#2a2342] text-[#d1c6ff]">
        <Blocks size={19} strokeWidth={1.7} />
        <span className="absolute -right-1 -top-1 size-2 rounded-full border-2 border-[#0b0d16] bg-mint" />
      </div>
      <div>
        <p className="text-[12px] font-extrabold tracking-[0.12em] text-[#f0eff8]">
          SENTINEL
        </p>
        <p className="mt-0.5 text-[9px] text-[#777e92]">Launch intelligence</p>
      </div>
    </div>
  );
}

function Panel({
  children,
  className = "",
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div
      id={id}
      className={`rounded-[18px] border border-line/90 bg-panel shadow-[0_12px_40px_rgba(0,0,0,.13)] ${className}`}
    >
      {children}
    </div>
  );
}

function SectionTitle({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: typeof Gauge;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.035] text-[#a89aff]">
        <Icon size={14} strokeWidth={1.9} />
      </span>
      <div className="min-w-0">
        <h2 className="text-[12px] font-bold tracking-[-0.01em] text-[#eff0f6]">
          {title}
        </h2>
        <p className="mt-1 text-[9px] text-[#7d8499]">{subtitle}</p>
      </div>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  tint,
}: {
  icon: typeof Gauge;
  label: string;
  value: string;
  detail: string;
  tint: "violet" | "mint" | "amber";
}) {
  const tintClass =
    tint === "violet"
      ? "text-[#b3a4ff] bg-[#30264a]"
      : tint === "mint"
        ? "text-mint bg-[#18322f]"
        : "text-[#f0c987] bg-[#342c24]";
  return (
    <div className="relative flex min-h-[132px] flex-col overflow-hidden rounded-2xl border border-line bg-panel px-4 py-4 sm:px-5">
      <div className="absolute right-0 top-0 h-20 w-24 rounded-full bg-violet/[0.035] blur-2xl" />
      <div className="relative flex items-start justify-between gap-2">
        <p className="min-h-7 text-[10px] font-semibold leading-3.5 text-[#9ba1b3]">
          {label}
        </p>
        <span
          className={`flex size-7 items-center justify-center rounded-lg ${tintClass}`}
        >
          <Icon size={14} />
        </span>
      </div>
      <p className="relative mt-3 truncate text-[24px] font-semibold tracking-[-0.045em] text-[#f3f2f8] sm:text-[27px]">
        {value}
      </p>
      <p className="relative mt-auto truncate pt-1.5 text-[9px] text-[#7e859a]">
        {detail}
      </p>
    </div>
  );
}

function FunnelStage({
  label,
  count,
  max,
  index,
}: {
  label: string;
  count: number | null;
  max: number;
  index: string;
}) {
  const width =
    count === null || max <= 0
      ? 0
      : Math.max(3, Math.min(100, (count / max) * 100));
  return (
    <div className="px-2 py-3.5 sm:px-4 sm:py-4">
      <div className="flex items-center justify-between">
        <p className="text-[9px] text-[#81879b]">{label}</p>
        <span className="font-mono text-[8px] text-[#545a6d]">{index}</span>
      </div>
      <p className="mt-2 font-mono text-[17px] font-medium tracking-tight text-slate-100">
        {count === null ? "—" : number(count)}
      </p>
      <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-white/[0.055]">
        <div
          className="h-full rounded-full bg-gradient-to-r from-[#6854be] to-[#a995ff] transition-[width] duration-500"
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

function CandidateRow({ candidate }: { candidate: Candidate }) {
  const evaluation = candidate.entryEvaluation;
  const coverage = candidate.tradeCoverage?.status ?? "UNKNOWN";
  const behavior = candidate.launchBehavior?.complete
    ? "Complete"
    : "Incomplete";
  const security = candidate.security?.status ?? "Missing";
  return (
    <tr className="border-b border-line/50 transition-colors last:border-0 hover:bg-white/[0.018]">
      <td className="px-6 py-3.5">
        <div className="flex items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-white/[0.07] bg-[#1b1d2b] text-[10px] font-bold text-[#b5a5ff]">
            {(candidate.token.symbol ?? candidate.token.name ?? "?")
              .slice(0, 2)
              .toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="max-w-[180px] truncate text-[11px] font-semibold text-[#e7e8ef]">
              {candidate.token.name ??
                candidate.token.symbol ??
                "Unknown token"}
            </p>
            <p className="mt-1 font-mono text-[9px] text-[#777e92]">
              {candidate.token.symbol ? `$${candidate.token.symbol} · ` : ""}
              {shortMint(candidate.token.mint)}
            </p>
          </div>
        </div>
      </td>
      <td className="px-4 py-3.5">
        <StatusBadge value={candidate.decision?.status ?? "NO_DECISION"} />
        <p className="mt-1.5 max-w-[150px] truncate text-[9px] text-[#777e92]">
          {candidate.decision?.reasonCodes?.[0]
            ? formatReason(candidate.decision.reasonCodes[0])
            : "No decision recorded"}
        </p>
      </td>
      <td className="px-4 py-3.5">
        <div className="flex items-center gap-1.5">
          <StatusBadge value={security} compact />
        </div>
        <p className="mt-1.5 truncate text-[9px] text-[#777e92]">
          Behavior {behavior.toLowerCase()}
        </p>
      </td>
      <td className="px-4 py-3.5">
        <StatusBadge value={coverage} compact />
        <p className="mt-1.5 max-w-[130px] truncate text-[9px] text-[#777e92]">
          {candidate.tradeReconciliation
            ? `${candidate.tradeReconciliation.status} · ${candidate.tradeReconciliation.pagesScanned} pages · ${candidate.tradeReconciliation.pendingTransactions} pending`
            : candidate.tradeCoverage?.reasonCode
              ? formatReason(candidate.tradeCoverage.reasonCode)
              : "No coverage proof"}
        </p>
      </td>
      <td className="px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge
            value={evaluation.activity ?? evaluation.status}
            compact
          />
          <span className="font-mono text-[9px] text-[#9298aa]">
            {evaluation.orderAttemptCount} attempts
          </span>
        </div>
        <p className="mt-1.5 max-w-[180px] truncate text-[9px] text-[#8c92a5]">
          {formatReason(evaluation.reasonCode)}
        </p>
      </td>
      <td className="px-4 py-3.5">
        <p
          className="truncate text-[9px] text-[#9da3b4]"
          title={formatAge(candidate.token.firstSeenAtUtc)}
        >
          {formatAge(candidate.token.firstSeenAtUtc)}
        </p>
        <p
          className="mt-1 truncate text-[9px] text-[#686f83]"
          title={candidate.token.marketPhase}
        >
          {candidate.token.marketPhase}
        </p>
      </td>
      <td className="px-4 py-3.5 text-center">
        <a
          className="mx-auto flex size-7 items-center justify-center rounded-lg border border-white/[0.07] text-[#7e8599] transition hover:border-[#6654b5] hover:text-[#c5b8ff]"
          href={`/api/tokens/${encodeURIComponent(candidate.token.mint)}`}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open API details for ${candidate.token.name ?? candidate.token.mint}`}
        >
          <ExternalLink size={13} />
        </a>
      </td>
    </tr>
  );
}

function StatusBadge({
  value,
  compact = false,
}: {
  value: string;
  compact?: boolean;
}) {
  const normalized = value.toUpperCase();
  const good = [
    "HEALTHY",
    "SUPPORTED",
    "COMPLETE",
    "BUY_ELIGIBLE",
    "FILLED",
    "CONNECTED",
    "IN_PROGRESS",
  ].includes(normalized);
  const warning = [
    "WATCH",
    "UNVERIFIED",
    "PARTIAL",
    "EVALUATING",
    "NOT_EVALUATED",
    "NOT_ATTEMPTED",
    "DISABLED",
    "OPEN",
  ].includes(normalized);
  const bad = [
    "REJECT",
    "REJECTED",
    "QUARANTINE",
    "UNFILLABLE",
    "GAP_DETECTED",
    "DEGRADED",
    "OFFLINE",
    "EXIT_BLOCKED",
    "UNPRICEABLE",
  ].includes(normalized);
  const style = good
    ? "border-[#24584d] bg-[#142a27] text-[#73e0ba]"
    : warning
      ? "border-[#574a38] bg-[#2b261e] text-[#edc786]"
      : bad
        ? "border-[#633742] bg-[#302027] text-[#f09aa6]"
        : "border-white/[0.08] bg-white/[0.035] text-[#a5abbd]";
  return (
    <span
      className={`inline-flex max-w-[155px] items-center gap-1.5 truncate rounded-md border font-bold ${compact ? "px-1.5 py-0.5 text-[8px]" : "px-2 py-1 text-[8px]"} ${style}`}
      title={value}
    >
      <span
        className={`size-1 rounded-full ${good ? "bg-mint" : warning ? "bg-[#e8bd74]" : bad ? "bg-rose" : "bg-[#8d93a5]"}`}
      />
      {formatBadge(normalized)}
    </span>
  );
}

function ReadinessRow({ label, value }: { label: string; value: string }) {
  const healthy = value === "Ready" || value === "Running";
  const inactive = value === "Disabled";
  const blocked = value === "Blocked";
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <span
          className={`flex size-5 shrink-0 items-center justify-center rounded-md ${healthy ? "bg-[#18312e] text-mint" : inactive ? "bg-[#302528] text-[#e4a4ad]" : blocked ? "bg-[#38262b] text-[#ed929f]" : "bg-[#302b23] text-[#e8c07f]"}`}
        >
          {healthy ? (
            <CircleCheck size={12} />
          ) : inactive ? (
            <X size={11} />
          ) : (
            <CircleDot size={12} />
          )}
        </span>
        <span className="min-w-0 truncate text-[10px] text-[#a7adbd]">
          {label}
        </span>
      </div>
      <span
        className={`shrink-0 whitespace-nowrap text-right text-[9px] font-semibold ${healthy ? "text-mint" : inactive || blocked ? "text-[#dc9aa4]" : "text-[#d9b977]"}`}
      >
        {value}
      </span>
    </div>
  );
}

function PortfolioMetric({
  label,
  value,
  subdued = false,
}: {
  label: string;
  value: string;
  subdued?: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-black/15 px-3.5 py-3">
      <p className="text-[9px] text-[#81879a]">{label}</p>
      <p
        className={`mt-2 truncate text-[15px] font-semibold tracking-[-0.03em] ${subdued ? "text-[#70778c]" : "text-slate-100"}`}
      >
        {value}
      </p>
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
  compact = false,
}: {
  icon: typeof Blocks;
  title: string;
  description: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center px-5 text-center ${compact ? "py-8" : "py-14"}`}
    >
      <span className="mb-3 flex size-10 items-center justify-center rounded-2xl border border-white/[0.07] bg-white/[0.025] text-[#8c82b8]">
        <Icon size={18} />
      </span>
      <h3 className="text-[11px] font-semibold text-[#d7d9e2]">{title}</h3>
      <p className="mt-1.5 max-w-sm text-[10px] leading-relaxed text-[#7e8498]">
        {description}
      </p>
    </div>
  );
}

function ReasonList({
  reasons,
  emptyLabel,
}: {
  reasons: string[];
  emptyLabel: string;
}) {
  if (reasons.length === 0)
    return <p className="text-[10px] text-[#858ba0]">{emptyLabel}</p>;
  return (
    <ul className="space-y-1.5">
      {reasons.slice(0, 5).map((reason) => (
        <li
          key={reason}
          className="flex items-start gap-2 text-[10px] text-[#ddaab1]"
        >
          <CircleAlert size={11} className="mt-0.5 shrink-0" />
          <span>{formatReason(reason)}</span>
        </li>
      ))}
    </ul>
  );
}

function HealthPill({ state }: { state: LoadState }) {
  const text =
    state === "connected"
      ? "API connected"
      : state === "loading"
        ? "Connecting"
        : state === "degraded"
          ? "API degraded"
          : "API offline";
  const color =
    state === "connected"
      ? "bg-mint"
      : state === "loading"
        ? "bg-amber-300"
        : "bg-rose";
  return (
    <span className="inline-flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.025] px-3 py-2">
      <span
        className={`size-1.5 rounded-full ${color} ${state === "connected" ? "shadow-[0_0_8px_#48d6a2aa]" : ""}`}
      />
      {text}
    </span>
  );
}

function ProviderIcon({ name }: { name: string }) {
  const normalized = name.toLowerCase();
  const Icon = normalized.includes("helius")
    ? CircleDot
    : normalized.includes("pump")
      ? Zap
      : Activity;
  const color = normalized.includes("helius")
    ? "text-[#c0a8ff] bg-[#251f38]"
    : normalized.includes("pump")
      ? "text-[#f3a6b2] bg-[#35232b]"
      : "text-[#9cc7ee] bg-[#1d2a36]";
  return (
    <div
      className={`flex size-8 shrink-0 items-center justify-center rounded-xl ${color}`}
    >
      <Icon size={14} />
    </div>
  );
}

function providerLabel(name: string): string {
  const labels: Record<string, string> = {
    pumpportal: "PumpPortal discovery",
    helius: "Helius RPC",
    helius_trade_stream: "Helius trade stream",
    helius_logs: "Helius logs stream",
  };
  return labels[name.toLowerCase()] ?? name.replaceAll("_", " ");
}

function truthy(value: unknown): string {
  return value === true ? "Ready" : value === false ? "Blocked" : "Unknown";
}

function readinessStatus(status: unknown, fallback: unknown): string {
  if (typeof status === "string") {
    const labels: Record<string, string> = {
      READY: "Ready",
      IDLE: "Idle · no active monitoring leases",
      RUNNING: "Running",
      DEGRADED: "Degraded",
      BLOCKED: "Blocked",
      DISABLED: "Disabled",
    };
    if (labels[status]) return labels[status];
  }
  return truthy(fallback);
}

function AnalysisDiagnostics({
  readiness,
  budget,
}: {
  readiness: Record<string, unknown>;
  budget: unknown;
}) {
  const diagnostics = readiness["analysisDiagnostics"];
  const data =
    diagnostics && typeof diagnostics === "object"
      ? (diagnostics as Record<string, unknown>)
      : {};
  const budgetData =
    budget && typeof budget === "object"
      ? (budget as Record<string, unknown>)
      : {};
  const tradeData =
    readiness["tradeObservationDiagnostics"] &&
    typeof readiness["tradeObservationDiagnostics"] === "object"
      ? (readiness["tradeObservationDiagnostics"] as Record<string, unknown>)
      : {};
  const paperData =
    readiness["paper"] && typeof readiness["paper"] === "object"
      ? (readiness["paper"] as Record<string, unknown>)
      : {};
  const monitorData =
    paperData["positionMonitor"] &&
    typeof paperData["positionMonitor"] === "object"
      ? (paperData["positionMonitor"] as Record<string, unknown>)
      : {};
  const analysisBlockers = Array.isArray(data["blockers"])
    ? (data["blockers"] as string[])
    : [];
  const historicalAnalysis =
    data["historicalStatusCounts"] &&
    typeof data["historicalStatusCounts"] === "object"
      ? (data["historicalStatusCounts"] as Record<string, number>)
      : {};
  const automaticBlockers = Array.isArray(readiness["automaticEntryBlockers"])
    ? (readiness["automaticEntryBlockers"] as string[])
    : [];
  const experimentalBlockers = Array.isArray(
    readiness["paperExperimentalEntryBlockers"],
  )
    ? (readiness["paperExperimentalEntryBlockers"] as string[])
    : [];
  const coverageStatuses =
    tradeData["byStatus"] && typeof tradeData["byStatus"] === "object"
      ? Object.entries(tradeData["byStatus"] as Record<string, number>)
      : [];
  const rpcErrors = Array.isArray(budgetData["byErrorCode"])
    ? (budgetData["byErrorCode"] as Array<Record<string, unknown>>)
    : [];
  const reasons = Array.isArray(readiness["decisionRejectionReasons"])
    ? (readiness["decisionRejectionReasons"] as Array<Record<string, unknown>>)
    : [];
  return (
    <div className="mt-4 space-y-3 border-t border-line/70 pt-3">
      <div className="grid grid-cols-2 gap-2 text-[9px] text-[#8c93a8] sm:grid-cols-4">
        <DiagnosticValue label="Active leases" value={data["eligibleTokens"]} />
        <DiagnosticValue label="Queued" value={data["pending"]} />
        <DiagnosticValue label="Processing" value={data["processing"]} />
        <DiagnosticValue label="Analyzed total" value={data["complete"]} />
        <DiagnosticValue
          label="Failed total"
          value={historicalAnalysis["FAILED"]}
        />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[9px] text-[#8c93a8]">
        <span>
          Helius provider: {String(readiness["heliusRpcStatus"] ?? "UNKNOWN")} ·{" "}
          {String(readiness["heliusProviderErrorCode"] ?? "no provider error")}
        </span>
        <span>
          Helius RPC: {number(budgetData["used"] as number | undefined)} used ·{" "}
          {number(budgetData["remaining"] as number | undefined)} remaining
        </span>
        <span>
          Rolling {number(budgetData["rollingUsed"] as number | undefined)} /{" "}
          {number(budgetData["rollingLimit"] as number | undefined)} in{" "}
          {number(budgetData["rollingWindowSeconds"] as number | undefined)}s ·{" "}
          {number(budgetData["rollingRemaining"] as number | undefined)}{" "}
          remaining (
          {number(
            budgetData["rollingCandidateRemaining"] as number | undefined,
          )}{" "}
          candidate capacity)
        </span>
        <span>
          Daily candidate capacity:{" "}
          {number(budgetData["dailyCandidateRemaining"] as number | undefined)}
        </span>
        <span>
          Deferred: {number(budgetData["deferred"] as number | undefined)} RPC
          requests
        </span>
        <span>
          RPC outcomes: {number(budgetData["completed"] as number | undefined)}{" "}
          completed · {number(budgetData["failed"] as number | undefined)}{" "}
          failed · {number(budgetData["retries"] as number | undefined)} retries
        </span>
        <span>
          RPC priority counts:{" "}
          {Object.entries(
            (
              budgetData["byPriority"] as
                Array<Record<string, unknown>> | undefined
            )?.reduce<Record<string, number>>((counts, item) => {
              const priority = String(item["priority"] ?? "UNKNOWN");
              counts[priority] = Number(item["attempts"] ?? 0);
              return counts;
            }, {}) ?? {},
          )
            .map(([priority, count]) => `${priority} ${number(count)}`)
            .join(" · ") || "No RPC attempts"}
        </span>
        <span>
          Trade coverage:{" "}
          {number(tradeData["completeTokens"] as number | undefined)} /{" "}
          {number(tradeData["monitoredTokens"] as number | undefined)} complete
          · {String(healthCoverage(readiness["tradeObservationStatus"]))}
        </span>
        <span>
          Verified trades:{" "}
          {number(tradeData["verifiedObservationCount"] as number | undefined)}{" "}
          / {number(tradeData["observationCount"] as number | undefined)}
        </span>
        <span>
          Verified BUY / SELL:{" "}
          {number(tradeData["verifiedBuyCount"] as number | undefined)} /{" "}
          {number(tradeData["verifiedSellCount"] as number | undefined)}
        </span>
        <span>
          Parsed Scan credits:{" "}
          {number(
            (
              tradeData["parsedScanCredits"] as
                Record<string, number> | undefined
            )?.["used"],
          )}{" "}
          used ·{" "}
          {number(
            (
              tradeData["parsedScanCredits"] as
                Record<string, number> | undefined
            )?.["reserved"],
          )}{" "}
          reserved ·{" "}
          {number(
            (
              tradeData["parsedScanCredits"] as
                Record<string, number> | undefined
            )?.["remaining"],
          )}{" "}
          remaining
        </span>
        <span>
          Reconciliation:{" "}
          {Object.entries(
            (tradeData["reconciliationByStatus"] as
              Record<string, number> | undefined) ?? {},
          )
            .map(([state, count]) => `${state} ${number(count)}`)
            .join(" · ") || "No jobs"}
        </span>
      </div>
      {coverageStatuses.length > 0 && (
        <p className="text-[9px] leading-relaxed text-[#8c93a8]">
          Coverage states:{" "}
          {coverageStatuses
            .map(([state, count]) => `${state} ${number(count)}`)
            .join(" · ")}
        </p>
      )}
      {experimentalBlockers.length > 0 && (
        <div className="space-y-1">
          <p className="text-[9px] font-semibold uppercase tracking-wide text-[#8c93a8]">
            Experimental entry blockers
          </p>
          <ReasonList reasons={experimentalBlockers} emptyLabel="No blockers" />
        </div>
      )}
      <p className="text-[9px] leading-relaxed text-[#8c93a8]">
        Exit monitor: {String(monitorData["status"] ?? "Unavailable")} ·{" "}
        {number(monitorData["openPositions"] as number | undefined)} open ·
        configured{" "}
        {number(monitorData["configuredIntervalMs"] as number | undefined)} ms
        base · estimate{" "}
        {number(monitorData["estimatedNextIntervalMs"] as number | undefined)}{" "}
        ms · exit RPC{" "}
        {number(monitorData["exitRequestsUsed"] as number | undefined)} used /{" "}
        {number(monitorData["exitRequestsRemaining"] as number | undefined)}{" "}
        available · capacity{" "}
        {formatReason(String(monitorData["budgetReadiness"] ?? "UNKNOWN"))} ·
        daily need{" "}
        {number(monitorData["requiredDailyExitRequests"] as number | undefined)}{" "}
        / {number(monitorData["reservedExitRequests"] as number | undefined)}{" "}
        reserved daily · rolling{" "}
        {number(monitorData["rollingRequestsRemaining"] as number | undefined)}{" "}
        remaining /{" "}
        {number(
          monitorData["reservedExitRequestsWindow"] as number | undefined,
        )}{" "}
        reserved
      </p>
      {rpcErrors.length > 0 && (
        <p className="text-[9px] leading-relaxed text-[#d1aa72]">
          RPC errors today:{" "}
          {rpcErrors
            .slice(0, 4)
            .map(
              (item) =>
                `${formatReason(String(item["errorCode"]))} (${number(item["count"] as number | undefined)})`,
            )
            .join(" · ")}
        </p>
      )}
      {analysisBlockers.length > 0 && (
        <p className="text-[9px] leading-relaxed text-[#d1aa72]">
          Analysis: {analysisBlockers.map(formatReason).join(" · ")}
        </p>
      )}
      {automaticBlockers.length > 0 && (
        <p className="text-[9px] leading-relaxed text-[#d1aa72]">
          Entry scheduler: {automaticBlockers.map(formatReason).join(" · ")}
        </p>
      )}
      {reasons.length > 0 && (
        <div>
          <p className="mb-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#6e7489]">
            Recent decision reason codes
          </p>
          <div className="flex flex-wrap gap-1.5">
            {reasons.slice(0, 5).map((item) => (
              <span
                key={String(item["reasonCode"])}
                className="rounded-md border border-white/[0.06] bg-black/15 px-2 py-1 text-[9px] text-[#a6adbf]"
              >
                {formatReason(String(item["reasonCode"]))} ·{" "}
                {number(item["count"] as number | undefined)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DiagnosticValue({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-lg border border-white/[0.045] bg-black/15 px-2.5 py-2">
      <span>{label}</span>
      <strong className="ml-1.5 font-mono text-slate-200">
        {number(typeof value === "number" ? value : undefined)}
      </strong>
    </div>
  );
}

function healthCoverage(status: unknown): string {
  if (typeof status === "string") return formatReason(status);
  return "Unavailable";
}

function number(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US")
    : "—";
}

function analyzedCount(values: Candidate[]): number {
  return values.filter(
    (candidate) => candidate.analysis?.["status"] === "COMPLETE",
  ).length;
}

function formatBadge(value: string): string {
  return value.replaceAll("_", " ");
}

function errorLabel(error: unknown): string {
  if (error instanceof ApiError) return `API returned ${error.status}`;
  if (error instanceof Error && error.name === "AbortError")
    return "Request timed out";
  return "Sentinel API could not be reached";
}
