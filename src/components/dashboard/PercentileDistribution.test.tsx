import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";

// ECharts needs real layout (offsetWidth/height) that jsdom does not provide,
// so mock it: the component's data logic, states, and accessibility are what
// this suite verifies, not the SVG paint. The mock records setOption calls so
// we can assert the chart is fed the derived option when values exist.
const setOptionSpy = vi.fn();
vi.mock("echarts", () => ({
  init: () => ({
    setOption: setOptionSpy,
    resize: vi.fn(),
    dispose: vi.fn(),
  }),
}));

import { PercentileDistribution } from "./PercentileDistribution";
import type { CanonicalKPIId } from "@/models/ids";
import type { AggregatedKPIValue, AggregatedResultSet } from "@/models/results";
import type { AppAssignment } from "@/models/records";
import type { Numeric } from "@/models/sentinels";
import { NOT_AGGREGABLE } from "@/models/sentinels";
import {
  DEFAULT_APP_A_LABEL,
  DEFAULT_APP_B_LABEL,
  useDatasetStore,
  useResultStore,
} from "@/stores";

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

function setAggregated(overall: AggregatedKPIValue[]): void {
  const aggregated: AggregatedResultSet = {
    bySegment: new Map(),
    overall,
    unweightedAdvisory: false,
  };
  useResultStore.setState({ aggregated, noData: false, status: "ready" });
}

beforeEach(() => {
  setOptionSpy.mockClear();
  useResultStore.setState({ aggregated: null, noData: false, status: "idle" });
  useDatasetStore.setState({
    appALabel: DEFAULT_APP_A_LABEL,
    appBLabel: DEFAULT_APP_B_LABEL,
  });
});

describe("PercentileDistribution", () => {
  it("renders the three latency metrics in their canonical units (Req 13.6, 22.2)", () => {
    setAggregated([
      agg("vst_p50", "App_A", 1.2),
      agg("vst_p50", "App_B", 1.5),
      agg("manifest_fetch_latency", "App_A", 42),
      agg("ttfb", "App_A", 120),
    ]);

    render(<PercentileDistribution />);

    expect(screen.getByTestId("percentile-metric-vst")).toBeInTheDocument();
    expect(
      screen.getByTestId("percentile-metric-manifest_fetch_latency"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("percentile-metric-ttfb")).toBeInTheDocument();

    // Canonical units are shown per metric.
    const vst = screen.getByTestId("percentile-metric-vst");
    expect(within(vst).getByText("s")).toBeInTheDocument();
    const manifest = screen.getByTestId("percentile-metric-manifest_fetch_latency");
    expect(within(manifest).getByText("ms")).toBeInTheDocument();
  });

  it("feeds ECharts an option when a metric has drawable values (Req 13.4)", () => {
    setAggregated([
      agg("vst_p50", "App_A", 1.2),
      agg("vst_p50", "App_B", 1.5),
    ]);

    render(<PercentileDistribution />);

    expect(screen.getByTestId("percentile-chart-vst")).toBeInTheDocument();
    expect(setOptionSpy).toHaveBeenCalled();
  });

  it("shows a distinct not-aggregable state (glyph + label, not color alone) with no bar (Req 23.4, 23.8, 28.2)", () => {
    setAggregated([
      agg("manifest_fetch_latency", "App_A", NOT_AGGREGABLE),
      agg("manifest_fetch_latency", "App_B", NOT_AGGREGABLE),
    ]);

    render(<PercentileDistribution />);

    // Module-level advisory naming the not-aggregable condition in text.
    const advisory = screen.getByTestId("percentile-not-aggregable-advisory");
    expect(advisory).toHaveTextContent(/not aggregable/i);
    expect(advisory).toHaveTextContent(/ingested/i);

    // The affected metric renders no chart (no valid value to draw).
    expect(
      screen.queryByTestId("percentile-chart-manifest_fetch_latency"),
    ).not.toBeInTheDocument();

    // Per-rank state list explains P50 as not aggregable, in text.
    const state = screen.getByTestId(
      "percentile-state-manifest_fetch_latency-p50",
    );
    expect(state).toHaveTextContent(/not aggregable/i);
  });

  it("shows the module-level no-data state when nothing is drawable (Req 23.8)", () => {
    setAggregated([]); // no percentile values at all

    render(<PercentileDistribution />);

    expect(
      screen.getByTestId("percentile-distribution-no-data"),
    ).toBeInTheDocument();
  });

  it("uses the dataset's custom App labels (Req 19.6)", () => {
    useDatasetStore.setState({ appALabel: "Nova", appBLabel: "Rival" });
    setAggregated([agg("vst_p50", "App_A", 1.2), agg("vst_p50", "App_B", 1.5)]);

    render(<PercentileDistribution />);

    expect(screen.getByText(/Nova vs Rival/)).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    setAggregated([
      agg("vst_p50", "App_A", 1.2),
      agg("vst_p50", "App_B", 1.5),
      agg("manifest_fetch_latency", "App_A", NOT_AGGREGABLE),
      agg("manifest_fetch_latency", "App_B", NOT_AGGREGABLE),
    ]);

    const { container } = render(<PercentileDistribution />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
