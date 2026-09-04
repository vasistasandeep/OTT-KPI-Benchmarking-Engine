/**
 * Property 17 — wide/long-equivalence (task 11.2).
 *
 * Validates the already-implemented record builder (`buildRecords`) plus the
 * aggregation engine (`aggregate`): a single set of logical observations,
 * rendered once as a *wide* source (app-qualified columns on one row) and once
 * as the equivalent *long* source (an app column with one row per app), must
 * ingest to the same per-app aggregates for every KPI and every slice — and no
 * App_A column value may ever leak into an App_B aggregate or vice versa.
 *
 * This suite does NOT import `src/test/arbitraries.ts`; it defines its own local
 * `arbLayoutPair` arbitrary. All numeric arbitraries are constrained to
 * well-behaved finite bounded values (no NaN/Infinity, no subnormals, no
 * denormalized magnitudes) so fast-check never explores pathological floats
 * that would slow the property or make floating-point aggregates diverge
 * between the two structurally identical builds.
 *
 * Header names for the mapped KPI columns are chosen to carry NO recognizable
 * unit token, so `resolveUnit` falls back to the canonical unit at factor 1 and
 * every ingested value is persisted unchanged — the wide and long builds then
 * carry byte-identical metric values and any aggregate difference would be a
 * genuine layout bug, not a unit-conversion artifact.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { buildRecords, type RecordBuildContext } from "./record-builder";
import type { ParsedRow } from "./file-parser";
import { aggregate } from "@/engine/aggregation-engine";
import { KPI_BY_ID } from "@/registry/kpi-registry";
import type { KPIDefinition } from "@/registry/kpi-types";
import type { ColumnMapping } from "@/models/config";
import type { AggregatedKPIValue } from "@/models/results";
import type { AppAssignment, IngestionMode } from "@/models";

// ---------------------------------------------------------------------------
// The KPIs under test.
//
// - `total_watch_time`  aggregation: "sum"          — exercises the additive path
// - `rebuffer_ratio`    aggregation: "weighted_avg" — exercises the volume-weighted path
//
// Both are pre-aggregated here. Their source headers deliberately contain no
// unit token, so unit resolution is the identity (factor 1) and the persisted
// value equals the source value.
// ---------------------------------------------------------------------------

const KPI_IDS = ["total_watch_time", "rebuffer_ratio"] as const;
type MetricKpiId = (typeof KPI_IDS)[number];

const KPIS: KPIDefinition[] = KPI_IDS.map((id) => KPI_BY_ID[id]);

/** Unit-token-free headers per app for the wide layout, and shared for long. */
const WIDE_HEADER: Record<MetricKpiId, Record<AppAssignment, string>> = {
  total_watch_time: { App_A: "wtcol_a", App_B: "wtcol_b" },
  rebuffer_ratio: { App_A: "rbcol_a", App_B: "rbcol_b" },
};
const LONG_HEADER: Record<MetricKpiId, string> = {
  total_watch_time: "wtcol",
  rebuffer_ratio: "rbcol",
};

const TS_HEADER = "ts";
const REGION_HEADER = "region";
const VOL_HEADER = "vol";
const APP_HEADER = "appname";

const CTX: RecordBuildContext = { datasetId: "ds", ingestionMode: "Pre_Aggregated" };
const MODE: IngestionMode = "Pre_Aggregated";

// ---------------------------------------------------------------------------
// Arbitraries — all finite, bounded, and "well-behaved" (no subnormals).
// ---------------------------------------------------------------------------

/**
 * A finite, bounded metric value with at most 3 decimal places. Constraining to
 * a small integer-scaled grid keeps values well away from subnormal magnitudes
 * and makes the identical wide/long sums associate to the same float.
 */
const metricValueArb: fc.Arbitrary<number> = fc
  .integer({ min: 0, max: 1_000_000 })
  .map((n) => n / 1000);

/** A positive, bounded volume weight (weighted_avg denominator stays > 0). */
const weightArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 100_000 });

/** A small pool of valid, offset-free UTC timestamps so records collide by bucket. */
const timestampArb: fc.Arbitrary<string> = fc.constantFrom(
  "2025-03-14T09:00:00Z",
  "2025-03-14T10:00:00Z",
  "2025-03-15T09:00:00Z",
);

/** A small pool of dimension values so segments genuinely collide. */
const regionArb: fc.Arbitrary<string> = fc.constantFrom("US", "IN", "UK");

/** Whether a given app carries a value on a logical observation. */
type AppCell = { present: boolean; wt: number; rb: number };

const appCellArb: fc.Arbitrary<AppCell> = fc.record({
  present: fc.boolean(),
  wt: metricValueArb,
  rb: metricValueArb,
});

/**
 * A single logical observation shared by both layouts: a timestamp, a region,
 * a shared volume weight, and per-app cells. A cell that is not `present`
 * contributes no value for that app in either layout (the wide-row-blank and
 * the absent-long-row cases coincide, per Req 21.8).
 */
interface Observation {
  ts: string;
  region: string;
  vol: number;
  appA: AppCell;
  appB: AppCell;
}

const observationArb: fc.Arbitrary<Observation> = fc
  .record({
    ts: timestampArb,
    region: regionArb,
    vol: weightArb,
    appA: appCellArb,
    appB: appCellArb,
  })
  // Drop observations where neither app has a value — they would produce no
  // record in either layout and only add noise.
  .filter((o) => o.appA.present || o.appB.present);

/** A set of logical observations, expressible in both layouts. */
const observationsArb: fc.Arbitrary<Observation[]> = fc.array(observationArb, {
  minLength: 1,
  maxLength: 30,
});

// ---------------------------------------------------------------------------
// Layout rendering: one observation set -> a wide build and a long build.
// ---------------------------------------------------------------------------

function num(value: number): string {
  return String(value);
}

/** The wide mapping: app-qualified KPI columns, one row per observation. */
function wideMapping(): ColumnMapping {
  const assignments: ColumnMapping["assignments"] = {
    [TS_HEADER]: { kind: "timestamp" },
    [REGION_HEADER]: { kind: "dimension", dimensionId: "geography" },
    [VOL_HEADER]: { kind: "volumeWeight" },
    [WIDE_HEADER.total_watch_time.App_A]: { kind: "kpi", kpiId: "total_watch_time", app: "App_A" },
    [WIDE_HEADER.total_watch_time.App_B]: { kind: "kpi", kpiId: "total_watch_time", app: "App_B" },
    [WIDE_HEADER.rebuffer_ratio.App_A]: { kind: "kpi", kpiId: "rebuffer_ratio", app: "App_A" },
    [WIDE_HEADER.rebuffer_ratio.App_B]: { kind: "kpi", kpiId: "rebuffer_ratio", app: "App_B" },
  };
  return {
    headerSetHash: "wide",
    headers: Object.keys(assignments),
    assignments,
    units: {},
    layout: "wide",
    ingestionMode: MODE,
  };
}

/** The long mapping: an app column plus shared KPI columns, one row per app. */
function longMapping(): ColumnMapping {
  const assignments: ColumnMapping["assignments"] = {
    [TS_HEADER]: { kind: "timestamp" },
    [REGION_HEADER]: { kind: "dimension", dimensionId: "geography" },
    [VOL_HEADER]: { kind: "volumeWeight" },
    [APP_HEADER]: { kind: "app" },
    [LONG_HEADER.total_watch_time]: { kind: "kpi", kpiId: "total_watch_time" },
    [LONG_HEADER.rebuffer_ratio]: { kind: "kpi", kpiId: "rebuffer_ratio" },
  };
  return {
    headerSetHash: "long",
    headers: Object.keys(assignments),
    assignments,
    units: {},
    layout: "long",
    ingestionMode: MODE,
  };
}

/** Render observations as wide rows: one row per observation, both apps' columns. */
function toWideRows(observations: readonly Observation[]): ParsedRow[] {
  return observations.map((o) => {
    const row: ParsedRow = {
      [TS_HEADER]: o.ts,
      [REGION_HEADER]: o.region,
      [VOL_HEADER]: num(o.vol),
      [WIDE_HEADER.total_watch_time.App_A]: o.appA.present ? num(o.appA.wt) : "",
      [WIDE_HEADER.rebuffer_ratio.App_A]: o.appA.present ? num(o.appA.rb) : "",
      [WIDE_HEADER.total_watch_time.App_B]: o.appB.present ? num(o.appB.wt) : "",
      [WIDE_HEADER.rebuffer_ratio.App_B]: o.appB.present ? num(o.appB.rb) : "",
    };
    return row;
  });
}

/** Render observations as long rows: one row per present app on each observation. */
function toLongRows(observations: readonly Observation[]): ParsedRow[] {
  const rows: ParsedRow[] = [];
  for (const o of observations) {
    if (o.appA.present) {
      rows.push({
        [TS_HEADER]: o.ts,
        [REGION_HEADER]: o.region,
        [VOL_HEADER]: num(o.vol),
        [APP_HEADER]: "App_A",
        [LONG_HEADER.total_watch_time]: num(o.appA.wt),
        [LONG_HEADER.rebuffer_ratio]: num(o.appA.rb),
      });
    }
    if (o.appB.present) {
      rows.push({
        [TS_HEADER]: o.ts,
        [REGION_HEADER]: o.region,
        [VOL_HEADER]: num(o.vol),
        [APP_HEADER]: "App_B",
        [LONG_HEADER.total_watch_time]: num(o.appB.wt),
        [LONG_HEADER.rebuffer_ratio]: num(o.appB.rb),
      });
    }
  }
  return rows;
}

/**
 * `arbLayoutPair` — a set of logical observations together with its two
 * equivalent renderings (wide and long) and their mappings, ready to feed
 * `buildRecords`.
 */
const arbLayoutPair = observationsArb.map((observations) => ({
  observations,
  wide: { rows: toWideRows(observations), mapping: wideMapping() },
  long: { rows: toLongRows(observations), mapping: longMapping() },
}));

// ---------------------------------------------------------------------------
// Comparison helpers.
// ---------------------------------------------------------------------------

/** Index a slice's aggregated values by `(kpiId, app)` for O(1) pairing. */
function indexByKpiApp(values: readonly AggregatedKPIValue[]): Map<string, AggregatedKPIValue> {
  const map = new Map<string, AggregatedKPIValue>();
  for (const v of values) {
    map.set(`${v.kpiId}|${v.app}`, v);
  }
  return map;
}

/** The comparable core of an aggregated value — value + aggregability + weighting. */
function comparable(v: AggregatedKPIValue) {
  return { value: v.value, aggregability: v.aggregability, weighted: v.weighted };
}

/** Assert two slices' per-app aggregates match for every KPI and app present. */
function expectSlicesEqual(
  wide: readonly AggregatedKPIValue[],
  long: readonly AggregatedKPIValue[],
): void {
  const wideIdx = indexByKpiApp(wide);
  const longIdx = indexByKpiApp(long);

  // Same set of (KPI, app) keys.
  expect([...longIdx.keys()].sort()).toEqual([...wideIdx.keys()].sort());

  for (const [key, wideVal] of wideIdx) {
    const longVal = longIdx.get(key)!;
    expect(comparable(longVal)).toEqual(comparable(wideVal));
  }
}

// ---------------------------------------------------------------------------
// The property.
// ---------------------------------------------------------------------------

// Feature: ott-kpi-benchmarking-engine, Property 17: For any set of logical observations expressible in both layouts, ingesting the wide representation (app-qualified columns on one row) and ingesting the equivalent long representation (an app column with one row per app) produce identical per-app aggregates for every KPI and every slice; and every app-qualified column contributes only to its own app's aggregate, so no App_A column value ever appears in an App_B aggregate or vice versa.
describe("record-builder + aggregate — Property 17: wide/long equivalence", () => {
  it("wide and long renderings of the same observations produce identical per-app aggregates for every KPI and slice", () => {
    fc.assert(
      fc.property(arbLayoutPair, ({ wide, long }) => {
        const wideBuild = buildRecords(wide.rows, wide.mapping, CTX);
        const longBuild = buildRecords(long.rows, long.mapping, CTX);

        // No structurally-invalid rows in either build (timestamps are valid,
        // app is always resolvable), so nothing is silently dropped.
        expect(wideBuild.rejected).toEqual([]);
        expect(longBuild.rejected).toEqual([]);

        const wideAgg = aggregate(wideBuild.records, MODE, KPIS);
        const longAgg = aggregate(longBuild.records, MODE, KPIS);

        // --- Overall slice: identical per-app aggregates for every KPI. ---
        expectSlicesEqual(wideAgg.overall, longAgg.overall);

        // --- Every per-segment slice matches, keyed identically. ---
        expect([...longAgg.bySegment.keys()].sort()).toEqual(
          [...wideAgg.bySegment.keys()].sort(),
        );
        for (const [segmentKey, wideValues] of wideAgg.bySegment) {
          const longValues = longAgg.bySegment.get(segmentKey)!;
          expectSlicesEqual(wideValues, longValues);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("no app-qualified column value crosses into the other app's aggregate", () => {
    fc.assert(
      fc.property(arbLayoutPair, ({ observations, wide }) => {
        const build = buildRecords(wide.rows, wide.mapping, CTX);

        // Recompute each app's expected total watch time (a pure sum) directly
        // from the observations, using ONLY that app's own cells. If any App_A
        // column value leaked into App_B (or vice versa), these independent
        // sums would disagree with the engine's per-app aggregate.
        const expectedSum: Record<AppAssignment, number> = { App_A: 0, App_B: 0 };
        const anyPresent: Record<AppAssignment, boolean> = { App_A: false, App_B: false };
        for (const o of observations) {
          if (o.appA.present) {
            expectedSum.App_A += o.appA.wt;
            anyPresent.App_A = true;
          }
          if (o.appB.present) {
            expectedSum.App_B += o.appB.wt;
            anyPresent.App_B = true;
          }
        }

        const agg = aggregate(build.records, MODE, KPIS);
        const idx = indexByKpiApp(agg.overall);

        for (const app of ["App_A", "App_B"] as const) {
          const value = idx.get(`total_watch_time|${app}`)?.value;
          if (anyPresent[app]) {
            // sum path: exact within floating-point tolerance for our bounded grid.
            expect(typeof value).toBe("number");
            expect(value as number).toBeCloseTo(expectedSum[app], 6);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
