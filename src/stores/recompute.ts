/**
 * The recompute pipeline that ties the state stores to the aggregation engine
 * (design "Recompute pipeline", task 14.1).
 *
 * A filter change triggers a **debounced (150 ms)** recompute (`scheduleRecompute`)
 * that, on the trailing edge:
 *   1. selects the active dataset from {@link useDatasetStore},
 *   2. applies the slice filter (inclusive UTC bucket boundaries, `7d`/`30d`
 *      presets resolved to explicit `from`/`to`) via `applySlice`,
 *   3. dispatches to the synchronous engine or the Web Worker — the worker is
 *      used only when `mode === "Raw_Session" && records.length > 25000`
 *      (`shouldUseWorker`), keeping the common path off the marshalling cost —
 *      and
 *   4. populates the result cache in {@link useResultStore}, including the
 *      no-data flag when the slice matched nothing (Req 10.5, 10.6, 17.2, 26.7).
 *
 * On load, {@link hydrate} restores the most recent dataset and the saved SLA
 * config from the repository, falling back to the mock demo dataset (seeded via
 * `seedMockDataset`) when no dataset exists yet (Req 3.3, 9.4). It wires a
 * subscription so subsequent filter changes recompute automatically, and runs
 * an initial recompute for the restored slice.
 *
 * This module is intentionally framework-agnostic: it manipulates the Zustand
 * stores directly and is driven by a React effect in the app shell. It runs
 * identically under Vitest because {@link WorkerAggregationEngine} transparently
 * falls back to synchronous in-thread execution where no worker exists.
 */

import type { KPIDataRepository } from "@/repository";
import type { Dataset } from "@/models/records";
import { seedMockDataset } from "@/ingestion/mock-seeder";
import { KPI_REGISTRY } from "@/registry/kpi-registry";
import type { KPIDefinition } from "@/registry/kpi-types";
import {
  WorkerAggregationEngine,
  shouldUseWorker,
} from "@/worker/worker-aggregation-engine";

import { useDatasetStore } from "./useDatasetStore";
import { useFilterStore } from "./useFilterStore";
import { useSLAStore } from "./useSLAStore";
import { useResultStore } from "./useResultStore";
import { applySlice } from "./slice-filter";
import { debounce } from "@/lib/debounce";

/** The debounce window for a filter-driven recompute (Req 10.5). */
export const RECOMPUTE_DEBOUNCE_MS = 150;

/**
 * A mutable snapshot of the KPI registry. The engine's `aggregate`/`compare`
 * signatures accept a mutable `KPIDefinition[]`; the registry is `readonly`, so
 * we hand the engine a shallow copy it never mutates.
 */
const KPIS: KPIDefinition[] = [...KPI_REGISTRY];

/**
 * A single shared engine instance. It routes each call to the Web Worker or an
 * in-thread synchronous run per {@link shouldUseWorker}, and self-selects the
 * synchronous fallback in environments without a Worker (jsdom/Vitest), so one
 * instance covers both the small-slice and large-raw-slice paths (Req 17.2).
 */
let engine: WorkerAggregationEngine | null = null;

/** Lazily construct (once) the shared engine. */
function getEngine(): WorkerAggregationEngine {
  if (!engine) {
    engine = new WorkerAggregationEngine();
  }
  return engine;
}

/**
 * Run one recompute *now* (no debounce). Selects the active dataset, applies the
 * live filter slice, dispatches to the engine (worker for large raw slices,
 * synchronous otherwise), and publishes the result to {@link useResultStore}.
 *
 * A missing active dataset yields an idle no-data state rather than an error.
 * A slice that matches no records publishes an empty result with `noData: true`
 * so every module renders its own no-data state (Req 10.6).
 *
 * @param nowMs reference "now" for preset resolution (test-injectable).
 */
export async function runRecompute(nowMs: number = Date.now()): Promise<void> {
  const dataset = useDatasetStore.getState().activeDataset;
  const { slice } = useFilterStore.getState();
  const sla = useSLAStore.getState().config;
  const results = useResultStore.getState();

  if (!dataset) {
    // Nothing loaded yet — surface an explicit no-data state, not an error.
    results.setResult({
      result: { results: [], slice },
      aggregated: { bySegment: new Map(), overall: [], unweightedAdvisory: false },
      noData: true,
      slice,
    });
    return;
  }

  results.beginCompute();

  // Step 2 — apply the slice filter (inclusive UTC boundaries, resolved presets).
  const sliced = applySlice(dataset.records, slice, nowMs);
  const mode = dataset.ingestionMode;

  try {
    const eng = getEngine();
    const onProgress = (p: Parameters<typeof results.setProgress>[0]) =>
      // Only surface progress for the worker path; the synchronous path
      // completes within a frame and does not need a visible indicator.
      shouldUseWorker(mode, sliced.length) ? results.setProgress(p) : undefined;

    // Step 3 — dispatch to the worker (large raw slices) or run synchronously.
    const aggregated = await eng.aggregate(sliced, mode, KPIS, onProgress);
    const comparison = await eng.compare(aggregated, sla, KPIS, onProgress);

    // Step 4 — populate the cache. The slice is empty when it matched nothing.
    const comparisonForSlice = { results: comparison.results, slice };
    results.setResult({
      result: comparisonForSlice,
      aggregated,
      noData: sliced.length === 0,
      slice,
    });
  } catch (cause) {
    results.setError(
      cause instanceof Error ? cause.message : "Recompute failed unexpectedly.",
    );
  }
}

/**
 * The debounced recompute trigger. A burst of filter changes collapses into a
 * single recompute {@link RECOMPUTE_DEBOUNCE_MS} after the last change (Req 10.5).
 */
export const scheduleRecompute = debounce(() => {
  void runRecompute();
}, RECOMPUTE_DEBOUNCE_MS);

/**
 * Select and load the dataset to restore on boot. Prefers the persisted active
 * dataset id; if that is absent or its dataset is gone, promotes the most
 * recently created stored dataset; if none exist, seeds and persists the mock
 * demo dataset (Req 3.3, 9.4).
 *
 * The chosen dataset becomes the active dataset in the repository too, so the
 * next boot restores the same selection.
 *
 * @param repository the ready {@link KPIDataRepository}.
 * @param nowMs      reference "now" for anchoring the demo fallback window; the
 *   seeded demo window ends on this UTC day so the default 7d/30d presets
 *   (which resolve relative to "now") overlap the demo records on first load.
 */
export async function restoreActiveDataset(
  repository: KPIDataRepository,
  nowMs: number = Date.now(),
): Promise<Dataset | null> {
  const activeId = await repository.getActiveDatasetId();
  if (activeId) {
    const active = await repository.getDataset(activeId);
    if (active) {
      return active;
    }
  }

  // No valid active pointer — promote the most recently created dataset.
  const metas = await repository.listDatasets();
  if (metas.length > 0) {
    const mostRecent = [...metas].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const promoted = await repository.getDataset(mostRecent.id);
    if (promoted) {
      await repository.setActiveDatasetId(promoted.id);
      return promoted;
    }
  }

  // Nothing stored at all — fall back to the seeded demo dataset (Req 9.4).
  // Anchor the demo window to "today" (UTC) so the default 7d/30d presets,
  // which resolve relative to the current date, overlap the seeded records on
  // first load. The seeder's own default window stays fixed for determinism;
  // only this app-boot fallback is now-anchored.
  const endDay = new Date(nowMs).toISOString().slice(0, 10);
  const demo = seedMockDataset({ endDay });
  await repository.saveDataset(demo);
  await repository.setActiveDatasetId(demo.id);
  return demo;
}

/** Handle returned by {@link hydrate} so callers can tear the wiring down. */
export interface RecomputeHandle {
  /** Unsubscribe the filter-change listener and cancel any pending recompute. */
  dispose(): void;
}

/**
 * Boot the recompute pipeline: restore the most recent dataset and the saved
 * SLA config from `repository` (demo fallback when none exists), subscribe to
 * filter changes so every subsequent change debounces into a recompute, and run
 * an initial recompute for the restored slice (Req 3.3, 9.4, 10.5).
 *
 * @param repository the ready {@link KPIDataRepository} from `createKPIRepository`.
 * @param nowMs      reference "now" for the initial preset resolution.
 * @returns a handle whose `dispose` unsubscribes and cancels pending work.
 */
export async function hydrate(
  repository: KPIDataRepository,
  nowMs: number = Date.now(),
): Promise<RecomputeHandle> {
  // Restore the saved SLA config (falls back to defaults inside the repo).
  const sla = await repository.getSLAConfig();
  useSLAStore.getState().setConfig(sla);

  // Restore (or seed) the active dataset and its metadata list.
  const dataset = await restoreActiveDataset(repository, nowMs);
  useDatasetStore.getState().setActiveDataset(dataset);
  useDatasetStore.getState().setDatasets(await repository.listDatasets());

  // Recompute on every subsequent filter change (debounced).
  const unsubscribe = useFilterStore.subscribe((state, prev) => {
    if (state.revision !== prev.revision) {
      scheduleRecompute();
    }
  });

  // Initial recompute for the restored slice, awaited so callers can render a
  // ready dashboard immediately after `hydrate` resolves.
  await runRecompute(nowMs);

  return {
    dispose: () => {
      unsubscribe();
      scheduleRecompute.cancel();
    },
  };
}
