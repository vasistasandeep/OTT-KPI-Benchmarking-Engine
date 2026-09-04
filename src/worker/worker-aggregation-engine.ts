/**
 * `WorkerAggregationEngine` — the worker-backed implementation of the
 * aggregation engine (design "Web Worker offloading", Req 17.2-17.4).
 *
 * It satisfies the same *shape* as the pure `AggregationEngine` (`aggregate` /
 * `compare`) but returns Promises, because a Web Worker call is inherently
 * asynchronous. To keep the engine and its tests running identically with or
 * without a worker, the constructor performs an **environment-aware execution
 * switch**: when `typeof Worker === "undefined"` — as under Vitest/jsdom or any
 * host lacking Web Worker support — it transparently runs the *identical* pure
 * functions synchronously on the calling thread and resolves the same result.
 * Callers get one async contract regardless of the environment (Req 17.2).
 *
 * The store selects between this and the synchronous in-thread engine with
 * {@link shouldUseWorker}: only a `Raw_Session` slice larger than
 * {@link WORKER_RECORD_THRESHOLD} pays the marshalling cost so the main thread
 * stays at 60 FPS; everything else runs synchronously (Req 17.4).
 */

import * as Comlink from "comlink";

import { aggregate as aggregateInThread, compare as compareInThread } from "@/engine/aggregation-engine";
import type {
  AggregationWorkerApi,
  ProgressCallback,
} from "./aggregation-worker-api";
import { shouldUseWorker, WORKER_RECORD_THRESHOLD } from "./aggregation-worker-api";
import type { IngestionMode, KPIRecord } from "@/models/records";
import type {
  AggregatedResultSet,
  ComparisonResultSet,
} from "@/models/results";
import type { SLAConfig } from "@/models/config";
import type { KPIDefinition } from "@/registry/kpi-types";

export type { AggregationProgress, ProgressCallback } from "./aggregation-worker-api";
export { shouldUseWorker, WORKER_RECORD_THRESHOLD } from "./aggregation-worker-api";

/**
 * The async engine contract the worker path exposes. It mirrors the synchronous
 * `AggregationEngine` but resolves through Promises and accepts an optional
 * progress callback per call, since a worker cannot report progress any other
 * way (Req 17.3).
 */
export interface AsyncAggregationEngine {
  aggregate(
    records: KPIRecord[],
    mode: IngestionMode,
    kpis: KPIDefinition[],
    onProgress?: ProgressCallback,
  ): Promise<AggregatedResultSet>;
  compare(
    agg: AggregatedResultSet,
    sla: SLAConfig,
    kpis: KPIDefinition[],
    onProgress?: ProgressCallback,
  ): Promise<ComparisonResultSet>;
}

/** Whether the current environment can host a dedicated Web Worker. */
export function isWorkerSupported(): boolean {
  return typeof Worker !== "undefined";
}

/**
 * Construct the actual `Worker` for the Comlink proxy. Kept in a factory so it
 * is only invoked when a worker is genuinely supported, and so the URL/`import`
 * expression that Vite statically analyses lives in exactly one place.
 */
function spawnWorker(): Worker {
  return new Worker(new URL("./aggregation.worker.ts", import.meta.url), {
    type: "module",
    name: "aggregation-worker",
  });
}

export class WorkerAggregationEngine implements AsyncAggregationEngine {
  /** The Comlink proxy to the worker, created lazily on first use. */
  private proxy: Comlink.Remote<AggregationWorkerApi> | null = null;
  /** The underlying worker, retained so {@link terminate} can dispose it. */
  private worker: Worker | null = null;
  /** True when no worker is available and we run the pure functions inline. */
  private readonly fallback: boolean;

  /**
   * @param forceFallback force the synchronous in-thread path even where a
   *   worker would be available (primarily to exercise the fallback in tests).
   */
  constructor(forceFallback = false) {
    this.fallback = forceFallback || !isWorkerSupported();
  }

  /** Whether this engine is running in synchronous in-thread fallback mode. */
  get isFallback(): boolean {
    return this.fallback;
  }

  /** Lazily create (once) and return the Comlink proxy to the worker. */
  private getProxy(): Comlink.Remote<AggregationWorkerApi> {
    if (!this.proxy) {
      this.worker = spawnWorker();
      this.proxy = Comlink.wrap<AggregationWorkerApi>(this.worker);
    }
    return this.proxy;
  }

  async aggregate(
    records: KPIRecord[],
    mode: IngestionMode,
    kpis: KPIDefinition[],
    onProgress?: ProgressCallback,
  ): Promise<AggregatedResultSet> {
    if (this.fallback) {
      // Identical pure code path, run inline so results match the worker.
      onProgress?.({ phase: "aggregate", label: `Aggregating ${records.length} records`, fraction: 0 });
      const result = aggregateInThread(records, mode, kpis);
      onProgress?.({ phase: "aggregate", label: `Aggregated ${records.length} records`, fraction: 1 });
      return result;
    }
    // Comlink cannot clone a raw function; wrap the callback in a proxy so the
    // worker can invoke it back on the main thread (Req 17.3).
    const cb = onProgress ? Comlink.proxy(onProgress) : undefined;
    return this.getProxy().aggregate(records, mode, kpis, cb);
  }

  async compare(
    agg: AggregatedResultSet,
    sla: SLAConfig,
    kpis: KPIDefinition[],
    onProgress?: ProgressCallback,
  ): Promise<ComparisonResultSet> {
    if (this.fallback) {
      onProgress?.({ phase: "compare", label: "Comparing App_A vs App_B", fraction: 0 });
      const result = compareInThread(agg, sla, kpis);
      onProgress?.({ phase: "compare", label: "Comparison complete", fraction: 1 });
      return result;
    }
    const cb = onProgress ? Comlink.proxy(onProgress) : undefined;
    return this.getProxy().compare(agg, sla, kpis, cb);
  }

  /** Tear down the worker and release the proxy. Safe to call when unused. */
  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.proxy = null;
  }
}
