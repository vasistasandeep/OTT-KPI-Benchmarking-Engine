/**
 * Unit tests for the assembled `AggregationEngine` (task 8.8).
 *
 * These exercise the wiring, not the individual formulas (each pure function
 * has its own dedicated suite). They confirm the fixed execution order produces
 * the expected end-to-end results:
 *
 * - raw-mode aggregate -> compare pipeline for a percentage KPI (Req 5.6);
 * - pre-aggregated weighted-average pipeline (Req 20);
 * - derived-KPI resolution from already-aggregated operands (Req 24.2);
 * - the unequal-record-count independent-aggregation path (Req 16.3);
 * - the aggregability guard firing across multiple pre-aggregated buckets;
 * - the sentinel and confidence gates in `compare` (Req 16.5, 25).
 */

import { describe, it, expect } from "vitest";
import { aggregate, compare, InThreadAggregationEngine } from "./aggregation-engine";
import { KPI_REGISTRY, KPI_BY_ID } from "@/registry/kpi-registry";
import { NO_DATA, NOT_AGGREGABLE } from "@/models/sentinels";
import type { KPIDefinition } from "@/registry/kpi-types";
import type {
  AppAssignment,
  IngestionMode,
  KPIRecord,
  RawSessionFields,
  TimeBucket,
} from "@/models/records";
import type { AggregatedKPIValue } from "@/models/results";
import type { SLAConfig } from "@/models/config";
import type { CanonicalKPIId } from "@/models/ids";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const DAY_1: TimeBucket = { hourUtc: "2025-03-14T09:00:00Z", dayUtc: "2025-03-14" };
const DAY_2: TimeBucket = { hourUtc: "2025-03-15T09:00:00Z", dayUtc: "2025-03-15" };

let seq = 0;
function nextId(): string {
  seq += 1;
  return `r${seq}`;
}

/** A raw-session record for one app. */
function rawRecord(
  app: AppAssignment,
  session: RawSessionFields,
  bucket: TimeBucket = DAY_1,
  dimensions: KPIRecord["dimensions"] = {} as KPIRecord["dimensions"],
): KPIRecord {
  return {
    id: nextId(),
    datasetId: "ds",
    app,
    timestampUtc: bucket.hourUtc,
    sourceUtcOffsetMinutes: null,
    bucket,
    origin: "file",
    dimensions,
    session,
  };
}

/** A pre-aggregated record for one app. */
function preAggRecord(
  app: AppAssignment,
  metrics: Partial<Record<CanonicalKPIId, number>>,
  opts: { bucket?: TimeBucket; volumeWeight?: number; dimensions?: KPIRecord["dimensions"] } = {},
): KPIRecord {
  return {
    id: nextId(),
    datasetId: "ds",
    app,
    timestampUtc: (opts.bucket ?? DAY_1).hourUtc,
    sourceUtcOffsetMinutes: null,
    bucket: opts.bucket ?? DAY_1,
    origin: "file",
    dimensions: opts.dimensions ?? ({} as KPIRecord["dimensions"]),
    metrics,
    volumeWeight: opts.volumeWeight,
  };
}

const SLA: SLAConfig = { varianceBand: 1.5, thresholds: {}, minSampleSize: 0 };

/** Read the aggregated value for a (KPI, app) from an overall result. */
function overallValue(
  overall: AggregatedKPIValue[],
  kpiId: CanonicalKPIId,
  app: AppAssignment,
): AggregatedKPIValue | undefined {
  return overall.find((v) => v.kpiId === kpiId && v.app === app);
}

/** Only the KPIs referenced by a test, to keep results focused and fast. */
function only(...ids: CanonicalKPIId[]): KPIDefinition[] {
  return ids.map((id) => KPI_BY_ID[id]);
}

// ---------------------------------------------------------------------------
// Raw-mode pipeline
// ---------------------------------------------------------------------------

describe("aggregate — raw-mode pipeline (Req 5.6)", () => {
  it("computes VSF rate per app from grouped raw sessions", () => {
    const records: KPIRecord[] = [
      rawRecord("App_A", { startFailure: 1, playbackAttempt: 1 }),
      rawRecord("App_A", { startFailure: 0, playbackAttempt: 1 }),
      rawRecord("App_A", { startFailure: 0, playbackAttempt: 1 }),
      rawRecord("App_A", { startFailure: 0, playbackAttempt: 1 }),
      rawRecord("App_B", { startFailure: 0, playbackAttempt: 1 }),
      rawRecord("App_B", { startFailure: 0, playbackAttempt: 1 }),
    ];

    const result = aggregate(records, "Raw_Session", only("vsf"));

    // App_A: 1/4 -> 25%. App_B: 0/2 -> 0%.
    expect(overallValue(result.overall, "vsf", "App_A")?.value).toBe(25);
    expect(overallValue(result.overall, "vsf", "App_B")?.value).toBe(0);
    expect(overallValue(result.overall, "vsf", "App_A")?.contributingRecords).toBe(4);
    expect(overallValue(result.overall, "vsf", "App_B")?.contributingRecords).toBe(2);
  });

  it("recomputes a percentile from the union of raw values (Req 23.7)", () => {
    const records: KPIRecord[] = [
      rawRecord("App_A", { vstMs: 1000 }),
      rawRecord("App_A", { vstMs: 2000 }),
      rawRecord("App_A", { vstMs: 3000 }),
    ];

    // vst_p50 draws from vstMs; median of [1000,2000,3000] = 2000.
    const result = aggregate(records, "Raw_Session", only("vst_p50"));
    expect(overallValue(result.overall, "vst_p50", "App_A")?.value).toBe(2000);
    // vst_p50 is aggregable in raw mode (recomputed, never merged).
    expect(overallValue(result.overall, "vst_p50", "App_A")?.aggregability).toBe("aggregable");
  });

  it("rejects sessions missing a required field and reports them (Req 5.7)", () => {
    const records: KPIRecord[] = [
      rawRecord("App_A", { startFailure: 1, playbackAttempt: 1 }),
      // negative value -> rejected; injected past the 0|1 literal type
      rawRecord("App_A", { startFailure: -1 as unknown as 0 | 1, playbackAttempt: 1 }),
    ];

    const result = aggregate(records, "Raw_Session", only("vsf"));
    const a = overallValue(result.overall, "vsf", "App_A");
    // Only the one valid session contributes: 1/1 -> 100%.
    expect(a?.value).toBe(100);
    expect(a?.contributingRecords).toBe(1);
    expect(a?.rejectedRecords).toHaveLength(1);
  });

  it("counts distinct users directly, deduping repeats (Req 23.1)", () => {
    const records: KPIRecord[] = [
      rawRecord("App_A", { userId: "u1" }),
      rawRecord("App_A", { userId: "u1" }), // duplicate user
      rawRecord("App_A", { userId: "u2" }),
    ];

    const result = aggregate(records, "Raw_Session", only("dau"));
    expect(overallValue(result.overall, "dau", "App_A")?.value).toBe(2);
  });

  it("reports NO_DATA for a KPI not derivable from the mapped session fields (Req 5.1)", () => {
    // Sessions carry only vstMs; VSF needs startFailure/playbackAttempt.
    const records: KPIRecord[] = [rawRecord("App_A", { vstMs: 1000 })];
    const result = aggregate(records, "Raw_Session", only("vsf"));
    expect(overallValue(result.overall, "vsf", "App_A")?.value).toBe(NO_DATA);
  });
});

// ---------------------------------------------------------------------------
// Pre-aggregated pipeline
// ---------------------------------------------------------------------------

describe("aggregate — pre-aggregated pipeline (Req 20)", () => {
  it("volume-weights a percentage KPI when weights are present", () => {
    const records: KPIRecord[] = [
      preAggRecord("App_A", { rebuffer_ratio: 10 }, { volumeWeight: 100 }),
      preAggRecord("App_A", { rebuffer_ratio: 20 }, { volumeWeight: 300 }),
    ];

    // Weighted: (10*100 + 20*300) / 400 = 7000/400 = 17.5
    const result = aggregate(records, "Pre_Aggregated", only("rebuffer_ratio"));
    const a = overallValue(result.overall, "rebuffer_ratio", "App_A");
    expect(a?.value).toBe(17.5);
    expect(a?.weighted).toBe(true);
  });

  it("falls back to the unweighted mean and flags it when a weight is missing (Req 20.4)", () => {
    const records: KPIRecord[] = [
      preAggRecord("App_A", { rebuffer_ratio: 10 }, { volumeWeight: 100 }),
      preAggRecord("App_A", { rebuffer_ratio: 20 }), // no weight
    ];

    const result = aggregate(records, "Pre_Aggregated", only("rebuffer_ratio"));
    const a = overallValue(result.overall, "rebuffer_ratio", "App_A");
    expect(a?.value).toBe(15); // (10 + 20) / 2
    expect(a?.weighted).toBe(false);
    expect(result.unweightedAdvisory).toBe(true);
  });

  it("sums an additive KPI", () => {
    const records: KPIRecord[] = [
      preAggRecord("App_A", { total_watch_time: 100 }),
      preAggRecord("App_A", { total_watch_time: 250 }),
    ];
    const result = aggregate(records, "Pre_Aggregated", only("total_watch_time"));
    expect(overallValue(result.overall, "total_watch_time", "App_A")?.value).toBe(350);
  });

  it("excludes a non-numeric pre-aggregated value and reports it (Req 4.3)", () => {
    const records: KPIRecord[] = [
      preAggRecord("App_A", { total_watch_time: 100 }),
      // inject a bad cell through the loosely-typed metrics map
      { ...preAggRecord("App_A", {}), metrics: { total_watch_time: "oops" as unknown as number } },
    ];
    const result = aggregate(records, "Pre_Aggregated", only("total_watch_time"));
    const a = overallValue(result.overall, "total_watch_time", "App_A");
    expect(a?.value).toBe(100); // only the clean cell contributes
    expect(a?.rejectedRecords).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Aggregability guard through the assembly
// ---------------------------------------------------------------------------

describe("aggregate — aggregability guard (Req 23.4)", () => {
  it("resolves a pre-aggregated percentile spanning two buckets to NOT_AGGREGABLE", () => {
    const records: KPIRecord[] = [
      preAggRecord("App_A", { vst_p95: 3000 }, { bucket: DAY_1 }),
      preAggRecord("App_A", { vst_p95: 3200 }, { bucket: DAY_2 }),
    ];

    const result = aggregate(records, "Pre_Aggregated", only("vst_p95"));
    const a = overallValue(result.overall, "vst_p95", "App_A");
    expect(a?.value).toBe(NOT_AGGREGABLE);
    expect(a?.aggregability).toBe("not_aggregable");
  });

  it("keeps a single-bucket pre-aggregated percentile aggregable", () => {
    const records: KPIRecord[] = [preAggRecord("App_A", { vst_p95: 3000 }, { bucket: DAY_1 })];
    const result = aggregate(records, "Pre_Aggregated", only("vst_p95"));
    const a = overallValue(result.overall, "vst_p95", "App_A");
    expect(a?.value).toBe(3000);
    expect(a?.aggregability).toBe("aggregable");
  });
});

// ---------------------------------------------------------------------------
// Derived KPI resolution through the assembly (Req 24.2)
// ---------------------------------------------------------------------------

describe("aggregate — derived KPI (Req 24.2)", () => {
  it("computes Stickiness from the aggregated DAU/MAU operands for the slice", () => {
    // Two days of raw sessions; DAU/MAU count distinct users over the slice.
    const records: KPIRecord[] = [
      rawRecord("App_A", { userId: "u1" }, DAY_1),
      rawRecord("App_A", { userId: "u2" }, DAY_1),
      rawRecord("App_A", { userId: "u1" }, DAY_2),
    ];
    // Over the whole slice DAU==MAU==2 distinct users, so Stickiness = 100.
    const result = aggregate(records, "Raw_Session", only("dau", "mau", "stickiness"));
    expect(overallValue(result.overall, "stickiness", "App_A")?.value).toBe(100);
  });

  it("inherits NO_DATA from a missing operand and stays NO_DATA", () => {
    // No userId mapped -> DAU/MAU are NO_DATA -> Stickiness inherits it.
    const records: KPIRecord[] = [rawRecord("App_A", { vstMs: 1000 })];
    const result = aggregate(records, "Raw_Session", only("dau", "mau", "stickiness"));
    expect(overallValue(result.overall, "stickiness", "App_A")?.value).toBe(NO_DATA);
  });

  it("takes the ratio-of-aggregates path, not the mean of per-group ratios", () => {
    // App_A: day 1 has users {u1,u2,u3} (all three distinct), day 2 has {u1}.
    // Over the slice DAU==MAU==3 distinct -> 100. A mean-of-ratios approach
    // would have combined per-day ratios differently; assembling from operand
    // aggregates gives the ratio of the slice totals.
    const records: KPIRecord[] = [
      rawRecord("App_A", { userId: "u1" }, DAY_1),
      rawRecord("App_A", { userId: "u2" }, DAY_1),
      rawRecord("App_A", { userId: "u3" }, DAY_1),
      rawRecord("App_A", { userId: "u1" }, DAY_2),
    ];
    const result = aggregate(records, "Raw_Session", only("dau", "mau", "stickiness"));
    expect(overallValue(result.overall, "stickiness", "App_A")?.value).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Unequal record counts: independent aggregation (Req 16.3)
// ---------------------------------------------------------------------------

describe("aggregate — unequal per-app counts aggregate independently (Req 16.3)", () => {
  it("computes each app's aggregate only from its own records", () => {
    // App_A has 5 sessions, App_B has 1. Neither leaks into the other.
    const records: KPIRecord[] = [
      rawRecord("App_A", { startFailure: 1, playbackAttempt: 1 }),
      rawRecord("App_A", { startFailure: 1, playbackAttempt: 1 }),
      rawRecord("App_A", { startFailure: 0, playbackAttempt: 1 }),
      rawRecord("App_A", { startFailure: 0, playbackAttempt: 1 }),
      rawRecord("App_A", { startFailure: 0, playbackAttempt: 1 }),
      rawRecord("App_B", { startFailure: 0, playbackAttempt: 1 }),
    ];

    const result = aggregate(records, "Raw_Session", only("vsf"));
    const a = overallValue(result.overall, "vsf", "App_A");
    const b = overallValue(result.overall, "vsf", "App_B");

    expect(a?.value).toBe(40); // 2/5
    expect(a?.contributingRecords).toBe(5);
    expect(b?.value).toBe(0); // 0/1
    expect(b?.contributingRecords).toBe(1);
  });

  it("compares against NO_DATA when a KPI exists for only one app", () => {
    const records: KPIRecord[] = [
      // Only App_A carries the fields for VSF.
      rawRecord("App_A", { startFailure: 1, playbackAttempt: 1 }),
    ];

    const agg = aggregate(records, "Raw_Session", only("vsf"));
    const cmp = compare(agg, SLA, only("vsf"));
    const vsf = cmp.results.find((r) => r.kpiId === "vsf");

    expect(vsf?.appAValue).toBe(100);
    expect(vsf?.appBValue).toBe(NO_DATA);
    expect(vsf?.rag).toBe("NoData");
    expect(vsf?.suppressionReason).toBe("no_data");
  });
});

// ---------------------------------------------------------------------------
// compare — gates and deltas (Req 11, 16.5, 25)
// ---------------------------------------------------------------------------

describe("compare — deltas and gates (Req 11, 16.5, 25)", () => {
  it("computes deltas and a directionality-aware RAG for a finite comparison", () => {
    const records: KPIRecord[] = [
      // rebuffer_ratio is lower_is_better; App_B worse than App_A.
      preAggRecord("App_A", { rebuffer_ratio: 10 }, { volumeWeight: 100 }),
      preAggRecord("App_B", { rebuffer_ratio: 20 }, { volumeWeight: 100 }),
    ];

    const agg = aggregate(records, "Pre_Aggregated", only("rebuffer_ratio"));
    const cmp = compare(agg, SLA, only("rebuffer_ratio"));
    const r = cmp.results.find((x) => x.kpiId === "rebuffer_ratio");

    expect(r?.absoluteDelta).toBe(10); // 20 - 10
    expect(r?.percentDelta).toBe(100); // +100%
    // Higher rebuffer ratio is a degradation -> Red.
    expect(r?.rag).toBe("Red");
  });

  it("suppresses to LowConfidence when an app is below minSampleSize (Req 25.4)", () => {
    const records: KPIRecord[] = [
      preAggRecord("App_A", { rebuffer_ratio: 10 }, { volumeWeight: 100 }),
      preAggRecord("App_B", { rebuffer_ratio: 20 }, { volumeWeight: 100 }),
    ];

    const agg = aggregate(records, "Pre_Aggregated", only("rebuffer_ratio"));
    // Each app contributes 1 record; a floor of 5 suppresses the verdict.
    const cmp = compare(agg, { ...SLA, minSampleSize: 5 }, only("rebuffer_ratio"));
    const r = cmp.results.find((x) => x.kpiId === "rebuffer_ratio");

    expect(r?.rag).toBe("LowConfidence");
    expect(r?.suppressionReason).toBe("below_min_sample");
    // Values and deltas are still reported.
    expect(r?.absoluteDelta).toBe(10);
  });

  it("percentDelta is N/A when App_A is 0 but absolute delta is still computed (Req 11.4)", () => {
    const records: KPIRecord[] = [
      preAggRecord("App_A", { total_watch_time: 0 }),
      preAggRecord("App_B", { total_watch_time: 50 }),
    ];
    const agg = aggregate(records, "Pre_Aggregated", only("total_watch_time"));
    const cmp = compare(agg, SLA, only("total_watch_time"));
    const r = cmp.results.find((x) => x.kpiId === "total_watch_time");

    expect(r?.absoluteDelta).toBe(50);
    expect(r?.percentDelta).toBe("N/A");
  });
});

// ---------------------------------------------------------------------------
// Class facade
// ---------------------------------------------------------------------------

describe("InThreadAggregationEngine", () => {
  it("exposes aggregate/compare through the AggregationEngine interface", () => {
    const engine = new InThreadAggregationEngine();
    const records: KPIRecord[] = [
      rawRecord("App_A", { startFailure: 1, playbackAttempt: 1 }),
      rawRecord("App_B", { startFailure: 0, playbackAttempt: 1 }),
    ];

    const agg = engine.aggregate(records, "Raw_Session" as IngestionMode, only("vsf"));
    const cmp = engine.compare(agg, SLA, only("vsf"));

    expect(cmp.results.find((r) => r.kpiId === "vsf")?.appAValue).toBe(100);
    expect(cmp.results.find((r) => r.kpiId === "vsf")?.appBValue).toBe(0);
  });

  it("aggregates the full registry without throwing", () => {
    const records: KPIRecord[] = [
      rawRecord("App_A", {
        startFailure: 0,
        playbackAttempt: 1,
        bufferingMs: 100,
        playTimeMs: 9900,
        vstMs: 1200,
        userId: "u1",
      }),
      rawRecord("App_B", {
        startFailure: 1,
        playbackAttempt: 1,
        bufferingMs: 500,
        playTimeMs: 9500,
        vstMs: 1800,
        userId: "u2",
      }),
    ];

    const engine = new InThreadAggregationEngine();
    const agg = engine.aggregate(records, "Raw_Session", [...KPI_REGISTRY]);
    const cmp = engine.compare(agg, SLA, [...KPI_REGISTRY]);
    // Every KPI in the registry gets exactly one comparison row.
    expect(cmp.results.length).toBe(KPI_REGISTRY.length);
  });
});
