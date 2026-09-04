/**
 * The dedicated aggregation Web Worker (design "Web Worker offloading",
 * Req 17.2-17.4).
 *
 * It wraps the *pure* engine functions (`aggregate`, `compare` from
 * `@/engine/aggregation-engine`) — the identical code the in-thread path runs —
 * and exposes them over Comlink so the main thread can offload a large
 * `Raw_Session` job without blocking. No formula lives here; the worker only
 * marshals inputs in, runs the shared pipeline, emits progress, and marshals the
 * result out (Req 17.2).
 *
 * Progress is reported through the caller-supplied `onProgress` proxy rather
 * than the return value, because Comlink resolves a method call once with a
 * single value and cannot stream intermediate updates otherwise (Req 17.3).
 *
 * Vite bundles this module as an ES worker (see `worker.format: "es"` in
 * vite.config.ts); it is instantiated on the main thread with
 * `new Worker(new URL("./aggregation.worker.ts", import.meta.url), { type: "module" })`.
 */

import * as Comlink from "comlink";

import { aggregate, compare } from "@/engine/aggregation-engine";
import type {
  AggregationWorkerApi,
  ProgressCallback,
} from "./aggregation-worker-api";
import type { IngestionMode, KPIRecord } from "@/models/records";
import type {
  AggregatedResultSet,
  ComparisonResultSet,
} from "@/models/results";
import type { SLAConfig } from "@/models/config";
import type { KPIDefinition } from "@/registry/kpi-types";

/** Emit a progress update, tolerating an absent callback. */
function report(
  onProgress: ProgressCallback | undefined,
  phase: "aggregate" | "compare",
  label: string,
  fraction: number,
): void {
  onProgress?.({ phase, label, fraction });
}

/**
 * The worker-side implementation of {@link AggregationWorkerApi}. It brackets
 * each pure call with a start (0) and finish (1) progress message so the UI can
 * show, then dismiss, the indicator; the pure functions themselves are
 * synchronous and uninterruptible, so intermediate fractions are not available.
 */
const api: AggregationWorkerApi = {
  aggregate(
    records: KPIRecord[],
    mode: IngestionMode,
    kpis: KPIDefinition[],
    onProgress?: ProgressCallback,
  ): AggregatedResultSet {
    report(onProgress, "aggregate", `Aggregating ${records.length} records`, 0);
    const result = aggregate(records, mode, kpis);
    report(onProgress, "aggregate", `Aggregated ${records.length} records`, 1);
    return result;
  },

  compare(
    agg: AggregatedResultSet,
    sla: SLAConfig,
    kpis: KPIDefinition[],
    onProgress?: ProgressCallback,
  ): ComparisonResultSet {
    report(onProgress, "compare", "Comparing App_A vs App_B", 0);
    const result = compare(agg, sla, kpis);
    report(onProgress, "compare", "Comparison complete", 1);
    return result;
  },
};

Comlink.expose(api);
