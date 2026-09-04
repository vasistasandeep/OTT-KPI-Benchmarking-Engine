/**
 * `useDatasetStore` — the active dataset and the list of stored datasets, plus
 * the custom App_A/App_B labels shown throughout the dashboard (design "State
 * stores", Req 19).
 *
 * The store holds the *loaded* active dataset (with its records) so the
 * recompute pipeline can slice it without re-reading storage on every filter
 * change, alongside the lightweight `DatasetMeta` list that powers the dataset
 * switcher. Loading, saving, promoting, and deleting datasets is the
 * repository's job; this store just mirrors the current selection. `hydrate`
 * (in `recompute.ts`) populates it on boot.
 *
 * The App_A/App_B labels are derived from the active dataset's meta, defaulting
 * to the generic "App A" / "App B" when no dataset is active yet.
 *
 * Requirements: 19 (dataset switcher, custom labels), 3.3 (restore on load).
 */

import { create } from "zustand";

import type { Dataset, DatasetMeta } from "@/models/records";

/** Default App_A label when no dataset is active. */
export const DEFAULT_APP_A_LABEL = "App A";
/** Default App_B label when no dataset is active. */
export const DEFAULT_APP_B_LABEL = "App B";

/** The dataset store's state and actions. */
export interface DatasetStoreState {
  /** The loaded active dataset (records included), or null before hydration. */
  activeDataset: Dataset | null;
  /** Lightweight metadata for every stored dataset, for the switcher. */
  datasets: DatasetMeta[];
  /** Display label for App_A (from the active dataset, or the default). */
  appALabel: string;
  /** Display label for App_B (from the active dataset, or the default). */
  appBLabel: string;
  /** Set the loaded active dataset and derive its App labels. */
  setActiveDataset(dataset: Dataset | null): void;
  /** Replace the dataset metadata list (after a save/delete/rename). */
  setDatasets(datasets: DatasetMeta[]): void;
}

/** The App_A label for a dataset, falling back to the generic default. */
function appALabelOf(dataset: Dataset | null): string {
  return dataset?.appALabel || DEFAULT_APP_A_LABEL;
}

/** The App_B label for a dataset, falling back to the generic default. */
function appBLabelOf(dataset: Dataset | null): string {
  return dataset?.appBLabel || DEFAULT_APP_B_LABEL;
}

export const useDatasetStore = create<DatasetStoreState>((set) => ({
  activeDataset: null,
  datasets: [],
  appALabel: DEFAULT_APP_A_LABEL,
  appBLabel: DEFAULT_APP_B_LABEL,

  setActiveDataset: (dataset) =>
    set({
      activeDataset: dataset,
      appALabel: appALabelOf(dataset),
      appBLabel: appBLabelOf(dataset),
    }),

  setDatasets: (datasets) => set({ datasets }),
}));
