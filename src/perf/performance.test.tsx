import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";

import { aggregate, compare } from "@/engine/aggregation-engine";
import { VirtualizedTable } from "@/components/table/VirtualizedTable";
import { ScorecardGrid } from "@/components/dashboard/ScorecardGrid";
import { KPI_REGISTRY, KPI_BY_ID, ALL_KPI_IDS } from "@/registry/kpi-registry";
import { bucketTimestamp } from "@/engine/bucket";
import { DEFAULT_SLA_CONFIG } from "@/repository";

import type {
  AppAssignment,
  CanonicalKPIId,
  Dataset,
  DimensionId,
  KPIRecord,
} from "@/models";
import type {
  AggregatedKPIValue,
  AggregatedResultSet,
  ComparisonResult,
  ComparisonResultSet,
  FilterSlice,
} from "@/models/results";
import type { SLAConfig } from "@/models/config";
import {
  DEFAULT_APP_A_LABEL,
  DEFAULT_APP_B_LABEL,
  defaultFilterSlice,
  useDatasetStore,
  useFilterStore,
  useResultStore,
  useSLAStore,
} from "@/stores";

/**
 * Performance validation suite (task 21.2, Req 11.1, 15.3, 17.1).
 *
 * These three checks pin the design's performance envelope:
 *  - **Recompute over 10,000 aggregated rows within 1 s (Req 17.1)** — build a
 *    ~10,000-record pre-aggregated dataset and time the engine's
 *    `aggregate()` + `compare()` (the whole recompute numeric path) under
 *    1000 ms.
 *  - **Scorecards render within 2 s of slice selection (Req 11.1)** — time a
 *    full `ScorecardGrid` mount against a realistic result set under 2000 ms.
 *  - **Tables virtualize at 10,000+ rows (Req 15.3)** — confirm the table
 *    materializes only a small window for 10,000+ rows rather than every row.
 *
 * ## Environment caveat
 * Wall-clock timing under jsdom/Vitest is *coarse and machine-dependent*: there
 * is no browser layout, the numbers include V8 warm-up, and CI hardware varies.
 * The thresholds below are therefore deliberately generous relative to the
 * product SLA — they are regression tripwires for an order-of-magnitude
 * slowdown (e.g. an accidental O(n²) pass), not precise benchmarks. The
 * virtualization check asserts the *structural* windowing contract, which is
 * deterministic, rather than a render time.
 */

// ---------------------------------------------------------------------------
// Recompute over 10,000 aggregated rows (Req 17.1)
// ---------------------------------------------------------------------------

/** The pre-aggregated KPI ids we stamp on every synthetic record's metrics. */
const METRIC_KPIS: CanonicalKPIId[] = ALL_KPI_IDS.filter(
  (id) => KPI_BY_ID[id].derived === undefined,
);

/**
 * Build `count` pre-aggregated records spread across many days, dimension
 * segments, and both apps, each carrying a full `metrics` map. Deterministic so
 * the timing run is stable across executions.
 */
function buildAggregatedRecords(count: number): KPIRecord[] {
  const platforms = ["Android", "Android TV", "Desktop Web", "iOS"];
  const streamTypes = ["Live Sports/Events", "VOD Movies"];
  const apps: AppAssignment[] = ["App_A", "App_B"];
  const records: KPIRecord[] = [];

  for (let i = 0; i < count; i += 1) {
    const day = 1 + (i % 28); // spread across a month of UTC days
    const dd = day < 10 ? `0${day}` : `${day}`;
    const timestampUtc = `2024-06-${dd}T00:00:00Z`;
    const app = apps[i % apps.length];
    const platform = platforms[i % platforms.length];
    const streamType = streamTypes[i % streamTypes.length];

    const metrics: Partial<Record<CanonicalKPIId, number>> = {};
    for (const kpiId of METRIC_KPIS) {
      // A plausible-ish value inside each KPI's valid range; exact value is
      // irrelevant to timing, only that every metric slot is populated.
      const [lo, hi] = KPI_BY_ID[kpiId].validRange ?? [0, 1000];
      metrics[kpiId] = lo + ((i % 100) / 100) * (hi - lo);
    }

    records.push({
      id: `perf:${i}`,
      datasetId: "perf",
      app,
      timestampUtc,
      sourceUtcOffsetMinutes: 0,
      bucket: bucketTimestamp(timestampUtc),
      origin: "mock",
      dimensions: { platform, streamType } as Record<DimensionId, string>,
      metrics,
      volumeWeight: 100 + (i % 50),
      ingestedGranularity: "day",
    });
  }

  return records;
}

describe("Recompute performance over 10,000 aggregated rows (Req 17.1)", () => {
  it("aggregates and compares 10,000 pre-aggregated records under 1 second", () => {
    const records = buildAggregatedRecords(10_000);
    const kpis = [...KPI_REGISTRY];
    const sla: SLAConfig = { ...DEFAULT_SLA_CONFIG, thresholds: {} };

    const start = performance.now();
    const aggregated = aggregate(records, "Pre_Aggregated", kpis);
    const comparison = compare(aggregated, sla, kpis);
    const elapsed = performance.now() - start;

    // Sanity: the run actually produced results for the whole KPI set.
    expect(aggregated.overall.length).toBeGreaterThan(0);
    expect(comparison.results.length).toBeGreaterThan(0);

    // Generous tripwire: the product SLA is 1 s in a real browser; jsdom timing
    // is coarse, so this guards against an order-of-magnitude regression.
    expect(elapsed).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Scorecards render within 2 s of slice selection (Req 11.1)
// ---------------------------------------------------------------------------

/** A slice wide enough to include the fixture records' dates. */
function wideSlice(): FilterSlice {
  return {
    ...defaultFilterSlice(),
    dateRange: { preset: "custom", from: "2024-01-01", to: "2024-12-31" },
  };
}

/** One aggregated value carrying the fields the scorecard reads. */
function aggValue(
  kpiId: CanonicalKPIId,
  app: AppAssignment,
  value: number,
): AggregatedKPIValue {
  return {
    kpiId,
    app,
    value,
    unit: KPI_BY_ID[kpiId].canonicalUnit,
    aggregability: "aggregable",
    weighted: true,
    contributingRecords: 1000,
    rejectedRecords: [],
    advisories: [],
  };
}

/** One comparison result for a KPI. */
function comparison(kpiId: CanonicalKPIId): ComparisonResult {
  return {
    kpiId,
    appAValue: 10,
    appBValue: 12,
    absoluteDelta: 2,
    percentDelta: 20,
    rag: "Green",
    appAContributingRecords: 1000,
    appBContributingRecords: 1000,
  };
}

/** A minimal active dataset carrying the given records. */
function dataset(records: KPIRecord[]): Dataset {
  return {
    id: "perf-ds",
    name: "Perf",
    createdAt: "2024-01-01T00:00:00Z",
    appALabel: DEFAULT_APP_A_LABEL,
    appBLabel: DEFAULT_APP_B_LABEL,
    recordCount: records.length,
    sourceType: "Mock",
    ingestionMode: "Pre_Aggregated",
    records,
  };
}

/** Publish a full-registry result set into the stores for the scorecards. */
function seedScorecards(records: KPIRecord[]) {
  const slice = wideSlice();
  const overall: AggregatedKPIValue[] = [];
  const results: ComparisonResult[] = [];
  for (const kpi of KPI_REGISTRY) {
    overall.push(aggValue(kpi.id, "App_A", 10));
    overall.push(aggValue(kpi.id, "App_B", 12));
    results.push(comparison(kpi.id));
  }

  const aggregated: AggregatedResultSet = {
    bySegment: new Map(),
    overall,
    unweightedAdvisory: false,
  };
  const result: ComparisonResultSet = { results, slice };

  useDatasetStore.getState().setActiveDataset(dataset(records));
  useFilterStore.setState({ slice, revision: 1 });
  useResultStore.setState({ result, aggregated, noData: false, status: "ready" });
}

beforeEach(() => {
  useResultStore.setState({
    result: null,
    aggregated: null,
    noData: false,
    status: "idle",
  });
  useSLAStore.getState().reset();
  useDatasetStore.getState().setActiveDataset(null);
  useFilterStore.setState({ slice: defaultFilterSlice(), revision: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Scorecard render performance (Req 11.1)", () => {
  it("renders the full scorecard grid for a realistic slice under 2 seconds", () => {
    // A realistic per-day dataset feeding the sparkline derivation path.
    const records = buildAggregatedRecords(360);
    seedScorecards(records);

    const start = performance.now();
    render(<ScorecardGrid />);
    // Assert something actually rendered so the timing is meaningful.
    expect(screen.getAllByRole("article").length).toBeGreaterThan(0);
    const elapsed = performance.now() - start;

    // Generous tripwire vs. the 2 s product SLA (jsdom timing is coarse).
    expect(elapsed).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// Tables virtualize at 10,000+ rows (Req 15.3)
// ---------------------------------------------------------------------------

/**
 * jsdom performs no layout, so the real virtualizer would paint no window. To
 * assert the windowing *contract* deterministically we mock the virtualizer to
 * return a small fixed window regardless of row count — mirroring
 * `VirtualizedTable.test.tsx`. The point here is the complementary Req 15.3
 * assertion: at 10,000+ rows only a small window is materialized while the grid
 * still declares the full row count.
 */
const ROW_HEIGHT = 32;
const WINDOW_SIZE = 12;

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => {
    const last = Math.min(WINDOW_SIZE - 1, count - 1);
    const items: { index: number; key: number; start: number; size: number }[] = [];
    for (let i = 0; i <= last; i += 1) {
      items.push({ index: i, key: i, start: i * ROW_HEIGHT, size: ROW_HEIGHT });
    }
    return {
      getVirtualItems: () => items,
      getTotalSize: () => count * ROW_HEIGHT,
    };
  },
}));

interface PerfRow {
  id: number;
  label: string;
  value: number;
}

const perfColumns: ColumnDef<PerfRow, unknown>[] = [
  { id: "id", header: "ID", accessorKey: "id" },
  { id: "label", header: "Label", accessorKey: "label" },
  { id: "value", header: "Value", accessorKey: "value" },
];

describe("Table virtualization at scale (Req 15.3)", () => {
  it("materializes only a small window for 10,000+ rows, not every row", () => {
    const data: PerfRow[] = Array.from({ length: 12_000 }, (_, i) => ({
      id: i,
      label: `Row ${i}`,
      value: i,
    }));

    render(
      <VirtualizedTable data={data} columns={perfColumns} ariaLabel="Perf rows" />,
    );

    const grid = screen.getByRole("grid", { name: "Perf rows" });
    // The full 12,000 rows (+ header) are declared to assistive tech...
    expect(grid).toHaveAttribute("aria-rowcount", "12001");

    // ...while only the small window is actually in the DOM (far below 12,000).
    const dataRows = within(grid)
      .getAllByRole("row")
      .filter((r) => r.getAttribute("aria-rowindex") !== "1");
    expect(dataRows.length).toBe(WINDOW_SIZE);
    expect(dataRows.length).toBeLessThan(200);
  });
});
