/**
 * Component test for the ExportMenu's empty-slice guard (task 18.5; Req 18.7).
 *
 * The exhaustive CSV content assertions live in the pure-builder tests
 * (`src/lib/export/csv.test.ts`). Here we only pin the guarded side-effect: an
 * empty active slice announces "no active data to export" and produces no file,
 * while a populated slice does trigger a download. The download and print
 * side-effects are mocked so the test never touches the real Blob/anchor path.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ExportMenu } from "./ExportMenu";
import { NO_EXPORT_DATA_MESSAGE } from "@/lib/export/csv";
import { useResultStore } from "@/stores/useResultStore";
import { useDatasetStore } from "@/stores/useDatasetStore";
import type {
  AggregatedResultSet,
  ComparisonResult,
  ComparisonResultSet,
  FilterSlice,
} from "@/models/results";

const triggerDownload = vi.fn();
const printExecutiveReport = vi.fn();

vi.mock("@/lib/export/download", () => ({
  triggerDownload: (...args: unknown[]) => triggerDownload(...args),
  printExecutiveReport: (...args: unknown[]) => printExecutiveReport(...args),
}));

const slice: FilterSlice = {
  dateRange: { preset: "7d" },
  granularity: "day",
  displayTimezone: "UTC",
  dimensionSelections: {},
  apps: ["App_A", "App_B"],
};

const comparison: ComparisonResult = {
  kpiId: "vst_p50",
  appAValue: 100,
  appBValue: 110,
  absoluteDelta: 10,
  percentDelta: 10,
  rag: "Green",
  appAContributingRecords: 500,
  appBContributingRecords: 600,
};

const result: ComparisonResultSet = { results: [comparison], slice };
const aggregated: AggregatedResultSet = {
  bySegment: new Map(),
  overall: [
    {
      kpiId: "vst_p50",
      app: "App_A",
      value: 100,
      unit: "s",
      aggregability: "aggregable",
      weighted: true,
      contributingRecords: 500,
      rejectedRecords: [],
      advisories: [],
    },
  ],
  unweightedAdvisory: false,
};

/** Point the result store at a populated or empty slice. */
function setResultState(state: Partial<ReturnType<typeof useResultStore.getState>>) {
  useResultStore.setState({
    result: null,
    aggregated: null,
    noData: false,
    ...state,
  });
}

afterEach(() => {
  cleanup();
  triggerDownload.mockReset();
  printExecutiveReport.mockReset();
  useResultStore.setState({ result: null, aggregated: null, noData: false });
  useDatasetStore.setState({ appALabel: "App A", appBLabel: "App B" });
});

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /export/i }));
}

describe("ExportMenu — empty-slice guard (Req 18.7)", () => {
  it("shows the no-data message and produces no file when the slice matched no records", async () => {
    setResultState({ result, aggregated, noData: true });
    const user = userEvent.setup();
    render(<ExportMenu />);

    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: /export delta csv/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(NO_EXPORT_DATA_MESSAGE);
    expect(triggerDownload).not.toHaveBeenCalled();
  });

  it("shows the no-data message and produces no file when there is no result set", async () => {
    setResultState({ result: null, aggregated: null, noData: false });
    const user = userEvent.setup();
    render(<ExportMenu />);

    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: /aggregated summary csv/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(NO_EXPORT_DATA_MESSAGE);
    expect(triggerDownload).not.toHaveBeenCalled();
  });

  it("does not open the print dialog for an empty slice", async () => {
    setResultState({ result, aggregated, noData: true });
    const user = userEvent.setup();
    render(<ExportMenu />);

    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: /print executive report/i }));

    expect(printExecutiveReport).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(NO_EXPORT_DATA_MESSAGE);
  });

  it("triggers a download when the slice has exportable data", async () => {
    setResultState({ result, aggregated, noData: false });
    const user = userEvent.setup();
    render(<ExportMenu />);

    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: /export delta csv/i }));

    expect(triggerDownload).toHaveBeenCalledTimes(1);
    const [csv, filename] = triggerDownload.mock.calls[0];
    expect(csv).toContain("Video Start Time (P50)");
    expect(filename).toMatch(/^ott-kpi-delta_.*\.csv$/);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
