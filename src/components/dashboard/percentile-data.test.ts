import { describe, expect, it } from "vitest";

import type { CanonicalKPIId } from "@/models/ids";
import type { AggregatedKPIValue, AggregatedResultSet } from "@/models/results";
import type { AppAssignment } from "@/models/records";
import type { Numeric } from "@/models/sentinels";
import { NO_DATA, NOT_AGGREGABLE } from "@/models/sentinels";

import {
  derivePercentileDistribution,
  hasNotAggregableCell,
} from "./percentile-data";

/** Build one aggregated value with only the fields the helper reads. */
function agg(
  kpiId: CanonicalKPIId,
  app: AppAssignment,
  value: Numeric,
): AggregatedKPIValue {
  return {
    kpiId,
    app,
    value,
    unit: kpiId === "vst_p50" || kpiId === "vst_p95" ? "s" : "ms",
    aggregability: value === NOT_AGGREGABLE ? "not_aggregable" : "aggregable",
    weighted: true,
    contributingRecords: 100,
    rejectedRecords: [],
    advisories: [],
  };
}

/** Wrap a flat list of overall values into an AggregatedResultSet. */
function resultSet(overall: AggregatedKPIValue[]): AggregatedResultSet {
  return { bySegment: new Map(), overall, unweightedAdvisory: false };
}

/** Find a metric series by key. */
function metric(
  data: ReturnType<typeof derivePercentileDistribution>,
  key: "vst" | "manifest_fetch_latency" | "ttfb",
) {
  const m = data.metrics.find((x) => x.metric.key === key);
  if (!m) throw new Error(`missing metric ${key}`);
  return m;
}

/** Find a rank row within a metric series. */
function rank(
  series: ReturnType<typeof metric>,
  r: 50 | 90 | 95,
) {
  const row = series.rows.find((x) => x.rank === r);
  if (!row) throw new Error(`missing rank P${r}`);
  return row;
}

describe("derivePercentileDistribution", () => {
  it("reads the engine's aggregated VST P50/P95 values for both apps (Req 13.6, 23.6)", () => {
    const data = derivePercentileDistribution(
      resultSet([
        agg("vst_p50", "App_A", 1.2),
        agg("vst_p50", "App_B", 1.5),
        agg("vst_p95", "App_A", 3.4),
        agg("vst_p95", "App_B", 4.1),
      ]),
    );

    const vst = metric(data, "vst");
    expect(rank(vst, 50).appA.state).toEqual({ kind: "value", value: 1.2 });
    expect(rank(vst, 50).appB.state).toEqual({ kind: "value", value: 1.5 });
    expect(rank(vst, 95).appA.state).toEqual({ kind: "value", value: 3.4 });
    expect(rank(vst, 95).appB.state).toEqual({ kind: "value", value: 4.1 });
    expect(vst.hasAnyValue).toBe(true);
    expect(vst.metric.unit).toBe("s");
  });

  it("reports VST P90 as unavailable because the taxonomy carries no VST P90 KPI", () => {
    const data = derivePercentileDistribution(
      resultSet([agg("vst_p50", "App_A", 1.2), agg("vst_p50", "App_B", 1.5)]),
    );

    const vst = metric(data, "vst");
    expect(rank(vst, 90).appA.state).toEqual({ kind: "unavailable" });
    expect(rank(vst, 90).appB.state).toEqual({ kind: "unavailable" });
  });

  it("renders a raw-mode recomputed Manifest/TTFB P50 value (Req 23.7)", () => {
    const data = derivePercentileDistribution(
      resultSet([
        agg("manifest_fetch_latency", "App_A", 42),
        agg("manifest_fetch_latency", "App_B", 55),
        agg("ttfb", "App_A", 120),
        agg("ttfb", "App_B", 138),
      ]),
    );

    expect(rank(metric(data, "manifest_fetch_latency"), 50).appA.state).toEqual({
      kind: "value",
      value: 42,
    });
    expect(rank(metric(data, "ttfb"), 50).appB.state).toEqual({
      kind: "value",
      value: 138,
    });
    expect(metric(data, "manifest_fetch_latency").metric.unit).toBe("ms");
  });

  it("surfaces NOT_AGGREGABLE as a not-aggregable cell, never a bar (Req 23.4, 23.8)", () => {
    const data = derivePercentileDistribution(
      resultSet([
        agg("manifest_fetch_latency", "App_A", NOT_AGGREGABLE),
        agg("manifest_fetch_latency", "App_B", NOT_AGGREGABLE),
      ]),
    );

    const row = rank(metric(data, "manifest_fetch_latency"), 50);
    expect(row.appA.state).toEqual({ kind: "not_aggregable" });
    expect(row.appB.state).toEqual({ kind: "not_aggregable" });
    expect(hasNotAggregableCell(data)).toBe(true);
    // A not-aggregable cell is not a drawable value.
    expect(metric(data, "manifest_fetch_latency").hasAnyValue).toBe(false);
  });

  it("keeps the ingested-granularity value drawable when the engine did not resolve NOT_AGGREGABLE (Req 23.5)", () => {
    // Pre-aggregated slice matching ingested granularity: engine keeps the value.
    const data = derivePercentileDistribution(
      resultSet([agg("ttfb", "App_A", 99), agg("ttfb", "App_B", 110)]),
    );

    const row = rank(metric(data, "ttfb"), 50);
    expect(row.appA.state).toEqual({ kind: "value", value: 99 });
    expect(row.appB.state).toEqual({ kind: "value", value: 110 });
    expect(hasNotAggregableCell(data)).toBe(false);
  });

  it("surfaces NO_DATA and a missing entry as a no-data cell (Req 23.8)", () => {
    const data = derivePercentileDistribution(
      resultSet([
        agg("vst_p50", "App_A", NO_DATA),
        // App_B vst_p50 entry omitted entirely.
      ]),
    );

    const row = rank(metric(data, "vst"), 50);
    expect(row.appA.state).toEqual({ kind: "no_data" });
    expect(row.appB.state).toEqual({ kind: "no_data" });
  });

  it("treats a null aggregated set (pre-first-recompute) as empty", () => {
    const data = derivePercentileDistribution(null);
    expect(data.empty).toBe(true);
    expect(hasNotAggregableCell(data)).toBe(false);
    for (const m of data.metrics) {
      expect(m.hasAnyValue).toBe(false);
    }
  });

  it("does not average across ranks or apps — each cell is read independently", () => {
    // Only App_A has a value; App_B is no-data. The helper must not synthesize
    // App_B from App_A (no averaging / fallback, Req 23.6).
    const data = derivePercentileDistribution(
      resultSet([agg("vst_p95", "App_A", 3.0)]),
    );
    const row = rank(metric(data, "vst"), 95);
    expect(row.appA.state).toEqual({ kind: "value", value: 3.0 });
    expect(row.appB.state).toEqual({ kind: "no_data" });
  });
});
