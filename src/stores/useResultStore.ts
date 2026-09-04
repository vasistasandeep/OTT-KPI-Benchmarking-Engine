/**
 * `useResultStore` — the memoized comparison-result cache the dashboard modules
 * read from (design "State stores"). Modules never compute KPIs themselves;
 * they subscribe here and render whatever the last recompute produced.
 *
 * The store holds:
 * - `result` — the latest {@link ComparisonResultSet} for the active slice, or
 *   `null` before the first recompute completes.
 * - `aggregated` — the underlying {@link AggregatedResultSet}, so per-segment
 *   modules (heatmap) can read segment values without a second aggregation.
 * - `noData` — true when the active slice matched no records, so every module
 *   can render its own no-data state (Req 10.6).
 * - `status` / `progress` — the recompute lifecycle, so the UI can show a
 *   progress indicator while a large raw-session aggregation runs in the worker
 *   (Req 17.3).
 * - `slice` — the filter slice the cached result was computed for, so a module
 *   can tell whether the cache is stale relative to the live filter store.
 *
 * The store is populated exclusively by the recompute pipeline (task 14.1,
 * `recompute.ts`); modules only read from it.
 */

import { create } from "zustand";

import type {
  AggregatedResultSet,
  ComparisonResultSet,
  FilterSlice,
} from "@/models/results";
import type { AggregationProgress } from "@/worker/worker-aggregation-engine";

/** Where the recompute pipeline is in its lifecycle. */
export type RecomputeStatus = "idle" | "computing" | "ready" | "error";

/** The result store's state and actions. */
export interface ResultStoreState {
  /** The latest comparison result set, or null before the first recompute. */
  result: ComparisonResultSet | null;
  /** The underlying aggregated set, for per-segment modules (heatmap). */
  aggregated: AggregatedResultSet | null;
  /** True when the active slice matched no records at all (Req 10.6). */
  noData: boolean;
  /** The current recompute lifecycle status. */
  status: RecomputeStatus;
  /** The most recent progress update while computing, or null when idle. */
  progress: AggregationProgress | null;
  /** The slice the cached result was computed for, for staleness checks. */
  slice: FilterSlice | null;
  /** An error message when `status === "error"`, else null. */
  error: string | null;

  /** Mark the pipeline as computing and clear any stale error. */
  beginCompute(): void;
  /** Record the latest progress update from the (worker) engine. */
  setProgress(progress: AggregationProgress): void;
  /** Publish a completed recompute's results for the given slice. */
  setResult(input: {
    result: ComparisonResultSet;
    aggregated: AggregatedResultSet;
    noData: boolean;
    slice: FilterSlice;
  }): void;
  /** Record a failed recompute so the UI can surface it. */
  setError(message: string): void;
}

export const useResultStore = create<ResultStoreState>((set) => ({
  result: null,
  aggregated: null,
  noData: false,
  status: "idle",
  progress: null,
  slice: null,
  error: null,

  beginCompute: () => set({ status: "computing", error: null }),

  setProgress: (progress) => set({ progress }),

  setResult: ({ result, aggregated, noData, slice }) =>
    set({
      result,
      aggregated,
      noData,
      slice,
      status: "ready",
      progress: null,
      error: null,
    }),

  setError: (message) => set({ status: "error", error: message, progress: null }),
}));
