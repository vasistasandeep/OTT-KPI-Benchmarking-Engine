import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

import { WinnerHeatmap } from "./WinnerHeatmap";
import type {
  AggregatedKPIValue,
  AggregatedResultSet,
} from "@/models/results";
import type { AppAssignment } from "@/models";
import { NOT_AGGREGABLE, type Numeric } from "@/models/sentinels";
import { KPI_BY_ID } from "@/registry/kpi-registry";
import {
  DEFAULT_APP_A_LABEL,
  DEFAULT_APP_B_LABEL,
  useDatasetStore,
  useResultStore,
  useSLAStore,
} from "@/stores";

/** Build one aggregated value with only the fields the heatmap reads. */
function value(
  kpiId: AggregatedKPIValue["kpiId"],
  app: AppAssignment,
  v: Numeric,
  contributingRecords = 1000,
): AggregatedKPIValue {
  const def = KPI_BY_ID[kpiId];
  return {
    kpiId,
    app,
    value: v,
    unit: def.canonicalUnit,
    aggregability: v === NOT_AGGREGABLE ? "not_aggregable" : "aggregable",
    weighted: true,
    contributingRecords,
    rejectedRecords: [],
    advisories: [],
  };
}

/** Publish an aggregated result set into the result store for the component. */
function seedAggregated(entries: [string, AggregatedKPIValue[]][]) {
  const aggregated: AggregatedResultSet = {
    bySegment: new Map(entries),
    overall: [],
    unweightedAdvisory: false,
  };
  useResultStore.setState({ aggregated, noData: false, status: "ready" });
}

beforeEach(() => {
  useResultStore.setState({ aggregated: null, noData: false, status: "idle" });
  useSLAStore.getState().reset();
  useDatasetStore.setState({
    appALabel: DEFAULT_APP_A_LABEL,
    appBLabel: DEFAULT_APP_B_LABEL,
  });
});

describe("WinnerHeatmap", () => {
  it("renders KPI rows and dimension-segment columns as a grid (Req 12.1)", () => {
    // minSampleSize 0 so single-record fixtures are not gated as low-confidence.
    useSLAStore.getState().setMinSampleSize(0);
    seedAggregated([
      ["platform=iOS", [value("avg_rendered_bitrate", "App_A", 5), value("avg_rendered_bitrate", "App_B", 4)]],
      ["platform=Android", [value("avg_rendered_bitrate", "App_A", 3), value("avg_rendered_bitrate", "App_B", 6)]],
    ]);

    render(<WinnerHeatmap />);

    expect(screen.getByRole("columnheader", { name: /^iOS$/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /^Android$/ })).toBeInTheDocument();
    expect(
      screen.getByRole("rowheader", { name: /average rendered bitrate/i }),
    ).toBeInTheDocument();
  });

  it("conveys the winner with a text label, not color alone (Req 28.2)", () => {
    useSLAStore.getState().setMinSampleSize(0);
    seedAggregated([
      // higher_is_better bitrate: App_A wins iOS, App_B wins Android.
      ["platform=iOS", [value("avg_rendered_bitrate", "App_A", 5), value("avg_rendered_bitrate", "App_B", 4)]],
      ["platform=Android", [value("avg_rendered_bitrate", "App_A", 3), value("avg_rendered_bitrate", "App_B", 6)]],
    ]);

    render(<WinnerHeatmap />);

    // Each cell's accessible name spells out the verdict and names the winner.
    expect(
      screen.getByRole("gridcell", {
        name: /average rendered bitrate, iOS: App A wins/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("gridcell", {
        name: /average rendered bitrate, Android: App B wins/i,
      }),
    ).toBeInTheDocument();
  });

  it("gives each non-winner state a distinct label (Req 12.5, 23.4, 25.9, 28.2)", () => {
    useSLAStore.getState().setMinSampleSize(100);
    seedAggregated([
      // no-data: App_B missing.
      ["platform=iOS", [value("avg_rendered_bitrate", "App_A", 5, 1000)]],
      // not-aggregable sentinel.
      ["platform=Android", [value("avg_rendered_bitrate", "App_A", NOT_AGGREGABLE, 1000), value("avg_rendered_bitrate", "App_B", 4, 1000)]],
      // low-confidence: App_A under the floor.
      ["platform=FireTV", [value("avg_rendered_bitrate", "App_A", 5, 10), value("avg_rendered_bitrate", "App_B", 4, 1000)]],
      // tie.
      ["platform=WebOS", [value("avg_rendered_bitrate", "App_A", 5, 1000), value("avg_rendered_bitrate", "App_B", 5, 1000)]],
    ]);

    render(<WinnerHeatmap />);

    // Scope each assertion to the bitrate row so the KPI name disambiguates the
    // cell (every KPI has an iOS/Android/… cell, so the member alone is not
    // unique).
    expect(
      screen.getByRole("gridcell", {
        name: /Average Rendered Bitrate, iOS: no data/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("gridcell", {
        name: /Average Rendered Bitrate, Android: not comparable/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("gridcell", {
        name: /Average Rendered Bitrate, FireTV: low confidence/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("gridcell", {
        name: /Average Rendered Bitrate, WebOS: tie/i,
      }),
    ).toBeInTheDocument();
  });

  it("re-renders the segment axis when the dimension selector changes (Req 12.4)", async () => {
    useSLAStore.getState().setMinSampleSize(0);
    const user = userEvent.setup();
    seedAggregated([
      ["network=Wi-Fi", [value("avg_rendered_bitrate", "App_A", 5), value("avg_rendered_bitrate", "App_B", 4)]],
    ]);

    render(<WinnerHeatmap />);

    // Default dimension (platform) has no matching segments → empty state.
    expect(screen.getByTestId("heatmap-no-data")).toBeInTheDocument();

    // Switch to Network & ISP → the Wi-Fi column appears.
    await user.selectOptions(
      screen.getByLabelText(/segment by/i),
      "network",
    );
    expect(screen.getByRole("columnheader", { name: /^Wi-Fi$/ })).toBeInTheDocument();
  });

  it("uses the dataset's custom App labels in winner cells (Req 19.6)", () => {
    useSLAStore.getState().setMinSampleSize(0);
    useDatasetStore.setState({ appALabel: "Netflix", appBLabel: "Disney+" });
    seedAggregated([
      ["platform=iOS", [value("avg_rendered_bitrate", "App_A", 5), value("avg_rendered_bitrate", "App_B", 4)]],
    ]);

    render(<WinnerHeatmap />);
    expect(
      screen.getByRole("gridcell", { name: /Netflix wins/i }),
    ).toBeInTheDocument();
  });

  it("shows its own no-data state when no aggregated results exist (Req 12.5)", () => {
    render(<WinnerHeatmap />);
    expect(screen.getByTestId("heatmap-no-data")).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    useSLAStore.getState().setMinSampleSize(0);
    seedAggregated([
      ["platform=iOS", [value("avg_rendered_bitrate", "App_A", 5), value("avg_rendered_bitrate", "App_B", 4)]],
    ]);
    const { container } = render(<WinnerHeatmap />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
