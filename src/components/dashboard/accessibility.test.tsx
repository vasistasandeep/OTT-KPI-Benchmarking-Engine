import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { axe } from "jest-axe";

/**
 * Consolidated accessibility tests (task 19.3; Req 28.1–28.9).
 *
 * The per-module suites already cover the happy-path `axe` scan and each
 * module's semantics; this file fills the task's remaining gaps:
 *
 *   - `axe` scans across the *degraded* module states (no-data, not-aggregable,
 *     low-confidence) so an alternate render path never regresses (Req 28.1–28.4);
 *   - color-independence: RAG / heatmap outcomes carry a glyph + text label, not
 *     color alone (Req 28.1, 28.2);
 *   - chart tabular alternatives are present and mirror the plotted series
 *     (Req 28.4, 28.8): TimeSeriesOverlay's `time-series-data-table` and
 *     PercentileDistribution's `percentile-data-table-<key>`;
 *   - the AppShell recompute live region announces the recompute lifecycle
 *     politely (Req 28.8).
 *
 * ECharts needs real layout jsdom cannot provide, so both the modular
 * (`echarts/core`) and the monolithic (`echarts`) surfaces are mocked. These
 * tests assert DOM/AT semantics, not chart paint.
 */

vi.mock("echarts/core", () => ({
  use: vi.fn(),
  init: () => ({ setOption: vi.fn(), dispose: vi.fn(), resize: vi.fn() }),
}));
vi.mock("echarts/charts", () => ({ LineChart: {} }));
vi.mock("echarts/components", () => ({
  GridComponent: {},
  LegendComponent: {},
  TooltipComponent: {},
}));
vi.mock("echarts/renderers", () => ({ SVGRenderer: {} }));
vi.mock("echarts", () => ({
  init: () => ({ setOption: vi.fn(), dispose: vi.fn(), resize: vi.fn() }),
}));

import { ScorecardGrid } from "./ScorecardGrid";
import { WinnerHeatmap } from "./WinnerHeatmap";
import { TimeSeriesOverlay } from "./TimeSeriesOverlay";
import { PercentileDistribution } from "./PercentileDistribution";
import { AppShell } from "./AppShell";

import type { AppAssignment } from "@/models/records";
import type {
  AggregatedKPIValue,
  AggregatedResultSet,
  ComparisonResult,
  ComparisonResultSet,
  RAGStatus,
} from "@/models/results";
import type { CanonicalKPIId } from "@/models/ids";
import { NOT_AGGREGABLE, type Numeric } from "@/models/sentinels";
import { KPI_BY_ID } from "@/registry/kpi-registry";
import {
  DEFAULT_APP_A_LABEL,
  DEFAULT_APP_B_LABEL,
  defaultFilterSlice,
  useDatasetStore,
  useFilterStore,
  useResultStore,
  useSLAStore,
} from "@/stores";

// ---------------------------------------------------------------------------
// Fixture builders (mirrors the per-module suites so states are realistic).
// ---------------------------------------------------------------------------

function aggValue(
  kpiId: CanonicalKPIId,
  app: AppAssignment,
  value: Numeric,
  extra: Partial<AggregatedKPIValue> = {},
): AggregatedKPIValue {
  const def = KPI_BY_ID[kpiId];
  return {
    kpiId,
    app,
    value,
    unit: def.canonicalUnit,
    aggregability: value === NOT_AGGREGABLE ? "not_aggregable" : "aggregable",
    weighted: true,
    contributingRecords: 1000,
    rejectedRecords: [],
    advisories: [],
    ...extra,
  };
}

function comparison(
  kpiId: CanonicalKPIId,
  rag: RAGStatus,
  fields: Partial<ComparisonResult> = {},
): ComparisonResult {
  return {
    kpiId,
    appAValue: 10,
    appBValue: 12,
    absoluteDelta: 2,
    percentDelta: 20,
    rag,
    appAContributingRecords: 1000,
    appBContributingRecords: 1000,
    ...fields,
  };
}

/** Publish a comparison + aggregated result set into the stores. */
function seedResults(input: {
  results: ComparisonResult[];
  overall: AggregatedKPIValue[];
}) {
  const slice = {
    ...defaultFilterSlice(),
    dateRange: { preset: "custom" as const, from: "2024-01-01", to: "2024-12-31" },
  };
  const aggregated: AggregatedResultSet = {
    bySegment: new Map(),
    overall: input.overall,
    unweightedAdvisory: false,
  };
  const result: ComparisonResultSet = { results: input.results, slice };
  useFilterStore.setState({ slice, revision: 1 });
  useResultStore.setState({
    result,
    aggregated,
    noData: false,
    status: "ready",
  });
}

beforeEach(() => {
  useResultStore.setState({
    result: null,
    aggregated: null,
    noData: false,
    status: "idle",
    progress: null,
  });
  useSLAStore.getState().reset();
  useSLAStore.getState().setMinSampleSize(100);
  useDatasetStore.getState().setActiveDataset(null);
  useDatasetStore.setState({
    appALabel: DEFAULT_APP_A_LABEL,
    appBLabel: DEFAULT_APP_B_LABEL,
  });
  useFilterStore.setState({ slice: defaultFilterSlice(), revision: 0 });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// axe scans across degraded module states (Req 28.1–28.4).
// ---------------------------------------------------------------------------

describe("axe scans across module states", () => {
  it("ScorecardGrid has no violations in the no-data state (Req 28.1)", async () => {
    seedResults({
      results: [
        comparison("rebuffer_ratio", "NoData", {
          suppressionReason: "no_data",
          absoluteDelta: null,
          percentDelta: null,
        }),
      ],
      overall: [aggValue("rebuffer_ratio", "App_A", null)],
    });
    const { container } = render(<ScorecardGrid />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("ScorecardGrid has no violations in the low-confidence state (Req 28.1)", async () => {
    seedResults({
      results: [
        comparison("rebuffer_ratio", "LowConfidence", {
          suppressionReason: "below_min_sample",
          appAContributingRecords: 10,
        }),
      ],
      overall: [
        aggValue("rebuffer_ratio", "App_A", 2, { contributingRecords: 10 }),
        aggValue("rebuffer_ratio", "App_B", 1.5),
      ],
    });
    const { container } = render(<ScorecardGrid />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("WinnerHeatmap has no violations with mixed cell outcomes (Req 28.2)", async () => {
    useSLAStore.getState().setMinSampleSize(100);
    const aggregated: AggregatedResultSet = {
      bySegment: new Map([
        ["platform=iOS", [aggValue("avg_rendered_bitrate", "App_A", 5, { contributingRecords: 1000 })]],
        [
          "platform=Android",
          [
            aggValue("avg_rendered_bitrate", "App_A", NOT_AGGREGABLE, { contributingRecords: 1000 }),
            aggValue("avg_rendered_bitrate", "App_B", 4, { contributingRecords: 1000 }),
          ],
        ],
        [
          "platform=FireTV",
          [
            aggValue("avg_rendered_bitrate", "App_A", 5, { contributingRecords: 10 }),
            aggValue("avg_rendered_bitrate", "App_B", 4, { contributingRecords: 1000 }),
          ],
        ],
      ]),
      overall: [],
      unweightedAdvisory: false,
    };
    useResultStore.setState({ aggregated, noData: false, status: "ready" });

    const { container } = render(<WinnerHeatmap />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("PercentileDistribution has no violations in the not-aggregable state (Req 28.2, 28.4)", async () => {
    const aggregated: AggregatedResultSet = {
      bySegment: new Map(),
      overall: [
        aggValue("manifest_fetch_latency", "App_A", NOT_AGGREGABLE),
        aggValue("manifest_fetch_latency", "App_B", NOT_AGGREGABLE),
      ],
      unweightedAdvisory: false,
    };
    useResultStore.setState({ aggregated, noData: false, status: "ready" });

    const { container } = render(<PercentileDistribution />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("TimeSeriesOverlay has no violations with a plotted trend (Req 28.4)", async () => {
    const aggregated: AggregatedResultSet = {
      bySegment: new Map(),
      overall: [
        aggValue("vst_p50", "App_A", 1.2, {
          series: [
            { date: "2024-03-01", value: 1200 },
            { date: "2024-03-02", value: 1100 },
          ],
        } as Partial<AggregatedKPIValue>),
        aggValue("vst_p50", "App_B", 0.9, {
          series: [{ date: "2024-03-01", value: 900 }],
        } as Partial<AggregatedKPIValue>),
      ],
      unweightedAdvisory: false,
    };
    useResultStore.setState({ aggregated, noData: false, status: "ready" });

    const { container } = render(<TimeSeriesOverlay />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// Color independence: glyph + text label, not color alone (Req 28.1, 28.2).
// ---------------------------------------------------------------------------

describe("color-independent status", () => {
  it("ScorecardGrid RAG badge carries a glyph and a text label (Req 28.1)", () => {
    seedResults({
      results: [comparison("rebuffer_ratio", "Amber")],
      overall: [
        aggValue("rebuffer_ratio", "App_A", 2),
        aggValue("rebuffer_ratio", "App_B", 1.5),
      ],
    });
    render(<ScorecardGrid />);

    // Scope to the KPI whose comparison we seeded (other cards render as no-data).
    const card = screen.getByRole("article", { name: /rebuffer ratio/i });
    const badge = within(card).getByTestId("rag-badge");
    // A text label spells the status out (not color alone) …
    expect(badge).toHaveTextContent(/amber/i);
    // … alongside a decorative glyph carried as an svg.
    expect(badge.querySelector("svg")).not.toBeNull();
  });

  it("WinnerHeatmap conveys every outcome with a text label in the cell name (Req 28.2)", () => {
    useSLAStore.getState().setMinSampleSize(100);
    const aggregated: AggregatedResultSet = {
      bySegment: new Map([
        [
          "platform=iOS",
          [
            aggValue("avg_rendered_bitrate", "App_A", 5, { contributingRecords: 1000 }),
            aggValue("avg_rendered_bitrate", "App_B", 4, { contributingRecords: 1000 }),
          ],
        ],
        ["platform=Android", [aggValue("avg_rendered_bitrate", "App_A", 5, { contributingRecords: 1000 })]],
      ]),
      overall: [],
      unweightedAdvisory: false,
    };
    useResultStore.setState({ aggregated, noData: false, status: "ready" });

    render(<WinnerHeatmap />);
    // Scope both assertions to the bitrate row so the KPI name disambiguates
    // the cell (every KPI renders an iOS/Android cell).
    // The winning cell names the winner in text …
    expect(
      screen.getByRole("gridcell", {
        name: /Average Rendered Bitrate, iOS: App A wins/i,
      }),
    ).toBeInTheDocument();
    // … and the missing-comparator cell says "no data" rather than relying on fill.
    expect(
      screen.getByRole("gridcell", {
        name: /Average Rendered Bitrate, Android: no data/i,
      }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Chart tabular alternatives (Req 28.4, 28.8).
// ---------------------------------------------------------------------------

describe("chart tabular alternatives", () => {
  it("TimeSeriesOverlay renders a data table mirroring the plotted series (Req 28.4)", () => {
    const aggregated: AggregatedResultSet = {
      bySegment: new Map(),
      overall: [
        aggValue("vst_p50", "App_A", 1.2, {
          series: [
            { date: "2024-03-01", value: 1200 },
            { date: "2024-03-02", value: 1100 },
          ],
        } as Partial<AggregatedKPIValue>),
        aggValue("vst_p50", "App_B", 0.9, {
          series: [{ date: "2024-03-01", value: 900 }],
        } as Partial<AggregatedKPIValue>),
      ],
      unweightedAdvisory: false,
    };
    useResultStore.setState({ aggregated, noData: false, status: "ready" });

    render(<TimeSeriesOverlay />);

    const table = screen.getByTestId("time-series-data-table");
    // One column per plotted App series for the primary metric.
    expect(
      within(table).getByRole("columnheader", { name: /App A · Video Start Time \(P50\)/i }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("columnheader", { name: /App B · Video Start Time \(P50\)/i }),
    ).toBeInTheDocument();
    // One row per bucket date, carrying the plotted value; the gap for App B on
    // 2024-03-02 renders as an em dash rather than a fabricated zero.
    const marchTwo = within(table).getByRole("row", { name: /2024-03-02/ });
    expect(within(marchTwo).getByRole("cell", { name: "1100" })).toBeInTheDocument();
    expect(within(marchTwo).getByRole("cell", { name: "—" })).toBeInTheDocument();
  });

  it("PercentileDistribution renders a per-metric data table for each key (Req 28.4)", () => {
    const aggregated: AggregatedResultSet = {
      bySegment: new Map(),
      overall: [
        aggValue("vst_p50", "App_A", 1.2),
        aggValue("vst_p50", "App_B", 1.5),
        aggValue("vst_p95", "App_A", 3.1),
        aggValue("manifest_fetch_latency", "App_A", 42),
        aggValue("ttfb", "App_A", 120),
      ],
      unweightedAdvisory: false,
    };
    useResultStore.setState({ aggregated, noData: false, status: "ready" });

    render(<PercentileDistribution />);

    // A tabular alternative keyed by the metric key for each drawable metric.
    const vstTable = screen.getByTestId("percentile-data-table-vst");
    expect(within(vstTable).getByRole("columnheader", { name: DEFAULT_APP_A_LABEL })).toBeInTheDocument();
    expect(within(vstTable).getByRole("columnheader", { name: DEFAULT_APP_B_LABEL })).toBeInTheDocument();
    // The P50 row carries App A's value with the canonical unit.
    const p50 = within(vstTable).getByRole("row", { name: /P50/ });
    expect(within(p50).getByRole("cell", { name: /1\.2 s/ })).toBeInTheDocument();

    expect(
      screen.getByTestId("percentile-data-table-manifest_fetch_latency"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("percentile-data-table-ttfb")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AppShell recompute live region (Req 28.8).
// ---------------------------------------------------------------------------

describe("recompute live region", () => {
  /** Boot the shell without touching IndexedDB; hold it in the booting phase. */
  const neverResolvingBoot = () => new Promise<never>(() => {});

  it("exposes a polite, atomic recompute announcer (Req 28.8)", async () => {
    render(<AppShell bootRepository={neverResolvingBoot} />);

    const region = screen.getByTestId("recompute-live-region");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
    expect(region).toHaveAttribute("role", "status");
  });

  it("announces each recompute lifecycle transition in text (Req 28.8)", async () => {
    render(<AppShell bootRepository={neverResolvingBoot} />);
    const region = screen.getByTestId("recompute-live-region");

    // Idle: nothing announced.
    expect(region).toHaveTextContent("");

    act(() => {
      useResultStore.setState({
        status: "computing",
        progress: { label: "42%" } as never,
      });
    });
    await waitFor(() => expect(region).toHaveTextContent(/recomputing/i));
    expect(region).toHaveTextContent(/42%/);

    act(() => {
      useResultStore.setState({ status: "ready", progress: null });
    });
    await waitFor(() => expect(region).toHaveTextContent(/results updated/i));

    act(() => {
      useResultStore.setState({ status: "error", progress: null });
    });
    await waitFor(() => expect(region).toHaveTextContent(/recompute failed/i));
  });
});
