import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Info,
  SearchX,
  ShieldAlert,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { AppAssignment } from "@/models";
import type {
  AggregatedKPIValue,
  ComparisonResult,
  RAGStatus,
  SuppressionReason,
} from "@/models/results";
import { NO_DATA, type Numeric } from "@/models/sentinels";
import { noDataReason } from "@/engine/raw-mode";
import { KPI_REGISTRY } from "@/registry/kpi-registry";
import type { KPIDefinition, Pillar } from "@/registry/kpi-types";
import {
  useDatasetStore,
  useFilterStore,
  useResultStore,
  useSLAStore,
  applySlice,
} from "@/stores";

import { Sparkline } from "./Sparkline";
import {
  buildScorecardSeries,
  type KpiSeries,
} from "./scorecard-series";
import {
  advisoryLabel,
  formatAbsoluteDelta,
  formatPercentDelta,
  formatValue,
  ragPresentation,
} from "./scorecard-format";

/**
 * ScorecardGrid — the pillar-tabbed grid of KPI scorecards (Req 11; design "KPI
 * Scorecards"), the primary comparison surface of the dashboard.
 *
 * One tab per {@link Pillar}; each tab holds a responsive grid of cards, one per
 * KPI in that pillar. Every card shows the App_A and App_B values under the
 * dataset's custom labels (Req 19.6), the absolute and percentage deltas
 * (2 decimals, "N/A" when App_A is 0 — Req 11.3, 11.4), a RAG badge from the
 * comparator (Req 11.5), and a 7-day trend sparkline with a partial-data
 * indicator when the slice spans fewer than 7 days (Req 11.7, 11.8).
 *
 * The card also surfaces the engine's guard states verbatim so the analyst
 * always gets the right instruction:
 * - **No data** (Req 11.9, 16.5) — widen the slice; a raw dataset additionally
 *   names why a structurally-underivable KPI has no value (Req 23.2).
 * - **Not aggregable** (Req 23.4, 23.8) — narrow the slice to the ingested
 *   granularity; the value/delta/RAG are suppressed with that reason.
 * - **Low confidence** (Req 25.5, 25.7) — the values and both deltas are still
 *   shown, badged with both contributing counts and the active threshold.
 * - **Data-quality advisories** (Req 22.6, 22.9, 20.4) — assumed unit,
 *   unweighted aggregate, and non-monotonic quartiles appear as expandable
 *   badges on the affected card.
 *
 * The comparison values come pre-computed from {@link useResultStore}; the card
 * never re-runs the comparator. The 7-day sparkline needs a per-day breakdown
 * the engine's overall result does not carry, so it is derived once (memoized)
 * from the active dataset's sliced records through the same pure engine path
 * (see {@link buildScorecardSeries}). All colors resolve against the dark-theme
 * `rag.*` tokens and RAG is never color-only — every badge pairs a token color
 * with a glyph and a text label (Req 15.1, 28.2).
 */

/** The four pillars, in registry order, one tab each (Req 11.1). */
const PILLARS: readonly Pillar[] = [
  "Playback Quality & QoE",
  "User Engagement & Audience Retention",
  "Monetization & AdTech",
  "Infrastructure & Delivery",
];

/** The Lucide glyph for each RAG presentation glyph name (Req 28.2). */
const RAG_GLYPHS: Record<
  ReturnType<typeof ragPresentation>["glyph"],
  LucideIcon
> = {
  check: CheckCircle2,
  "alert-triangle": AlertTriangle,
  x: XCircle,
  help: HelpCircle,
  "shield-alert": ShieldAlert,
};

/** A RAG badge: token color + glyph + label, never color alone (Req 28.2). */
function RagBadge({
  rag,
  reason,
}: {
  rag: RAGStatus;
  reason?: SuppressionReason;
}) {
  const p = ragPresentation(rag, reason);
  const Glyph = RAG_GLYPHS[p.glyph];
  return (
    <span
      data-testid="rag-badge"
      data-rag={rag}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-semibold",
        p.className,
      )}
    >
      <Glyph className="size-3" aria-hidden={true} />
      {p.label}
    </span>
  );
}

/** The two-column App_A / App_B value block with the sparkline beside each. */
function AppValue({
  label,
  value,
  unit,
  series,
}: {
  label: string;
  value: Numeric;
  unit: string;
  series: KpiSeries | undefined;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="text-sm font-semibold tabular-nums text-foreground">
        {formatValue(value, unit)}
      </span>
      {series && (
        <Sparkline
          points={series.points}
          label={`${label} 7-day trend`}
          className="mt-0.5"
        />
      )}
    </div>
  );
}

/** An expandable data-quality advisory badge (assumed unit / unweighted / etc). */
function AdvisoryBadges({ values }: { values: AggregatedKPIValue[] }) {
  // Collect the distinct advisory codes across both apps' aggregates.
  const advisories = React.useMemo(() => {
    const byCode = new Map<string, string>();
    for (const v of values) {
      for (const a of v.advisories) {
        if (!byCode.has(a.code)) byCode.set(a.code, a.detail);
      }
    }
    return [...byCode.entries()];
  }, [values]);

  if (advisories.length === 0) return null;

  return (
    <ul
      aria-label="Data-quality advisories"
      className="flex flex-wrap gap-1"
      data-testid="advisories"
    >
      {advisories.map(([code, detail]) => (
        <li key={code}>
          <span
            data-advisory={code}
            title={detail}
            className="inline-flex items-center gap-1 rounded border border-rag-amber/40 bg-rag-amber/10 px-1.5 py-0.5 text-2xs font-medium text-rag-amber"
          >
            <Info className="size-3" aria-hidden="true" />
            {advisoryLabel(code as Parameters<typeof advisoryLabel>[0])}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Everything the card needs to render one KPI's comparison. */
interface CardModel {
  kpi: KPIDefinition;
  comparison: ComparisonResult | undefined;
  appA: AggregatedKPIValue | undefined;
  appB: AggregatedKPIValue | undefined;
  seriesA: KpiSeries | undefined;
  seriesB: KpiSeries | undefined;
}

/**
 * A single KPI scorecard. Chooses one of the card's states from the comparison
 * verdict and the underlying aggregates:
 *   - NoData (suppressed values/delta/RAG, Req 11.9);
 *   - NotAggregable (suppressed, narrow-the-slice hint, Req 23.8);
 *   - LowConfidence (values + deltas shown, counts + threshold, Req 25.5, 25.7);
 *   - a normal Green/Amber/Red verdict.
 */
function Scorecard({
  model,
  appALabel,
  appBLabel,
  minSampleSize,
  isRawMode,
}: {
  model: CardModel;
  appALabel: string;
  appBLabel: string;
  minSampleSize: number;
  isRawMode: boolean;
}) {
  const { kpi, comparison, appA, appB, seriesA, seriesB } = model;

  const rag = comparison?.rag ?? "NoData";
  const reason = comparison?.suppressionReason;
  const unit = appA?.unit ?? appB?.unit ?? kpi.canonicalUnit;

  const isNoData = rag === "NoData" && reason !== "not_aggregable";
  const isNotAggregable = rag === "NoData" && reason === "not_aggregable";
  const isLowConfidence = rag === "LowConfidence";

  // The specific no-data reason for a structurally underivable KPI in a raw
  // dataset (Churn, ARPU → "not derivable from session logs" — Req 23.2). For a
  // simple empty slice we fall back to the widen-the-slice guidance.
  const noDataDetail = React.useMemo(() => {
    if (!isNoData) return undefined;
    if (isRawMode) {
      const specific = noDataReason(kpi.id);
      if (specific) return specific;
    }
    return "No records match the active slice for this KPI. Widen the date range or clear a dimension.";
  }, [isNoData, isRawMode, kpi.id]);

  const partial = seriesA?.partial || seriesB?.partial || false;

  const advisoryValues = [appA, appB].filter(
    (v): v is AggregatedKPIValue => v !== undefined,
  );

  return (
    <article
      aria-label={kpi.name}
      data-testid="scorecard"
      data-kpi={kpi.id}
      data-state={
        isNoData
          ? "no-data"
          : isNotAggregable
            ? "not-aggregable"
            : isLowConfidence
              ? "low-confidence"
              : "ok"
      }
      className="flex flex-col gap-3 rounded-lg border border-border bg-card/50 p-3"
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-xs font-semibold text-foreground" title={kpi.name}>
            {kpi.name}
          </h3>
          <p className="text-2xs text-muted-foreground">{kpi.unit}</p>
        </div>
        <RagBadge rag={rag} reason={reason} />
      </header>

      {isNoData ? (
        <div
          data-testid="scorecard-no-data"
          className="flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border/70 py-4 text-center"
        >
          <SearchX className="size-5 text-muted-foreground" aria-hidden="true" />
          <p className="text-2xs text-muted-foreground">{noDataDetail}</p>
        </div>
      ) : isNotAggregable ? (
        <div
          data-testid="scorecard-not-aggregable"
          className="flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border/70 py-4 text-center"
        >
          <XCircle className="size-5 text-muted-foreground" aria-hidden="true" />
          <p className="text-2xs text-muted-foreground">
            Not aggregable at this slice. Narrow the range to the ingested
            {" "}
            {appA?.ingestedGranularity ?? appB?.ingestedGranularity ?? "granularity"}
            {" "}
            to see this value.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <AppValue
              label={appALabel}
              value={comparison?.appAValue ?? NO_DATA}
              unit={unit}
              series={seriesA}
            />
            <AppValue
              label={appBLabel}
              value={comparison?.appBValue ?? NO_DATA}
              unit={unit}
              series={seriesB}
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 pt-2 text-2xs">
            <span className="text-muted-foreground">
              Δ abs{" "}
              <span className="font-semibold tabular-nums text-foreground">
                {formatAbsoluteDelta(comparison?.absoluteDelta ?? NO_DATA, unit)}
              </span>
            </span>
            <span className="text-muted-foreground">
              Δ %{" "}
              <span
                data-testid="percent-delta"
                className="font-semibold tabular-nums text-foreground"
              >
                {formatPercentDelta(comparison?.percentDelta ?? NO_DATA)}
              </span>
            </span>
          </div>

          {isLowConfidence && (
            <p
              data-testid="low-confidence-detail"
              className="rounded border border-rag-neutral/40 bg-rag-neutral/10 px-2 py-1 text-2xs text-muted-foreground"
            >
              Low confidence: {appALabel} {comparison?.appAContributingRecords ?? 0},
              {" "}
              {appBLabel} {comparison?.appBContributingRecords ?? 0} contributing
              {" "}
              vs. minimum {minSampleSize}.
            </p>
          )}
        </>
      )}

      {partial && !isNoData && !isNotAggregable && (
        <p
          data-testid="partial-data"
          className="text-2xs text-rag-amber"
        >
          Partial data: fewer than 7 days in the active slice.
        </p>
      )}

      <AdvisoryBadges values={advisoryValues} />
    </article>
  );
}

export interface ScorecardGridProps {
  className?: string;
}

export function ScorecardGrid({ className }: ScorecardGridProps) {
  const result = useResultStore((s) => s.result);
  const aggregated = useResultStore((s) => s.aggregated);
  const activeDataset = useDatasetStore((s) => s.activeDataset);
  const appALabel = useDatasetStore((s) => s.appALabel);
  const appBLabel = useDatasetStore((s) => s.appBLabel);
  const slice = useFilterStore((s) => s.slice);
  const minSampleSize = useSLAStore((s) => s.config.minSampleSize);

  const [activePillar, setActivePillar] = React.useState<Pillar>(PILLARS[0]);

  // Index the comparison results and per-app aggregates for O(1) card lookup.
  const comparisonByKpi = React.useMemo(() => {
    const map = new Map<string, ComparisonResult>();
    for (const r of result?.results ?? []) map.set(r.kpiId, r);
    return map;
  }, [result]);

  const aggregateByKpiApp = React.useMemo(() => {
    const map = new Map<string, AggregatedKPIValue>();
    for (const v of aggregated?.overall ?? []) {
      map.set(`${v.kpiId}|${v.app}`, v);
    }
    return map;
  }, [aggregated]);

  const isRawMode = activeDataset?.ingestionMode === "Raw_Session";

  // Derive the per-day sparkline series once for the active slice. Memoized on
  // the dataset + slice so it recomputes only when the slice actually changes.
  const series = React.useMemo(() => {
    if (!activeDataset) return new Map<string, KpiSeries>();
    const sliced = applySlice(activeDataset.records, slice);
    return buildScorecardSeries(sliced, activeDataset.ingestionMode, KPI_REGISTRY);
  }, [activeDataset, slice]);

  const pillarKpis = React.useMemo(
    () => KPI_REGISTRY.filter((k) => k.pillar === activePillar),
    [activePillar],
  );

  const appLabelFor = (app: AppAssignment) =>
    app === "App_A" ? appALabel : appBLabel;

  return (
    <section
      aria-label="KPI Scorecards"
      className={cn("rounded-lg border border-border bg-card/40 p-4", className)}
    >
      <div className="mb-3">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">
          KPI Scorecards
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {appLabelFor("App_A")} vs {appLabelFor("App_B")} for the active slice,
          by pillar.
        </p>
      </div>

      {/* Pillar tabs (Req 11.1). */}
      <div
        role="tablist"
        aria-label="KPI pillars"
        className="mb-4 flex flex-wrap gap-1 border-b border-border"
      >
        {PILLARS.map((pillar) => {
          const selected = pillar === activePillar;
          return (
            <button
              key={pillar}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setActivePillar(pillar)}
              className={cn(
                "rounded-t-md border-b-2 px-3 py-1.5 text-xs font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                selected
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {pillar}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        aria-label={activePillar}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
      >
        {pillarKpis.map((kpi) => {
          const model: CardModel = {
            kpi,
            comparison: comparisonByKpi.get(kpi.id),
            appA: aggregateByKpiApp.get(`${kpi.id}|App_A`),
            appB: aggregateByKpiApp.get(`${kpi.id}|App_B`),
            seriesA: series.get(`${kpi.id}|App_A`),
            seriesB: series.get(`${kpi.id}|App_B`),
          };
          return (
            <Scorecard
              key={kpi.id}
              model={model}
              appALabel={appALabel}
              appBLabel={appBLabel}
              minSampleSize={minSampleSize}
              isRawMode={isRawMode}
            />
          );
        })}
      </div>
    </section>
  );
}
