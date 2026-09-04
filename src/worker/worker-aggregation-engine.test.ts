/**
 * Unit tests for the worker-backed aggregation engine (task 9.1).
 *
 * These do NOT spin up a real Web Worker: jsdom exposes no `Worker` global, so
 * the engine's environment-aware execution switch runs the identical pure
 * functions synchronously in-thread. That is exactly the property under test —
 * the engine and its results must be identical with or without a worker
 * (Req 17.2) — plus the threshold logic that decides when a worker would be
 * used at all (Req 17.4) and the progress emission (Req 17.3).
 */

import { describe, it, expect, vi } from "vitest";
import {
  WorkerAggregationEngine,
  isWorkerSupported,
  shouldUseWorker,
  WORKER_RECORD_THRESHOLD,
  type AggregationProgress,
} from "./worker-aggregation-engine";
import { aggregate, compare } from "@/engine/aggregation-engine";
import { KPI_BY_ID } from "@/registry/kpi-registry";
import type { KPIDefinition } from "@/registry/kpi-types";
import type {
  AppAssignment,
  KPIRecord,
  RawSessionFields,
  TimeBucket,
} from "@/models/records";
import type { CanonicalKPIId } from "@/models/ids";
import type { SLAConfig } from "@/models/config";

// ---------------------------------------------------------------------------
// Builders (mirroring the in-thread engine suite conventions)
// ---------------------------------------------------------------------------

const DAY_1: TimeBucket = { hourUtc: "2025-03-14T09:00:00Z", dayUtc: "2025-03-14" };
const SLA: SLAConfig = { varianceBand: 1.5, thresholds: {}, minSampleSize: 0 };

let seq = 0;
function rawRecord(app: AppAssignment, session: RawSessionFields): KPIRecord {
  seq += 1;
  return {
    id: `r${seq}`,
    datasetId: "ds",
    app,
    timestampUtc: DAY_1.hourUtc,
    sourceUtcOffsetMinutes: null,
    bucket: DAY_1,
    origin: "file",
    dimensions: {} as KPIRecord["dimensions"],
    session,
  };
}

function only(...ids: CanonicalKPIId[]): KPIDefinition[] {
  return ids.map((id) => KPI_BY_ID[id]);
}

// ---------------------------------------------------------------------------
// Environment switch: jsdom has no Worker, so we take the fallback path.
// ---------------------------------------------------------------------------

describe("environment-aware execution switch (Req 17.2)", () => {
  it("reports no Worker support under jsdom", () => {
    expect(isWorkerSupported()).toBe(false);
  });

  it("constructs in fallback mode when no Worker is available", () => {
    const engine = new WorkerAggregationEngine();
    expect(engine.isFallback).toBe(true);
  });

  it("honours a forced fallback even where a worker might exist", () => {
    const engine = new WorkerAggregationEngine(true);
    expect(engine.isFallback).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fallback produces identical results to the pure in-thread engine (Req 17.2)
// ---------------------------------------------------------------------------

describe("in-thread fallback parity (Req 17.2)", () => {
  const records: KPIRecord[] = [
    rawRecord("App_A", { startFailure: 1, playbackAttempt: 1 }),
    rawRecord("App_A", { startFailure: 0, playbackAttempt: 1 }),
    rawRecord("App_B", { startFailure: 0, playbackAttempt: 1 }),
  ];
  const kpis = only("vsf");

  it("aggregate resolves to the same result as the pure aggregate()", async () => {
    const engine = new WorkerAggregationEngine();
    const viaEngine = await engine.aggregate(records, "Raw_Session", kpis);
    const direct = aggregate(records, "Raw_Session", kpis);
    expect(viaEngine).toEqual(direct);
  });

  it("compare resolves to the same result as the pure compare()", async () => {
    const engine = new WorkerAggregationEngine();
    const agg = await engine.aggregate(records, "Raw_Session", kpis);
    const viaEngine = await engine.compare(agg, SLA, kpis);
    const direct = compare(aggregate(records, "Raw_Session", kpis), SLA, kpis);
    expect(viaEngine).toEqual(direct);
  });

  it("emits start and completion progress for aggregate (Req 17.3)", async () => {
    const engine = new WorkerAggregationEngine();
    const updates: AggregationProgress[] = [];
    await engine.aggregate(records, "Raw_Session", kpis, (p) => updates.push(p));

    expect(updates.map((u) => u.fraction)).toEqual([0, 1]);
    expect(updates.every((u) => u.phase === "aggregate")).toBe(true);
    expect(updates[0].label).toContain(String(records.length));
  });

  it("emits progress for compare too (Req 17.3)", async () => {
    const engine = new WorkerAggregationEngine();
    const onProgress = vi.fn();
    const agg = await engine.aggregate(records, "Raw_Session", kpis);
    await engine.compare(agg, SLA, kpis, onProgress);

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "compare", fraction: 1 }),
    );
  });

  it("terminate is a safe no-op when no worker was ever spawned", () => {
    const engine = new WorkerAggregationEngine();
    expect(() => engine.terminate()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Threshold switch: only raw sessions above 25,000 records use the worker.
// ---------------------------------------------------------------------------

describe("worker offload threshold (Req 17.4)", () => {
  it("pins the threshold at 25,000 records", () => {
    expect(WORKER_RECORD_THRESHOLD).toBe(25_000);
  });

  it("uses the worker only for Raw_Session strictly above the threshold", () => {
    expect(shouldUseWorker("Raw_Session", WORKER_RECORD_THRESHOLD + 1)).toBe(true);
  });

  it("stays synchronous for a Raw_Session slice exactly at the threshold", () => {
    expect(shouldUseWorker("Raw_Session", WORKER_RECORD_THRESHOLD)).toBe(false);
  });

  it("stays synchronous for a Raw_Session slice below the threshold", () => {
    expect(shouldUseWorker("Raw_Session", 100)).toBe(false);
  });

  it("never offloads Pre_Aggregated data, however large", () => {
    expect(shouldUseWorker("Pre_Aggregated", WORKER_RECORD_THRESHOLD + 500_000)).toBe(false);
  });
});
