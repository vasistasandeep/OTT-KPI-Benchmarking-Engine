/**
 * Unit tests for the state-store actions (task 14.1): the dataset, filter, and
 * SLA stores. The result store is covered end to end by `recompute.test.ts`.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { useDatasetStore, DEFAULT_APP_A_LABEL, DEFAULT_APP_B_LABEL } from "./useDatasetStore";
import { useFilterStore, defaultFilterSlice } from "./useFilterStore";
import { useSLAStore } from "./useSLAStore";
import type { Dataset } from "@/models/records";

function makeDataset(appA: string, appB: string): Dataset {
  return {
    id: "d",
    name: "D",
    createdAt: "2025-01-01T00:00:00Z",
    appALabel: appA,
    appBLabel: appB,
    recordCount: 0,
    sourceType: "Aggregated",
    ingestionMode: "Pre_Aggregated",
    records: [],
  };
}

describe("useDatasetStore", () => {
  beforeEach(() => {
    useDatasetStore.setState({
      activeDataset: null,
      datasets: [],
      appALabel: DEFAULT_APP_A_LABEL,
      appBLabel: DEFAULT_APP_B_LABEL,
    });
  });

  it("derives App labels from the active dataset", () => {
    useDatasetStore.getState().setActiveDataset(makeDataset("Alpha", "Beta"));
    expect(useDatasetStore.getState().appALabel).toBe("Alpha");
    expect(useDatasetStore.getState().appBLabel).toBe("Beta");
  });

  it("falls back to the generic labels when no dataset is active", () => {
    useDatasetStore.getState().setActiveDataset(null);
    expect(useDatasetStore.getState().appALabel).toBe(DEFAULT_APP_A_LABEL);
    expect(useDatasetStore.getState().appBLabel).toBe(DEFAULT_APP_B_LABEL);
  });
});

describe("useFilterStore", () => {
  beforeEach(() => {
    useFilterStore.setState({ slice: defaultFilterSlice(), revision: 0 });
  });

  it("defaults to UTC, day granularity, 30d, both apps (Req 26.8)", () => {
    const { slice } = useFilterStore.getState();
    expect(slice.displayTimezone).toBe("UTC");
    expect(slice.granularity).toBe("day");
    expect(slice.dateRange).toEqual({ preset: "30d" });
    expect(slice.apps).toEqual(["App_A", "App_B"]);
  });

  it("bumps the revision on every mutation so the pipeline can subscribe", () => {
    const start = useFilterStore.getState().revision;
    useFilterStore.getState().setGranularity("hour");
    useFilterStore.getState().setDisplayTimezone("Asia/Kolkata");
    useFilterStore.getState().setApps(["App_A"]);
    useFilterStore.getState().setDimensionSelection("platform", ["Android"]);
    expect(useFilterStore.getState().revision).toBe(start + 4);
    expect(useFilterStore.getState().slice.granularity).toBe("hour");
    expect(useFilterStore.getState().slice.dimensionSelections.platform).toEqual(["Android"]);
  });
});

describe("useSLAStore", () => {
  beforeEach(() => useSLAStore.getState().reset());

  it("defaults to variance band 1.5 and min sample size 100 (Req 11.6, 25.1)", () => {
    expect(useSLAStore.getState().config.varianceBand).toBe(1.5);
    expect(useSLAStore.getState().config.minSampleSize).toBe(100);
  });

  it("sets a per-KPI threshold without disturbing others", () => {
    useSLAStore.getState().setThreshold("vst_p50", 1.0);
    useSLAStore.getState().setThreshold("ttfb", 90);
    expect(useSLAStore.getState().config.thresholds).toEqual({ vst_p50: 1.0, ttfb: 90 });
  });

  it("0 min sample size disables the gate (Req 25.1)", () => {
    useSLAStore.getState().setMinSampleSize(0);
    expect(useSLAStore.getState().config.minSampleSize).toBe(0);
  });
});
