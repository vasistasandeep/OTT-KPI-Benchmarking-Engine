/**
 * Public entry point for the Zustand state stores and the recompute pipeline
 * (design "State stores", task 14.1).
 *
 * Exposes the four stores the dashboard subscribes to — dataset, filter, SLA,
 * and result — plus the recompute orchestration (`hydrate`, `runRecompute`,
 * `scheduleRecompute`) and the pure slice-filter helpers.
 */

export {
  useDatasetStore,
  DEFAULT_APP_A_LABEL,
  DEFAULT_APP_B_LABEL,
  type DatasetStoreState,
} from "./useDatasetStore";

export {
  useFilterStore,
  defaultFilterSlice,
  type FilterStoreState,
} from "./useFilterStore";

export { useSLAStore, type SLAStoreState } from "./useSLAStore";

export {
  useResultStore,
  type ResultStoreState,
  type RecomputeStatus,
} from "./useResultStore";

export {
  hydrate,
  runRecompute,
  scheduleRecompute,
  restoreActiveDataset,
  RECOMPUTE_DEBOUNCE_MS,
  type RecomputeHandle,
} from "./recompute";

export {
  applySlice,
  resolveDateRange,
  type ResolvedDateRange,
} from "./slice-filter";
