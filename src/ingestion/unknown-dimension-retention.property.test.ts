/**
 * Property-based coverage for unknown-dimension-value retention at ingestion.
 *
 * Every slicing dimension is extensible: a dimension value that is not among a
 * dimension's seed members must still be kept on the record (the record is
 * never dropped for carrying an unfamiliar value) and must be surfaced as a
 * newly-appended member of that dimension (Req 2.7).
 *
 * This validates the already-implemented record builder
 * (`buildRecords` / `appendedMembers` in `record-builder.ts`) against the
 * dimension registry's seed members. It generates long-layout rows — one row
 * per app, so one row yields exactly one record — carrying a mix of seed and
 * novel dimension values, builds the records, and asserts:
 *
 *   1. every input row is retained as a record (none dropped for an unknown
 *      dimension value, and none rejected);
 *   2. every distinct dimension value present in the input appears after
 *      ingestion either as a seed member or in the `appendedMembers` output.
 *
 * Validates: Requirements 2.7
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { ColumnMapping } from "@/models/config";
import type { DimensionId } from "@/models/ids";
import {
  DIMENSION_REGISTRY,
  UNKNOWN_MEMBER,
  getDimensionDefinition,
} from "@/registry/dimensions";
import { buildRecords, type RecordBuildContext } from "./record-builder";
import type { ParsedRow } from "./file-parser";

const CTX: RecordBuildContext = { datasetId: "ds-dim", ingestionMode: "Pre_Aggregated" };

// Local arbitraries (do NOT edit the shared src/test/arbitraries.ts).

/** The dimension ids in the registry, used to slice each generated row. */
const DIMENSION_IDS: readonly DimensionId[] = DIMENSION_REGISTRY.map((d) => d.id);

/**
 * A bounded "novel" dimension value: a short alphanumeric token that is not one
 * of the dimension's seed members and is not the reserved "Unknown" member.
 * Bounding the string keeps generation fast and avoids fast-check hangs.
 */
function arbNovelMember(dimensionId: DimensionId): fc.Arbitrary<string> {
  const seed = new Set(getDimensionDefinition(dimensionId).members);
  return fc
    .string({
      minLength: 1,
      maxLength: 12,
      unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")),
    })
    .map((s) => `x_${s}`) // prefix guarantees it never collides with a seed member
    .filter((s) => s !== UNKNOWN_MEMBER && !seed.has(s));
}

/**
 * A dimension value for a given dimension: either drawn from that dimension's
 * seed members or a bounded novel value. Mixing both exercises the "known value
 * is not re-reported / unknown value is appended" split.
 */
function arbDimensionValue(dimensionId: DimensionId): fc.Arbitrary<string> {
  const seedMembers = getDimensionDefinition(dimensionId).members;
  return fc.oneof(
    fc.constantFrom(...seedMembers),
    arbNovelMember(dimensionId),
  );
}

/** The app tag for a row; a recognized value so the row is never rejected. */
const arbApp = fc.constantFrom("App_A", "App_B");

/** A finite, bounded, non-negative metric value (keeps arithmetic stable). */
const arbMetric = fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true });

/**
 * A single source row carrying a valid timestamp, a recognized app, one KPI
 * value, and a value for every dimension. Bounded fields throughout.
 */
const arbRow: fc.Arbitrary<ParsedRow> = fc
  .record({
    app: arbApp,
    metric: arbMetric,
    dims: fc.record(
      Object.fromEntries(
        DIMENSION_IDS.map((id) => [id, arbDimensionValue(id)] as const),
      ) as Record<DimensionId, fc.Arbitrary<string>>,
    ),
  })
  .map(({ app, metric, dims }) => {
    const row: ParsedRow = {
      date: "2025-03-14",
      app,
      ad_fill_rate: String(metric),
    };
    for (const id of DIMENSION_IDS) row[id] = (dims as Record<DimensionId, string>)[id];
    return row;
  });

/** A bounded set of rows: 1..30 keeps each run fast while covering many values. */
const arbRows: fc.Arbitrary<ParsedRow[]> = fc.array(arbRow, { minLength: 1, maxLength: 30 });

/** A long-layout mapping with the timestamp, app, one KPI, and every dimension. */
function longMappingAllDimensions(): ColumnMapping {
  const assignments: ColumnMapping["assignments"] = {
    date: { kind: "timestamp" },
    app: { kind: "app" },
    ad_fill_rate: { kind: "kpi", kpiId: "ad_fill_rate" },
  };
  for (const id of DIMENSION_IDS) {
    assignments[id] = { kind: "dimension", dimensionId: id };
  }
  return {
    headerSetHash: "hash-all-dims",
    headers: ["date", "app", "ad_fill_rate", ...DIMENSION_IDS],
    assignments,
    units: {},
    layout: "long",
    ingestionMode: "Pre_Aggregated",
  };
}

// Feature: ott-kpi-benchmarking-engine, Property 13: For any set of ingested records containing arbitrary dimension values, every record is retained and every distinct dimension value present in the input appears as a member of the corresponding dimension after ingestion.
describe("RecordBuilder — Property 13: unknown-dimension retention", () => {
  it("retains every row and surfaces every distinct dimension value (Req 2.7)", () => {
    const mapping = longMappingAllDimensions();

    fc.assert(
      fc.property(arbRows, (rows) => {
        const { records, rejected, appendedMembers } = buildRecords(rows, mapping, CTX);

        // 1. Every input row is retained as exactly one record; none dropped for
        //    an unknown dimension value, and none structurally rejected.
        expect(rejected).toEqual([]);
        expect(records).toHaveLength(rows.length);

        // The set of appended (unknown) members, keyed by dimension, for lookup.
        const appendedByDim = new Map<DimensionId, Set<string>>();
        for (const { dimensionId, member } of appendedMembers) {
          let set = appendedByDim.get(dimensionId);
          if (!set) appendedByDim.set(dimensionId, (set = new Set()));
          set.add(member);
        }

        // 2. Every distinct dimension value present in the input appears after
        //    ingestion either as a seed member or as an appended member.
        for (const id of DIMENSION_IDS) {
          const seed = new Set(getDimensionDefinition(id).members);
          const appended = appendedByDim.get(id) ?? new Set<string>();
          const inputValues = new Set(rows.map((r) => r[id]));

          for (const value of inputValues) {
            const known = seed.has(value) || appended.has(value);
            expect(known).toBe(true);
          }

          // A seed value is never re-reported as a newly appended member, and a
          // novel value is always reported exactly once.
          for (const value of inputValues) {
            if (seed.has(value)) {
              expect(appended.has(value)).toBe(false);
            } else {
              expect(appended.has(value)).toBe(true);
            }
          }
        }

        // Each retained record keeps its dimension values verbatim.
        records.forEach((record) => {
          for (const id of DIMENSION_IDS) {
            expect(typeof record.dimensions[id]).toBe("string");
          }
        });
      }),
      { numRuns: 100 },
    );
  });
});
