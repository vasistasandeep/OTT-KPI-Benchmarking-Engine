import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { AggregatedKPIValue, AggregatedResultSet } from "@/models/results";
import { NO_DATA } from "@/models/sentinels";
import { useDatasetStore, useResultStore } from "@/stores";

// Mock the modular ECharts surface the component uses. jsdom has no layout, so
// a real chart would render an empty SVG; the mock lets us assert the two
// contract points that matter here: the chart is initialized with the SVG
// renderer (Req 18.5) and `setOption` receives the series we expect.
const initMock = vi.fn();
const setOptionMock = vi.fn();
const disposeMock = vi.fn();
const resizeMock = vi.fn();

vi.mock("echarts/core", () => ({
  use: vi.fn(),
  init: (...args: unknown[]) => {
    initMock(...args);
    return {
      setOption: setOptionMock,
      dispose: disposeMock,
      resize: resizeMock,
    };
  },
}));
vi.mock("echarts/charts", () => ({ LineChart: {} }));
vi.mock("echarts/components", () => ({
  GridComponent: {},
  LegendComponent: {},
  TooltipComponent: {},
}));
vi.mock("echarts/renderers", () => ({ SVGRenderer: {} }));

import { TimeSeriesOverlay } from "./TimeSeriesOverlay";

/** Build an aggregated value with an optional per-bucket series. */
function value(
  overrides: Partial<AggregatedKPIValue> & Pick<AggregatedKPIValue, "kpiId" | "app">,
): AggregatedKPIValue {
  return {
    value: 0,
    unit: "ms",
    aggregability: "aggregable",
    weighted: true,
    contributingRecords: 10,
    rejectedRecords: [],
    advisories: [],
    ...overrides,
  } as AggregatedKPIValue;
}

/** Publish an aggregated result set into the result store. */
function setAggregated(overall: AggregatedKPIValue[], noData = false) {
  const aggregated: AggregatedResultSet = {
    bySegment: new Map(),
    overall,
    unweightedAdvisory: false,
  };
  useResultStore.setState({ aggregated, noData, status: "ready" });
}

beforeEach(() => {
  initMock.mockClear();
  setOptionMock.mockClear();
  disposeMock.mockClear();
  resizeMock.mockClear();
  useResultStore.setState({ aggregated: null, noData: false, status: "idle" });
  useDatasetStore.setState({ appALabel: "App A", appBLabel: "App B" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TimeSeriesOverlay", () => {
  it("initializes ECharts with the SVG renderer so the print view keeps vector nodes (Req 18.5)", () => {
    setAggregated([
      value({
        kpiId: "vst_p50",
        app: "App_A",
        series: [
          { date: "2024-03-01", value: 1200 },
          { date: "2024-03-02", value: 1100 },
        ],
      }),
      value({
        kpiId: "vst_p50",
        app: "App_B",
        series: [
          { date: "2024-03-01", value: 900 },
          { date: "2024-03-02", value: 950 },
        ],
      }),
    ]);

    render(<TimeSeriesOverlay />);

    expect(initMock).toHaveBeenCalledTimes(1);
    const [, , opts] = initMock.mock.calls[0];
    expect(opts).toEqual({ renderer: "svg" });
  });

  it("plots App_A and App_B for the selected KPI over the active range (Req 13.1)", () => {
    setAggregated([
      value({
        kpiId: "vst_p50",
        app: "App_A",
        series: [{ date: "2024-03-01", value: 1200 }],
      }),
      value({
        kpiId: "vst_p50",
        app: "App_B",
        series: [{ date: "2024-03-01", value: 900 }],
      }),
    ]);

    render(<TimeSeriesOverlay />);

    expect(setOptionMock).toHaveBeenCalled();
    const option = setOptionMock.mock.calls.at(-1)?.[0] as {
      series: { name: string; data: unknown[] }[];
    };
    const names = option.series.map((s) => s.name);
    expect(names).toContain("App A · Video Start Time (P50)");
    expect(names).toContain("App B · Video Start Time (P50)");
  });

  it("changes the plotted KPI when the metric switcher changes (Req 13.2)", async () => {
    const user = userEvent.setup();
    setAggregated([
      value({
        kpiId: "vst_p50",
        app: "App_A",
        series: [{ date: "2024-03-01", value: 1200 }],
      }),
      value({
        kpiId: "ttfb",
        app: "App_A",
        unit: "ms",
        series: [{ date: "2024-03-01", value: 80 }],
      }),
    ]);

    render(<TimeSeriesOverlay />);
    setOptionMock.mockClear();

    await user.selectOptions(
      screen.getByRole("combobox", { name: /^metric$/i }),
      "ttfb",
    );

    const option = setOptionMock.mock.calls.at(-1)?.[0] as {
      series: { name: string }[];
    };
    expect(option.series.some((s) => s.name.includes("Time To First Byte"))).toBe(
      true,
    );
  });

  it("adds a second Y-axis when the two selected KPIs use disparate units (Req 13.3)", async () => {
    const user = userEvent.setup();
    // vst_p50 canonical unit is seconds; avg_rendered_bitrate is Mbps.
    setAggregated([
      value({
        kpiId: "vst_p50",
        app: "App_A",
        series: [{ date: "2024-03-01", value: 2 }],
      }),
      value({
        kpiId: "avg_rendered_bitrate",
        app: "App_A",
        series: [{ date: "2024-03-01", value: 5 }],
      }),
    ]);

    render(<TimeSeriesOverlay />);

    // No dual axis until a comparison metric is chosen.
    expect(screen.queryByTestId("dual-axis-indicator")).not.toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole("combobox", { name: /compare metric/i }),
      "avg_rendered_bitrate",
    );

    expect(screen.getByTestId("dual-axis-indicator")).toBeInTheDocument();
    const option = setOptionMock.mock.calls.at(-1)?.[0] as { yAxis: unknown[] };
    expect(option.yAxis).toHaveLength(2);
  });

  it("re-renders when the slice (aggregated result) changes (Req 13.4)", () => {
    const { rerender } = render(<TimeSeriesOverlay />);

    // First slice: no data -> no chart yet.
    expect(screen.getByTestId("time-series-no-data")).toBeInTheDocument();

    // New slice arrives with data.
    act(() => {
      setAggregated([
        value({
          kpiId: "vst_p50",
          app: "App_A",
          series: [{ date: "2024-03-01", value: 1200 }],
        }),
      ]);
    });
    rerender(<TimeSeriesOverlay />);

    expect(screen.getByTestId("time-series-chart")).toBeInTheDocument();
    expect(initMock).toHaveBeenCalled();
  });

  it("shows a no-data state when the selected KPI has no series (Req 13.5)", () => {
    // Records exist for a different KPI, but the default metric has none.
    setAggregated([
      value({
        kpiId: "ttfb",
        app: "App_A",
        series: [{ date: "2024-03-01", value: 80 }],
      }),
    ]);

    render(<TimeSeriesOverlay />);

    expect(screen.getByTestId("time-series-no-data")).toBeInTheDocument();
    expect(initMock).not.toHaveBeenCalled();
  });

  it("drops sentinel points so a NO_DATA bucket does not plot as zero", () => {
    setAggregated([
      value({
        kpiId: "vst_p50",
        app: "App_A",
        series: [
          { date: "2024-03-01", value: 1200 },
          { date: "2024-03-02", value: NO_DATA },
          { date: "2024-03-03", value: 1100 },
        ],
      }),
    ]);

    render(<TimeSeriesOverlay />);

    const option = setOptionMock.mock.calls.at(-1)?.[0] as {
      xAxis: { data: string[] };
      series: { data: (number | null)[] }[];
    };
    // The sentinel bucket is excluded from the axis entirely.
    expect(option.xAxis.data).toEqual(["2024-03-01", "2024-03-03"]);
    expect(option.series[0].data).toEqual([1200, 1100]);
  });

  it("labels lines with the custom App_A / App_B labels from the dataset store (Req 19.6)", () => {
    useDatasetStore.setState({ appALabel: "Current", appBLabel: "Challenger" });
    setAggregated([
      value({
        kpiId: "vst_p50",
        app: "App_A",
        series: [{ date: "2024-03-01", value: 1200 }],
      }),
    ]);

    render(<TimeSeriesOverlay />);

    const option = setOptionMock.mock.calls.at(-1)?.[0] as {
      series: { name: string }[];
    };
    expect(option.series.some((s) => s.name.startsWith("Current"))).toBe(true);
    expect(option.series.some((s) => s.name.startsWith("Challenger"))).toBe(true);
  });
});
