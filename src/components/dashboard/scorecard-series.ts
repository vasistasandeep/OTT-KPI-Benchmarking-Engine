/**
 * Per-day KPI series derivation for the ScorecardGrid's 7-day sparklines
 * (task 17.1, Req 11.7, 11.8).
 *
 * The aggregation engine's `overall` result collapses the whole slice to one
 * value per (KPI, app); it does not carry a per-day breakdown. The sparkline
 * needs one point per UTC day, so this helper re-runs the *pure* engine once
 * per day bucket present in the already-sliced records and reads back each
 * KPI/app value. It reuses the exact same `aggregate` path the dashboard uses,
 * so a sparkline point equals the scorecard value would be for a single-day
 * slice — no parallel aggregation logic.
 *
 * All work here is pure and synchronous: given the same sliced records it
 * produces the same series, so the caller can safely memoize on the record set.
 * For a standard demo dataset (~500 records over 30 days) this is a handful of
 * small aggregations and completes well within the 2-second render budget
 * (Req 11.1).
 */

import { aggregate } from "@/engine/aggregation-engine";
import type { CanonicalKPIId } from "@/models/ids";
import type { AppAssignment, IngestionMode, KPIRecord } from "@/models/records";
import type { AggregatedKPIValue } from "@/models/results";
import type { Numeric } from "@/models/sentinels";
import { NO_DATA } from "@/models/sentinels";
import type { KPIDefinition } from "@/registry/kpi-types";

/** A single sparkline point: a UTC day and the KPI's value on that day. */
export interface SeriesPoint {
  /** UTC calendar day, e.g. "2025-03-14". */
  day: string;
  /** The KPI value for that day, or a sentinel (NO_DATA / NOT_AGGREGABLE). */
  value: Numeric;
}

/** A KPI's per-day series for one app, plus the partial-data flag. */
export interface KpiSeries {
  points: SeriesPoint[];
  /** True when fewer than 7 distinct days contributed (Req 11.8). */
  partial: boolean;
}

/** The composite key for a `(kpiId, app)` pair in the series map. */
function keyOf(kpiId: CanonicalKPIId, app: AppAssignment): string {
  return `${kpiId}|${app}`;
}

/** How many days a full sparkline shows (Req 11.7). */
export const SPARKLINE_DAYS = 7;

/**
 * Build a per-day series for every (KPI, app) from the already-sliced records.
 *
 * The series spans the last {@link SPARKLINE_DAYS} distinct UTC days present in
 * the slice (or fewer, flagged `partial`). Each day is aggregated independently
 * through the pure engine, so a day with no records for a KPI yields that KPI's
 * `NO_DATA` value for that point and a day whose value cannot be combined yields
 * `NOT_AGGREGABLE`.
 *
 * @param records the active slice's records (already filtered by `applySlice`).
 * @param mode    the active dataset's ingestion mode (drives the compute path).
 * @param kpis    the KPI definitions to build series for.
 * @returns a map keyed by `"{kpiId}|{app}"` to that KPI/app's {@link KpiSeries}.
 */
export function buildScorecardSeries(
  records: readonly KPIRecord[],
  mode: IngestionMode,
  kpis: readonly KPIDefinition[],
): Map<string, KpiSeries> {
  const result = new Map<string, KpiSeries>();

  // The distinct UTC days present in the slice, most-recent last, capped to the
  // last SPARKLINE_DAYS so the sparkline window matches the requirement.
  const allDays = [...new Set(records.map((r) => r.bucket.dayUtc))].sort();
  const days = allDays.slice(-SPARKLINE_DAYS);
  const partial = days.length < SPARKLINE_DAYS;

  // Partition records by day once so each daily aggregation sees only its day.
  const recordsByDay = new Map<string, KPIRecord[]>();
  for (const day of days) {
    recordsByDay.set(day, []);
  }
  for (const record of records) {
    recordsByDay.get(record.bucket.dayUtc)?.push(record);
  }

  // Seed an empty series for every (KPI, app) so a KPI with no data across all
  // days still produces an (empty) entry the card can render.
  const kpiList = [...kpis];
  for (const def of kpiList) {
    for (const app of ["App_A", "App_B"] as AppAssignment[]) {
      result.set(keyOf(def.id, app), { points: [], partial });
    }
  }

  for (const day of days) {
    const dayRecords = recordsByDay.get(day) ?? [];
    const agg = aggregate(dayRecords, mode, kpiList);
    const byKpiApp = indexOverall(agg.overall);

    for (const def of kpiList) {
      for (const app of ["App_A", "App_B"] as AppAssignment[]) {
        const found = byKpiApp.get(keyOf(def.id, app));
        // A KPI absent for a day (no contributing records) is NO_DATA for that
        // point; otherwise the point carries that day's aggregated value, which
        // may itself be a sentinel (NO_DATA / NOT_AGGREGABLE).
        const value: Numeric = found ? found.value : NO_DATA;
        result.get(keyOf(def.id, app))!.points.push({ day, value });
      }
    }
  }

  return result;
}

/** Index a slice's overall aggregates by `(kpiId, app)` for O(1) lookup. */
function indexOverall(values: readonly AggregatedKPIValue[]): Map<string, AggregatedKPIValue> {
  const map = new Map<string, AggregatedKPIValue>();
  for (const v of values) {
    map.set(keyOf(v.kpiId, v.app), v);
  }
  return map;
}
