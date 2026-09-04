/**
 * Example tests for the pure CSV export builders and the empty-slice guard
 * (task 18.5; Req 18.2, 18.4, 18.7).
 *
 * These drive the framework-free builders in `csv.ts` directly so the exported
 * content can be asserted line-by-line without a DOM:
 *
 *   - {@link buildDeltaCSV} — one row per active KPI carrying the App_A /
 *     App_B values, the absolute and percentage deltas, and the RAG status
 *     (Req 18.2).
 *   - {@link buildAggregatedSummaryCSV} — the aggregated per-app values for
 *     the slice (Req 18.4).
 *   - {@link hasExportableData} / {@link NO_EXPORT_DATA_MESSAGE} — the
 *     empty-slice guard: nothing to export means the caller shows the message
 *     and produces no file (Req 18.7).
 */

import { describe, it, expect } from "vitest";
import { NO_DATA, NOT_AGGREGABLE } from "../../models/sentinels";
import type {
  AggregatedKPIValue,
  AggregatedResultSet,
  ComparisonResult,
  ComparisonResultSet,
  FilterSlice,
} from "../../models/results";
import {
  buildAggregatedSummaryCSV,
  buildDeltaCSV,
  escapeCSVField,
  hasExportableData,
  NO_EXPORT_DATA_MESSAGE,
  type ExportLabels,
} from "./csv";

/** A UTC, day-granularity 7-day slice. */
const slice: FilterSlice = {
  dateRange: { preset: "7d" },
  granularity: "day",
  displayTimezone: "UTC",
  dimensionSelections: {},
  apps: ["App_A", "App_B"],
};

/** Explicit App labels so the header columns are unambiguous in assertions. */
const labels: ExportLabels = { appA: "Prime", appB: "Netflix" };

/** The metadata header prepended to every export for the slice above. */
const META = [
  "# Display timezone,UTC",
  "# Date range,Last 7 days",
  "# Granularity,day",
];

function comparison(overrides: Partial<ComparisonResult> = {}): ComparisonResult {
  return {
    kpiId: "vst_p50",
    appAValue: 100,
    appBValue: 110,
    absoluteDelta: 10,
    percentDelta: 10,
    rag: "Green",
    appAContributingRecords: 500,
    appBContributingRecords: 600,
    ...overrides,
  };
}

function aggregatedValue(overrides: Partial<AggregatedKPIValue> = {}): AggregatedKPIValue {
  return {
    kpiId: "vst_p50",
    app: "App_A",
    value: 100,
    unit: "s",
    aggregability: "aggregable",
    weighted: true,
    contributingRecords: 500,
    rejectedRecords: [],
    advisories: [],
    ...overrides,
  };
}

describe("buildDeltaCSV — content (Req 18.2)", () => {
  it("prepends the timezone-named metadata header and the column header", () => {
    const result: ComparisonResultSet = { results: [comparison()], slice };
    const lines = buildDeltaCSV(result, labels).split("\r\n");

    expect(lines.slice(0, 3)).toEqual(META);
    expect(lines[3]).toBe(
      "KPI,Unit,Prime value,Netflix value,Absolute delta,Percentage delta (%),RAG status",
    );
  });

  it("writes one row per active KPI with values, both deltas, and RAG", () => {
    const result: ComparisonResultSet = {
      results: [
        comparison({ kpiId: "vst_p50", appAValue: 100, appBValue: 110, absoluteDelta: 10, percentDelta: 10, rag: "Green" }),
        comparison({ kpiId: "dau", appAValue: 2000, appBValue: 1800, absoluteDelta: -200, percentDelta: -10, rag: "Red" }),
      ],
      slice,
    };
    const lines = buildDeltaCSV(result, labels).split("\r\n");

    // KPI name + canonical unit come from the registry.
    expect(lines[4]).toBe("Video Start Time (P50),s,100,110,10,10,Green");
    expect(lines[5]).toBe("Daily Active Users,count,2000,1800,-200,-10,Red");
  });

  it("renders sentinels and the N/A percentage delta as self-describing text", () => {
    const result: ComparisonResultSet = {
      results: [
        comparison({
          appAValue: NO_DATA,
          appBValue: NOT_AGGREGABLE,
          absoluteDelta: NO_DATA,
          percentDelta: "N/A",
          rag: "NoData",
        }),
      ],
      slice,
    };
    const row = buildDeltaCSV(result, labels).split("\r\n")[4];

    expect(row).toBe("Video Start Time (P50),s,No data,Not aggregable,No data,N/A,No data");
  });

  it("labels the low-confidence RAG status in words", () => {
    const result: ComparisonResultSet = {
      results: [comparison({ rag: "LowConfidence" })],
      slice,
    };
    const row = buildDeltaCSV(result, labels).split("\r\n")[4];

    expect(row.endsWith(",Low confidence")).toBe(true);
  });

  it("never emits a user-identifier column (Req 28.12)", () => {
    const result: ComparisonResultSet = { results: [comparison()], slice };
    const csv = buildDeltaCSV(result, labels).toLowerCase();

    expect(csv).not.toContain("user");
    expect(csv).not.toContain("device");
  });
});

describe("buildAggregatedSummaryCSV — content (Req 18.4)", () => {
  it("prepends the metadata header and the per-app column header", () => {
    const aggregated: AggregatedResultSet = {
      bySegment: new Map(),
      overall: [aggregatedValue()],
      unweightedAdvisory: false,
    };
    const lines = buildAggregatedSummaryCSV(aggregated, slice, [comparison()], labels).split("\r\n");

    expect(lines.slice(0, 3)).toEqual(META);
    expect(lines[3]).toBe(
      "KPI,Unit,Prime value,Prime contributing records,Netflix value,Netflix contributing records",
    );
  });

  it("pairs App_A and App_B aggregates on one row with their contributing counts", () => {
    const aggregated: AggregatedResultSet = {
      bySegment: new Map(),
      overall: [
        aggregatedValue({ app: "App_A", value: 100, contributingRecords: 500 }),
        aggregatedValue({ app: "App_B", value: 110, contributingRecords: 600 }),
      ],
      unweightedAdvisory: false,
    };
    const row = buildAggregatedSummaryCSV(aggregated, slice, [comparison()], labels).split("\r\n")[4];

    expect(row).toBe("Video Start Time (P50),s,100,500,110,600");
  });

  it("follows the comparison ordering and fills missing apps with No data / 0", () => {
    const aggregated: AggregatedResultSet = {
      bySegment: new Map(),
      overall: [
        // Only App_A present for vst_p50; dau present for App_B only.
        aggregatedValue({ kpiId: "vst_p50", app: "App_A", value: 100, contributingRecords: 500 }),
        aggregatedValue({ kpiId: "dau", app: "App_B", value: 1800, unit: "count", contributingRecords: 700 }),
      ],
      unweightedAdvisory: false,
    };
    const order = [comparison({ kpiId: "vst_p50" }), comparison({ kpiId: "dau" })];
    const lines = buildAggregatedSummaryCSV(aggregated, slice, order, labels).split("\r\n");

    expect(lines[4]).toBe("Video Start Time (P50),s,100,500,No data,0");
    expect(lines[5]).toBe("Daily Active Users,count,No data,0,1800,700");
  });
});

describe("hasExportableData — empty-slice guard (Req 18.7)", () => {
  const result: ComparisonResultSet = { results: [comparison()], slice };

  it("is true only for a non-empty result set with data present", () => {
    expect(hasExportableData(result, false)).toBe(true);
  });

  it("is false when the slice reported no data", () => {
    expect(hasExportableData(result, true)).toBe(false);
  });

  it("is false when the result set is null", () => {
    expect(hasExportableData(null, false)).toBe(false);
  });

  it("is false when the result set has no KPI rows", () => {
    expect(hasExportableData({ results: [], slice }, false)).toBe(false);
  });

  it("names the message shown when there is nothing to export", () => {
    expect(NO_EXPORT_DATA_MESSAGE).toBe("There is no active data to export.");
  });
});

describe("escapeCSVField — RFC 4180 quoting", () => {
  it("leaves plain fields untouched", () => {
    expect(escapeCSVField("Video Start Time")).toBe("Video Start Time");
  });

  it("quotes and doubles embedded quotes, commas, and newlines", () => {
    expect(escapeCSVField('a,b')).toBe('"a,b"');
    expect(escapeCSVField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCSVField("line1\nline2")).toBe('"line1\nline2"');
  });

  it("keeps a custom App label with a comma from breaking the header row", () => {
    const result: ComparisonResultSet = { results: [comparison()], slice };
    const commaLabels: ExportLabels = { appA: "Prime, US", appB: "Netflix" };
    const header = buildDeltaCSV(result, commaLabels).split("\r\n")[3];

    expect(header).toContain('"Prime, US value"');
  });
});
