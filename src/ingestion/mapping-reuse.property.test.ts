/**
 * Property-based coverage for mapping-reuse round-tripping (Req 7.6, 7.7).
 *
 * Records the reuse guarantee the MappingCache must uphold: a confirmed column
 * mapping, once persisted, is recovered by querying with the *same header set
 * in any order*, because the reuse key is a hash of the sorted, normalized
 * header set. Header order is therefore irrelevant to a cache hit, and the
 * recovered decision set (assignments, units, layout) is equivalent to what was
 * saved.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { ColumnMapping, MappingTarget } from "@/models/config";
import type { AppAssignment, IngestionMode } from "@/models/records";
import { InMemoryKPIRepository } from "@/repository/InMemoryKPIRepository";
import { persistMapping, lookupMapping } from "./mapping-cache";
import { arbHeader } from "@/test/arbitraries";

// The shared `arbHeader` (src/test/arbitraries.ts) generates source headers;
// the remaining arbitraries below are local to this reuse round-trip property.

/** A small set of distinct headers (a header set is a set, so de-duplicated). */
const arbHeaderSet: fc.Arbitrary<string[]> = fc
  .uniqueArray(arbHeader, { minLength: 1, maxLength: 12 })
  .filter((hs) => hs.length > 0);

/** A random mapping target for a column, spanning every target kind. */
const arbTarget: fc.Arbitrary<MappingTarget> = fc.oneof(
  fc
    .tuple(
      fc.constantFrom(
        "vst_p50",
        "rebuffer_ratio",
        "vsf",
        "dau",
        "arpu",
        "ttfb",
      ) as fc.Arbitrary<never>,
      fc.option(fc.constantFrom<AppAssignment>("App_A", "App_B"), { nil: undefined }),
    )
    .map(([kpiId, app]) =>
      app !== undefined
        ? ({ kind: "kpi", kpiId, app } as MappingTarget)
        : ({ kind: "kpi", kpiId } as MappingTarget),
    ),
  fc
    .constantFrom("platform", "network", "cdn", "geography", "streamType")
    .map((dimensionId) => ({ kind: "dimension", dimensionId } as MappingTarget)),
  fc.constant({ kind: "app" } as MappingTarget),
  fc.constant({ kind: "timestamp" } as MappingTarget),
  fc.constant({ kind: "volumeWeight" } as MappingTarget),
  fc.constant({ kind: "userId" } as MappingTarget),
  fc.constant({ kind: "unmapped" } as MappingTarget),
);

/** A confirmed ColumnMapping built over a random header set. */
const arbColumnMapping: fc.Arbitrary<ColumnMapping> = arbHeaderSet.chain((headers) =>
  fc
    .record({
      targets: fc.array(arbTarget, { minLength: headers.length, maxLength: headers.length }),
      units: fc.array(fc.constantFrom("ms", "s", "%", "count", ""), {
        minLength: headers.length,
        maxLength: headers.length,
      }),
      layout: fc.constantFrom<"long" | "wide">("long", "wide"),
      fileAppAssignment: fc.option(fc.constantFrom<AppAssignment>("App_A", "App_B"), {
        nil: undefined,
      }),
      ingestionMode: fc.constantFrom<IngestionMode>("Pre_Aggregated", "Raw_Session"),
    })
    .map(({ targets, units, layout, fileAppAssignment, ingestionMode }) => {
      const assignments: Record<string, MappingTarget> = {};
      const unitMap: Record<string, string> = {};
      headers.forEach((h, i) => {
        assignments[h] = targets[i];
        unitMap[h] = units[i];
      });
      const mapping: ColumnMapping = {
        // headerSetHash is (re)derived on persist from `headers`, so a bogus
        // placeholder here must not survive the round-trip.
        headerSetHash: "placeholder",
        headers: [...headers],
        assignments,
        units: unitMap,
        layout,
        ingestionMode,
        ...(fileAppAssignment !== undefined ? { fileAppAssignment } : {}),
      };
      return mapping;
    }),
);

/** Fisher–Yates shuffle driven by a fast-check permutation seed. */
function shuffle<T>(items: readonly T[], swaps: readonly number[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = swaps[i - 1] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Feature: ott-kpi-benchmarking-engine, Property 15: For any confirmed column mapping, saving it and then querying by the same header set (in any order) returns an equivalent mapping, because the reuse key is a hash of the sorted, normalized header set.
describe("MappingCache — Property 15: mapping-reuse round-trip", () => {
  it("querying by the same header set in any order returns an equivalent mapping", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbColumnMapping,
        fc.array(fc.nat(), { minLength: 12, maxLength: 12 }),
        async (mapping, swaps) => {
          const repository = new InMemoryKPIRepository();

          const persistedHash = await persistMapping(repository, mapping);

          // Query with a shuffled copy of the very same headers.
          const shuffledHeaders = shuffle(mapping.headers, swaps);
          const reused = await lookupMapping(repository, shuffledHeaders);

          // The reuse key is order-independent: the shuffled header set still
          // produces a cache hit (a miss would return null here).
          expect(reused).not.toBeNull();
          const result = reused!;

          // The recovered decision set is equivalent to what was saved, with
          // fileAppAssignment lifted out for re-prompting (never silently
          // reapplied).
          expect(result.mapping.assignments).toEqual(mapping.assignments);
          expect(result.mapping.units).toEqual(mapping.units);
          expect(result.mapping.layout).toBe(mapping.layout);
          expect(result.mapping.ingestionMode).toBe(mapping.ingestionMode);
          expect(result.mapping.headerSetHash).toBe(persistedHash);
          expect(result.mapping.fileAppAssignment).toBeUndefined();
          expect(result.suggestedFileAppAssignment).toBe(mapping.fileAppAssignment);
        },
      ),
      { numRuns: 100 },
    );
  });
});
