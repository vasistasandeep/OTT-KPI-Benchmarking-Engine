/**
 * The Comlink RPC contract shared between the main thread and the aggregation
 * Web Worker (design "Web Worker offloading", Req 17.2-17.4).
 *
 * The worker exposes the same two pure operations as the in-thread engine —
 * `aggregate` and `compare` — but marshals their inputs and outputs across the
 * worker boundary via structured clone. Because Comlink cannot transfer a live
 * callback synchronously in the return path, progress is delivered through a
 * caller-supplied `Comlink.proxy`-wrapped callback (`onProgress`) rather than
 * through the resolved value.
 *
 * Keeping this contract in its own module (with no worker-only globals) lets the
 * main-thread `WorkerAggregationEngine` and the worker entry point share the
 * exact same types without either pulling the other's runtime in.
 */

import type {
  IngestionMode,
  KPIRecord,
} from "@/models/records";
import type {
  AggregatedResultSet,
  ComparisonResultSet,
} from "@/models/results";
import type { SLAConfig } from "@/models/config";
import type { KPIDefinition } from "@/registry/kpi-types";

/**
 * A single progress update emitted while a long-running aggregation runs, so the
 * UI can name the operation in progress (Req 17.3). `fraction` is a monotonic
 * `0..1` completion estimate; `phase` names the current stage of the pipeline.
 */
export interface AggregationProgress {
  /** The stage of the aggregation pipeline currently running. */
  phase: "aggregate" | "compare";
  /** A human-readable label for the operation, for the progress indicator. */
  label: string;
  /** Monotonic completion estimate in the closed interval `[0, 1]`. */
  fraction: number;
}

/** A progress callback; when marshalled to the worker it is a Comlink proxy. */
export type ProgressCallback = (progress: AggregationProgress) => void;

/**
 * The methods the worker exposes over Comlink. The signatures mirror
 * {@link import("@/engine/aggregation-engine").AggregationEngine} but add an
 * optional `onProgress` callback, since the worker cannot otherwise report
 * intermediate progress across the RPC boundary.
 */
export interface AggregationWorkerApi {
  aggregate(
    records: KPIRecord[],
    mode: IngestionMode,
    kpis: KPIDefinition[],
    onProgress?: ProgressCallback,
  ): AggregatedResultSet;
  compare(
    agg: AggregatedResultSet,
    sla: SLAConfig,
    kpis: KPIDefinition[],
    onProgress?: ProgressCallback,
  ): ComparisonResultSet;
}

/**
 * The record-count threshold above which a `Raw_Session` aggregation is pushed
 * to the Web Worker (design "Web Worker offloading", Req 17.4). At or below it,
 * the same pure functions run synchronously on the main thread.
 */
export const WORKER_RECORD_THRESHOLD = 25_000;

/**
 * Whether an aggregation of `records` in `mode` should run in the Web Worker.
 * Only `Raw_Session` datasets strictly larger than {@link WORKER_RECORD_THRESHOLD}
 * qualify; pre-aggregated data and small raw datasets stay synchronous so the
 * common recompute path never pays the marshalling cost (Req 17.4).
 */
export function shouldUseWorker(
  mode: IngestionMode,
  recordCount: number,
): boolean {
  return mode === "Raw_Session" && recordCount > WORKER_RECORD_THRESHOLD;
}
