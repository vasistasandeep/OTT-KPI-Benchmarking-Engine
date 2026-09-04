/**
 * Pure data derivation for the {@link PercentileDistribution} module (task 17.4,
 * Req 13.6, 23.4–23.8).
 *
 * The dashboard rule is strict: modules never compute or average percentiles
 * themselves (Req 23.6). This helper only *reads* the aggregated percentile
 * values the engine already produced for the active slice and shapes them for a
 * side-by-side App_A / App_B bar comparison. In particular it never falls back
 * to averaging percentiles across buckets or segments — a percentile that the
 * engine resolved to `NOT_AGGREGABLE` is surfaced as a not-aggregable cell with
 * a reason instead of a bar (Req 23.4, 23.8), and one the engine resolved to
 * `NO_DATA` is surfaced as a no-data cell.
 *
 * How the engine represents percentiles drives the mapping here:
 * - Video Start Time is two distinct KPIs, `vst_p50` and `vst_p95`. It carries
 *   no P90 KPI in the registry, so P90 for VST is reported as *unavailable*.
 * - Manifest Fetch Latency and TTFB are single percentile KPIs whose aggregated
 *   value is the KPI's first declared percentile rank (P50). Higher ranks the
 *   engine did not emit for the active slice are reported as *unavailable*
 *   rather than fabricated.
 *
 * Reporting a rank the engine did not produce as `unavailable` (not `no_data`)
 * keeps the two sentinels the design cares about — "widen the slice" vs "narrow
 * to the ingested granularity" — unambiguous for the ranks that *do* exist.
 */

import type { CanonicalKPIId } from "@/models/ids";
import type { AggregatedKPIValue, AggregatedResultSet } from "@/models/results";
import type { AppAssignment } from "@/models/records";
import { NO_DATA, NOT_AGGREGABLE } from "@/models/sentinels";

/** The three latency percentile ranks the module presents (Req 13.6). */
export const PERCENTILE_RANKS = [50, 90, 95] as const;

/** One of the presented percentile ranks. */
export type PercentileRank = (typeof PERCENTILE_RANKS)[number];

/** A latency metric shown in the distribution, with its canonical unit. */
export interface PercentileMetric {
  /** Stable key for React lists and test lookups. */
  key: "vst" | "manifest_fetch_latency" | "ttfb";
  /** Human-readable metric name. */
  name: string;
  /** Canonical unit every value is shown in (Req 22.2). */
  unit: string;
  /**
   * The KPI id supplying each rank, or `null` when the taxonomy carries no KPI
   * for that metric/rank (e.g. VST has no P90). A rank mapped to a KPI id may
   * still be *unavailable* at read time if the engine did not emit that rank.
   */
  ranks: Record<PercentileRank, CanonicalKPIId | null>;
}

/**
 * The three latency metrics of the percentile distribution (Req 13.6), each in
 * its canonical unit. VST is split across two KPI ids and has no P90 KPI;
 * Manifest Fetch Latency and TTFB are single KPIs whose aggregated value is
 * their P50, so P90/P95 are only available in raw mode when the engine emits
 * them (mapped to the same id, resolved per-rank at read time).
 */
export const PERCENTILE_METRICS: readonly PercentileMetric[] = [
  {
    key: "vst",
    name: "Video Start Time",
    unit: "s",
    ranks: { 50: "vst_p50", 90: null, 95: "vst_p95" },
  },
  {
    key: "manifest_fetch_latency",
    name: "Manifest Fetch Latency",
    unit: "ms",
    ranks: { 50: "manifest_fetch_latency", 90: null, 95: null },
  },
  {
    key: "ttfb",
    name: "Time To First Byte",
    unit: "ms",
    ranks: { 50: "ttfb", 90: null, 95: null },
  },
];

/** The resolved state of a single (metric, rank, app) percentile cell. */
export type PercentileCellState =
  | { kind: "value"; value: number }
  /** Records exist but merging them for this slice is invalid (Req 23.4, 23.8). */
  | { kind: "not_aggregable" }
  /** No contributing records for this slice (Req 23.8). */
  | { kind: "no_data" }
  /** The taxonomy/engine does not report this rank for this metric. */
  | { kind: "unavailable" };

/** One app's value at one percentile rank. */
export interface PercentileAppCell {
  app: AppAssignment;
  state: PercentileCellState;
}

/** One percentile rank across both apps for a metric. */
export interface PercentileRankRow {
  rank: PercentileRank;
  appA: PercentileAppCell;
  appB: PercentileAppCell;
}

/** All ranks for one metric, ready to render as grouped bars. */
export interface PercentileMetricSeries {
  metric: PercentileMetric;
  rows: PercentileRankRow[];
  /**
   * True when at least one rank across either app has a drawable numeric value.
   * When false the whole metric renders its empty/not-aggregable summary.
   */
  hasAnyValue: boolean;
}

/** The full derived dataset the module renders. */
export interface PercentileDistributionData {
  metrics: PercentileMetricSeries[];
  /** True when no metric has any drawable value (module-level no-data). */
  empty: boolean;
}

/**
 * Index the overall aggregated values by `(kpiId, app)` so a rank lookup is
 * O(1). Only the `overall` slice is used: the distribution compares the whole
 * active slice, not per-segment cells (that is the heatmap's job).
 */
function indexOverall(
  aggregated: AggregatedResultSet,
): Map<string, AggregatedKPIValue> {
  const map = new Map<string, AggregatedKPIValue>();
  for (const value of aggregated.overall) {
    map.set(`${value.kpiId}|${value.app}`, value);
  }
  return map;
}

/**
 * Resolve one (kpiId, app) aggregated value into a cell state. A missing entry
 * or a `NO_DATA` sentinel is a no-data cell; `NOT_AGGREGABLE` is a
 * not-aggregable cell (Req 23.4, 23.8); a finite number is a drawable value.
 */
function resolveCell(
  entry: AggregatedKPIValue | undefined,
): PercentileCellState {
  if (!entry || entry.value === NO_DATA) {
    return { kind: "no_data" };
  }
  if (entry.value === NOT_AGGREGABLE) {
    return { kind: "not_aggregable" };
  }
  if (typeof entry.value === "number" && Number.isFinite(entry.value)) {
    return { kind: "value", value: entry.value };
  }
  return { kind: "no_data" };
}

/**
 * Derive the percentile-distribution dataset from the engine's aggregated
 * result set. Reads only already-computed percentile values (Req 23.6); never
 * averages across buckets or segments. When `aggregated` is `null` (before the
 * first recompute) every cell is no-data and the module is empty.
 */
export function derivePercentileDistribution(
  aggregated: AggregatedResultSet | null,
): PercentileDistributionData {
  const index = aggregated ? indexOverall(aggregated) : null;

  const metrics: PercentileMetricSeries[] = PERCENTILE_METRICS.map((metric) => {
    let hasAnyValue = false;

    const rows: PercentileRankRow[] = PERCENTILE_RANKS.map((rank) => {
      const kpiId = metric.ranks[rank];

      const cellFor = (app: AppAssignment): PercentileAppCell => {
        if (kpiId === null) {
          return { app, state: { kind: "unavailable" } };
        }
        const state = index
          ? resolveCell(index.get(`${kpiId}|${app}`))
          : ({ kind: "no_data" } as PercentileCellState);
        if (state.kind === "value") {
          hasAnyValue = true;
        }
        return { app, state };
      };

      return { rank, appA: cellFor("App_A"), appB: cellFor("App_B") };
    });

    return { metric, rows, hasAnyValue };
  });

  return { metrics, empty: metrics.every((m) => !m.hasAnyValue) };
}

/**
 * Whether any rank of any metric resolved to `not_aggregable`. Drives the
 * module-level not-aggregable advisory so the analyst is told to narrow the
 * slice to the ingested granularity (Req 23.5, 23.8).
 */
export function hasNotAggregableCell(data: PercentileDistributionData): boolean {
  return data.metrics.some((m) =>
    m.rows.some(
      (r) =>
        r.appA.state.kind === "not_aggregable" ||
        r.appB.state.kind === "not_aggregable",
    ),
  );
}
