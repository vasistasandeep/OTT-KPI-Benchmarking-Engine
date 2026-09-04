/**
 * Sanity unit tests for the MappingCache (Req 7.6, 7.7).
 *
 * The exhaustive round-trip / header-order-independence property lives in task
 * 11.7 (design Property 15). These pin the core behaviours: the reuse key is a
 * hash of the sorted, normalized header set (so column order and cosmetic
 * header variants do not matter), persisting then looking up round-trips the
 * decision set, and a cached `fileAppAssignment` is surfaced for re-prompt
 * rather than silently reapplied.
 */

import { describe, it, expect } from "vitest";
import type { CanonicalKPIId } from "@/models/ids";
import type { ColumnMapping } from "@/models/config";
import { InMemoryKPIRepository } from "@/repository/InMemoryKPIRepository";
import { computeHeaderSetHash, persistMapping, lookupMapping } from "./mapping-cache";

const VST = "vst_p50" as CanonicalKPIId;

function makeMapping(overrides: Partial<ColumnMapping> = {}): ColumnMapping {
  return {
    headerSetHash: "unset",
    headers: ["vst_ms", "app", "ts"],
    assignments: {
      vst_ms: { kind: "kpi", kpiId: VST },
      app: { kind: "app" },
      ts: { kind: "timestamp" },
    },
    units: { vst_ms: "ms" },
    layout: "long",
    ingestionMode: "Pre_Aggregated",
    ...overrides,
  };
}

describe("computeHeaderSetHash — sorted, normalized header set (Req 7.6, 7.7)", () => {
  it("is independent of header order", () => {
    expect(computeHeaderSetHash(["vst_ms", "app", "ts"])).toBe(
      computeHeaderSetHash(["ts", "vst_ms", "app"]),
    );
  });

  it("normalizes cosmetic header variants to the same key", () => {
    // normalizeHeader lowercases, strips punctuation, and splits camel/snake.
    expect(computeHeaderSetHash(["video_start_time"])).toBe(
      computeHeaderSetHash(["videoStartTime"]),
    );
  });

  it("collapses duplicate headers (a header set is a set)", () => {
    expect(computeHeaderSetHash(["app", "app", "ts"])).toBe(computeHeaderSetHash(["app", "ts"]));
  });

  it("distinguishes genuinely different header sets", () => {
    expect(computeHeaderSetHash(["vst_ms", "app"])).not.toBe(
      computeHeaderSetHash(["vst_ms", "app", "ts"]),
    );
  });

  it("produces a fixed-width 8-char hex key", () => {
    expect(computeHeaderSetHash(["vst_ms", "app", "ts"])).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("persistMapping / lookupMapping round-trip (Req 7.6, 7.7)", () => {
  it("persists under the derived key and looks up by an out-of-order header set", async () => {
    const repo = new InMemoryKPIRepository();
    const mapping = makeMapping();

    const key = await persistMapping(repo, mapping);
    expect(key).toBe(computeHeaderSetHash(mapping.headers));

    const reused = await lookupMapping(repo, ["ts", "app", "vst_ms"]);
    expect(reused).not.toBeNull();
    expect(reused!.mapping.assignments).toEqual(mapping.assignments);
    expect(reused!.mapping.units).toEqual(mapping.units);
    expect(reused!.mapping.layout).toBe("long");
    // The persisted key is derived from the headers, overriding the input.
    expect(reused!.mapping.headerSetHash).toBe(key);
  });

  it("returns null when no cached mapping matches the header set", async () => {
    const repo = new InMemoryKPIRepository();
    await persistMapping(repo, makeMapping());
    expect(await lookupMapping(repo, ["totally", "different"])).toBeNull();
  });

  it("surfaces a cached fileAppAssignment for re-prompt instead of reapplying it (Req 7.7)", async () => {
    const repo = new InMemoryKPIRepository();
    const mapping = makeMapping({
      headers: ["vst_ms", "ts"],
      assignments: {
        vst_ms: { kind: "kpi", kpiId: VST },
        ts: { kind: "timestamp" },
      },
      fileAppAssignment: "App_A",
    });

    await persistMapping(repo, mapping);
    const reused = await lookupMapping(repo, ["vst_ms", "ts"]);

    expect(reused).not.toBeNull();
    // Pre-selected default, surfaced separately for confirmation...
    expect(reused!.suggestedFileAppAssignment).toBe("App_A");
    // ...and NOT baked back into the reused mapping.
    expect(reused!.mapping.fileAppAssignment).toBeUndefined();
  });

  it("omits the suggested app assignment when the cached mapping had none", async () => {
    const repo = new InMemoryKPIRepository();
    await persistMapping(repo, makeMapping());
    const reused = await lookupMapping(repo, ["vst_ms", "app", "ts"]);

    expect(reused).not.toBeNull();
    expect(reused!.suggestedFileAppAssignment).toBeUndefined();
  });
});
