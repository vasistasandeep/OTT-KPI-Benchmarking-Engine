import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

import { ScorecardGrid } from "./ScorecardGrid";
import type { AppAssignment, Dataset, KPIRecord } from "@/models/records";
import type {
  AggregatedKPIValue,
  AggregatedResultSet,
  ComparisonResult,
  ComparisonResultSet,
  FilterSlice,
  RAGStatus,
} from "@/models/results";
import { NOT_AGGREGABLE, type Numeric } from "@/models/sentinels";
import type { CanonicalKPIId, DimensionId } from "@/models/ids";
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
import type { DataQualityAdvisory } from "@/models/records";

/** A custom slice wide enough to include the fixture records' dates. */
function wideSlice(): FilterSlice {
  return {
    ...defaultFilterSlice(),
    dateRange: { preset: "custom", from: "2024-01-01", to: "2024-12-31" },
  };
}

/** Build one aggregated value with only the fields the scorecard reads. */
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

/** Build one comparison result for a KPI. */
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

/** A minimal pre-aggregated record on a given day carrying one KPI metric. */
function record(
  id: string,
  app: AppAssignment,
  dayUtc: string,
  kpiId: CanonicalKPIId,
  metric: number,
): KPIRecord {
  return {
    id,
    datasetId: "ds",
    app,
    timestampUtc: `${dayUtc}T00:00:00Z`,
    sourceUtcOffsetMinutes: 0,
    bucket: { hourUtc: `${dayUtc}T00:00:00Z`, dayUtc },
    origin: "mock",
    dimensions: {} as Record<DimensionId, string>,
    metrics: { [kpiId]: metric } as Partial<Record<CanonicalKPIId, number>>,
    volumeWeight: 100,
    ingestedGranularity: "day",
  };
}

/** A minimal active dataset carrying the given records. */
function dataset(records: KPIRecord[]): Dataset {
  return {
    id: "ds",
    name: "Test",
    createdAt: "2024-01-01T00:00:00Z",
    appALabel: DEFAULT_APP_A_LABEL,
    appBLabel: DEFAULT_APP_B_LABEL,
    recordCount: records.length,
    sourceType: "Mock",
    ingestionMode: "Pre_Aggregated",
    records,
  };
}

/** Publish results + an active dataset into the stores for the component. */
function seed(input: {
  results: ComparisonResult[];
  overall: AggregatedKPIValue[];
  records?: KPIRecord[];
  ingestionMode?: "Pre_Aggregated" | "Raw_Session";
}) {
  const slice = wideSlice();
  const aggregated: AggregatedResultSet = {
    bySegment: new Map(),
    overall: input.overall,
    unweightedAdvisory: false,
  };
  const result: ComparisonResultSet = { results: input.results, slice };
  const ds = dataset(input.records ?? []);
  ds.ingestionMode = input.ingestionMode ?? "Pre_Aggregated";

  useDatasetStore.getState().setActiveDataset(ds);
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
  useSLAStore.getState().setMinSampleSize(100);
  useDatasetStore.getState().setActiveDataset(null);
  useFilterStore.setState({ slice: defaultFilterSlice(), revision: 0 });
});

describe("ScorecardGrid", () => {
  it("organizes scorecards under one tab per pillar (Req 11.1)", () => {
    seed({ results: [], overall: [] });
    render(<ScorecardGrid />);

    for (const pillar of [
      /playback quality/i,
      /user engagement/i,
      /monetization/i,
      /infrastructure/i,
    ]) {
      expect(screen.getByRole("tab", { name: pillar })).toBeInTheDocument();
    }
  });

  it("shows both app values, deltas, and a RAG badge for a KPI (Req 11.2, 11.3, 11.5)", () => {
    seed({
      results: [
        comparison("rebuffer_ratio", "Green", {
          appAValue: 2,
          appBValue: 1.5,
          absoluteDelta: -0.5,
          percentDelta: -25,
        }),
      ],
      overall: [
        aggValue("rebuffer_ratio", "App_A", 2),
        aggValue("rebuffer_ratio", "App_B", 1.5),
      ],
    });

    render(<ScorecardGrid />);

    const card = screen.getByRole("article", { name: /rebuffer ratio/i });
    expect(card).toHaveAttribute("data-kpi", "rebuffer_ratio");
    expect(within(card).getByTestId("rag-badge")).toHaveTextContent(/green/i);
    expect(within(card).getByTestId("percent-delta")).toHaveTextContent("-25%");
  });

  it("shows N/A for the percent delta when App_A is 0 (Req 11.4)", () => {
    seed({
      results: [
        comparison("rebuffer_ratio", "Red", {
          appAValue: 0,
          appBValue: 3,
          absoluteDelta: 3,
          percentDelta: "N/A",
        }),
      ],
      overall: [
        aggValue("rebuffer_ratio", "App_A", 0),
        aggValue("rebuffer_ratio", "App_B", 3),
      ],
    });

    render(<ScorecardGrid />);
    const card = screen.getByRole("article", { name: /rebuffer ratio/i });
    expect(within(card).getByTestId("percent-delta")).toHaveTextContent("N/A");
  });

  it("renders a no-data card in place of values/delta/RAG (Req 11.9)", () => {
    seed({
      results: [
        comparison("rebuffer_ratio", "NoData", {
          suppressionReason: "no_data",
          absoluteDelta: null,
          percentDelta: null,
        }),
      ],
      overall: [aggValue("rebuffer_ratio", "App_A", null)],
    });

    render(<ScorecardGrid />);
    const card = screen.getByRole("article", { name: /rebuffer ratio/i });
    expect(card).toHaveAttribute("data-state", "no-data");
    expect(within(card).getByTestId("scorecard-no-data")).toBeInTheDocument();
  });

  it("renders a not-aggregable card with a narrow-the-slice hint (Req 23.4, 23.8)", async () => {
    const user = userEvent.setup();
    seed({
      results: [
        comparison("dau", "NoData", {
          suppressionReason: "not_aggregable",
          appAValue: NOT_AGGREGABLE,
          appBValue: NOT_AGGREGABLE,
          absoluteDelta: null,
          percentDelta: null,
        }),
      ],
      overall: [
        aggValue("dau", "App_A", NOT_AGGREGABLE, { ingestedGranularity: "day" }),
        aggValue("dau", "App_B", NOT_AGGREGABLE, { ingestedGranularity: "day" }),
      ],
    });

    render(<ScorecardGrid />);
    // dau is in the engagement pillar — switch to it before asserting.
    await user.click(screen.getByRole("tab", { name: /user engagement/i }));
    const card = screen.getByRole("article", { name: /daily active users/i });
    expect(card).toHaveAttribute("data-state", "not-aggregable");
    expect(within(card).getByTestId("scorecard-not-aggregable")).toHaveTextContent(
      /narrow the range/i,
    );
  });

  it("keeps values and deltas but badges low-confidence with counts + threshold (Req 25.5, 25.7)", () => {
    seed({
      results: [
        comparison("rebuffer_ratio", "LowConfidence", {
          suppressionReason: "below_min_sample",
          appAValue: 2,
          appBValue: 1.5,
          appAContributingRecords: 10,
          appBContributingRecords: 1000,
        }),
      ],
      overall: [
        aggValue("rebuffer_ratio", "App_A", 2, { contributingRecords: 10 }),
        aggValue("rebuffer_ratio", "App_B", 1.5),
      ],
    });

    render(<ScorecardGrid />);
    const card = screen.getByRole("article", { name: /rebuffer ratio/i });
    expect(card).toHaveAttribute("data-state", "low-confidence");
    // Values and deltas are still shown.
    expect(within(card).getByTestId("percent-delta")).not.toHaveTextContent("—");
    const detail = within(card).getByTestId("low-confidence-detail");
    expect(detail).toHaveTextContent("10");
    expect(detail).toHaveTextContent("1000");
    expect(detail).toHaveTextContent("100"); // the minimum threshold
  });

  it("badges data-quality advisories on the affected card (Req 22.6, 20.4, 22.9)", () => {
    const advisories: DataQualityAdvisory[] = [
      { code: "UNWEIGHTED_AGGREGATE", detail: "aggregated without volume weights" },
      { code: "ASSUMED_UNIT", detail: "unit could not be inferred" },
    ];
    seed({
      results: [comparison("rebuffer_ratio", "Amber")],
      overall: [
        aggValue("rebuffer_ratio", "App_A", 2, { weighted: false, advisories }),
        aggValue("rebuffer_ratio", "App_B", 1.5),
      ],
    });

    render(<ScorecardGrid />);
    const badges = screen.getByTestId("advisories");
    expect(within(badges).getByText(/unweighted/i)).toBeInTheDocument();
    expect(within(badges).getByText(/assumed unit/i)).toBeInTheDocument();
  });

  it("renders a 7-day sparkline and a partial-data indicator under 7 days (Req 11.7, 11.8)", () => {
    // Three days of data → sparkline present + partial indicator shown.
    const records: KPIRecord[] = [
      record("a1", "App_A", "2024-03-01", "rebuffer_ratio", 2),
      record("a2", "App_A", "2024-03-02", "rebuffer_ratio", 3),
      record("a3", "App_A", "2024-03-03", "rebuffer_ratio", 2.5),
      record("b1", "App_B", "2024-03-01", "rebuffer_ratio", 1),
      record("b2", "App_B", "2024-03-02", "rebuffer_ratio", 1.2),
      record("b3", "App_B", "2024-03-03", "rebuffer_ratio", 1.1),
    ];
    seed({
      results: [comparison("rebuffer_ratio", "Green")],
      overall: [
        aggValue("rebuffer_ratio", "App_A", 2.5),
        aggValue("rebuffer_ratio", "App_B", 1.1),
      ],
      records,
    });

    render(<ScorecardGrid />);
    const card = screen.getByRole("article", { name: /rebuffer ratio/i });
    expect(within(card).getAllByTestId("sparkline").length).toBeGreaterThan(0);
    expect(within(card).getByTestId("partial-data")).toBeInTheDocument();
  });

  it("uses the dataset's custom App labels (Req 19.6)", () => {
    seed({
      results: [comparison("rebuffer_ratio", "Green")],
      overall: [
        aggValue("rebuffer_ratio", "App_A", 2),
        aggValue("rebuffer_ratio", "App_B", 1.5),
      ],
    });
    useDatasetStore.setState({ appALabel: "Netflix", appBLabel: "Disney+" });

    render(<ScorecardGrid />);
    const card = screen.getByRole("article", { name: /rebuffer ratio/i });
    expect(within(card).getByText("Netflix")).toBeInTheDocument();
    expect(within(card).getByText("Disney+")).toBeInTheDocument();
  });

  it("switches pillars when a tab is clicked (Req 11.1)", async () => {
    const user = userEvent.setup();
    seed({
      results: [comparison("ttfb", "Green")],
      overall: [aggValue("ttfb", "App_A", 100), aggValue("ttfb", "App_B", 90)],
    });

    render(<ScorecardGrid />);
    // ttfb is Infrastructure & Delivery — not on the default (Playback) tab.
    expect(screen.queryByRole("article", { name: /time to first byte/i })).toBeNull();

    await user.click(screen.getByRole("tab", { name: /infrastructure/i }));
    expect(
      screen.getByRole("article", { name: /time to first byte/i }),
    ).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    seed({
      results: [comparison("rebuffer_ratio", "Green")],
      overall: [
        aggValue("rebuffer_ratio", "App_A", 2),
        aggValue("rebuffer_ratio", "App_B", 1.5),
      ],
    });
    const { container } = render(<ScorecardGrid />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
