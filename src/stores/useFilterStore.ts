/**
 * `useFilterStore` — the active filter slice: date range, dimension chip
 * selections, the App_A/App_B toggle, and the display timezone (design "State
 * stores", Req 10). Every change to this store drives a debounced recompute so
 * every dashboard module reflects the same slice (Req 10.5).
 *
 * The store holds the {@link FilterSlice} directly, plus a `revision` counter
 * bumped on every change. The recompute pipeline (task 14.1, `recompute.ts`)
 * subscribes to `revision` so it can debounce and re-aggregate whenever the
 * slice changes, without diffing the slice object itself.
 *
 * The display timezone is a *rendering-only* concern: it never affects which
 * records are in the slice (filtering is always on the UTC bucket, Req 26.7);
 * it only labels timestamps in the UI. It defaults to `"UTC"` so a date range
 * is never ambiguous (Req 26.8, 26.9).
 *
 * Requirements: 10 (global filter bar), 26.8, 26.9 (UTC default timezone).
 */

import { create } from "zustand";

import type { FilterSlice } from "@/models/results";
import type { AppAssignment, DimensionId } from "@/models";

/** The default slice on boot: last 30 days, day granularity, UTC, both apps. */
export function defaultFilterSlice(): FilterSlice {
  return {
    dateRange: { preset: "30d" },
    granularity: "day",
    displayTimezone: "UTC",
    dimensionSelections: {},
    apps: ["App_A", "App_B"],
  };
}

/** The filter store's state and actions. */
export interface FilterStoreState {
  /** The active filter slice driving aggregation and comparison. */
  slice: FilterSlice;
  /** Monotonic change counter the recompute pipeline subscribes to. */
  revision: number;
  /** Replace the whole slice (used on hydration and by bulk resets). */
  setSlice(slice: FilterSlice): void;
  /** Set the date range (preset or explicit custom from/to) (Req 10.2, 26.7). */
  setDateRange(dateRange: FilterSlice["dateRange"]): void;
  /** Set the bucket granularity for series and rollup (Req 26.6). */
  setGranularity(granularity: FilterSlice["granularity"]): void;
  /** Set the display (rendering-only) timezone; UTC by default (Req 26.8). */
  setDisplayTimezone(displayTimezone: string): void;
  /** Set the selected members for one dimension chip group (Req 10.3). */
  setDimensionSelection(dimension: DimensionId, members: string[]): void;
  /** Set which apps are toggled on (App_A / App_B) (Req 10.4). */
  setApps(apps: AppAssignment[]): void;
}

export const useFilterStore = create<FilterStoreState>((set) => ({
  slice: defaultFilterSlice(),
  revision: 0,

  setSlice: (slice) => set((state) => ({ slice, revision: state.revision + 1 })),

  setDateRange: (dateRange) =>
    set((state) => ({
      slice: { ...state.slice, dateRange },
      revision: state.revision + 1,
    })),

  setGranularity: (granularity) =>
    set((state) => ({
      slice: { ...state.slice, granularity },
      revision: state.revision + 1,
    })),

  setDisplayTimezone: (displayTimezone) =>
    set((state) => ({
      slice: { ...state.slice, displayTimezone },
      revision: state.revision + 1,
    })),

  setDimensionSelection: (dimension, members) =>
    set((state) => ({
      slice: {
        ...state.slice,
        dimensionSelections: {
          ...state.slice.dimensionSelections,
          [dimension]: members,
        },
      },
      revision: state.revision + 1,
    })),

  setApps: (apps) =>
    set((state) => ({
      slice: { ...state.slice, apps },
      revision: state.revision + 1,
    })),
}));
