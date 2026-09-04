import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { groupRecords, type GroupGranularity } from "./group";
import { UNKNOWN_MEMBER } from "@/registry/dimensions";
import type {
  AppAssignment,
  DimensionId,
  KPIRecord,
  TimeBucket,
} from "@/models";

const DIMENSION_IDS: readonly DimensionId[] = [
  "platform",
  "network",
  "cdn",
  "geography",
  "streamType",
];

/**
 * Local KPIRecord arbitrary — intentionally NOT importing the shared
 * arbitraries module. Only the fields grouping reads are modeled: `app`,
 * `bucket` (hour/day), and a partial `dimensions` map. Dimension values are
 * drawn from a tiny pool that includes both real members and the "missing"
 * cases (absent key and empty string) so the Unknown path is exercised often.
 */

const dimensionValueArb = fc.oneof(
  fc.constantFrom("iOS", "Android", "Wi-Fi", "Akamai", "Country", "VOD Movies"),
  fc.constant(""), // empty -> should map to Unknown
);

// A partial dimensions map: each dimension is independently present or absent,
// and present values may be empty (a "missing" value that maps to Unknown).
const dimensionsArb: fc.Arbitrary<Partial<Record<DimensionId, string>>> =
  fc.record(
    Object.fromEntries(
      DIMENSION_IDS.map((id) => [id, fc.option(dimensionValueArb, { nil: undefined })]),
    ) as Record<DimensionId, fc.Arbitrary<string | undefined>>,
    { requiredKeys: [] },
  ) as fc.Arbitrary<Partial<Record<DimensionId, string>>>;

// A small set of buckets so records genuinely collide across time periods.
const bucketArb: fc.Arbitrary<TimeBucket> = fc.constantFrom<TimeBucket[]>(
  { hourUtc: "2025-03-14T09:00:00Z", dayUtc: "2025-03-14" },
  { hourUtc: "2025-03-14T10:00:00Z", dayUtc: "2025-03-14" },
  { hourUtc: "2025-03-15T09:00:00Z", dayUtc: "2025-03-15" },
);

const appArb: fc.Arbitrary<AppAssignment> = fc.constantFrom<AppAssignment[]>(
  "App_A",
  "App_B",
);

function makeRecord(
  id: string,
  app: AppAssignment,
  bucket: TimeBucket,
  dimensions: Partial<Record<DimensionId, string>>,
): KPIRecord {
  return {
    id,
    datasetId: "ds",
    app,
    timestampUtc: bucket.hourUtc,
    sourceUtcOffsetMinutes: null,
    bucket,
    origin: "file",
    dimensions: dimensions as KPIRecord["dimensions"],
  };
}

// Records: each carries a unique id (its index) so we can track identity across
// the partition without relying on object equality.
const recordsArb: fc.Arbitrary<KPIRecord[]> = fc
  .array(fc.tuple(appArb, bucketArb, dimensionsArb), { maxLength: 40 })
  .map((rows) =>
    rows.map(([app, bucket, dims], i) => makeRecord(String(i), app, bucket, dims)),
  );

const slicedDimensionsArb: fc.Arbitrary<DimensionId[]> = fc.subarray([
  ...DIMENSION_IDS,
]);

const granularityArb: fc.Arbitrary<GroupGranularity> = fc.constantFrom(
  "hour",
  "day",
);

// Feature: ott-kpi-benchmarking-engine, Property 7: For any set of records, grouping by (app, timePeriod, dimension tags) produces disjoint groups whose union is exactly the set of valid records — no record is lost or duplicated — and any record missing a sliced dimension is placed in that dimension's "Unknown" group.
describe("groupRecords — Property 7: grouping partition", () => {
  it("produces disjoint groups whose union is exactly the input, with missing sliced dimensions in Unknown", () => {
    fc.assert(
      fc.property(
        recordsArb,
        slicedDimensionsArb,
        granularityArb,
        (records, sliced, granularity) => {
          const groups = groupRecords(records, sliced, granularity);

          // Deduplicate sliced dimensions the same way the implementation does
          // (order-preserving, first occurrence wins) to reason about the key.
          const uniqueSliced: DimensionId[] = [];
          const seenDim = new Set<DimensionId>();
          for (const id of sliced) {
            if (!seenDim.has(id)) {
              seenDim.add(id);
              uniqueSliced.push(id);
            }
          }

          // --- Union equals input: no record lost or duplicated. ---
          const collectedIds = groups
            .flatMap((g) => g.records.map((r) => r.id))
            .sort();
          const inputIds = records.map((r) => r.id).sort();
          expect(collectedIds).toEqual(inputIds);

          // --- Disjoint groups: each id appears in exactly one group. ---
          expect(new Set(collectedIds).size).toBe(collectedIds.length);

          // Per-record checks: every record lands where its key says it should,
          // and the group's key values match every record inside it.
          const idToRecord = new Map(records.map((r) => [r.id, r]));

          for (const group of groups) {
            const { app, timePeriod, dimensions: tags } = group.key;

            // A group is never empty.
            expect(group.records.length).toBeGreaterThan(0);

            for (const rec of group.records) {
              const original = idToRecord.get(rec.id)!;
              expect(original).toBeDefined();

              // App and time period must match the group key.
              expect(rec.app).toBe(app);
              const expectedPeriod =
                granularity === "hour"
                  ? original.bucket.hourUtc
                  : original.bucket.dayUtc;
              expect(timePeriod).toBe(expectedPeriod);

              // For each sliced dimension, the group tag must equal the record's
              // value, with missing/empty mapping to Unknown (Req 16.2).
              for (const dim of uniqueSliced) {
                const raw = original.dimensions?.[dim];
                const expectedTag =
                  raw == null || raw === "" ? UNKNOWN_MEMBER : raw;
                expect(tags[dim]).toBe(expectedTag);
              }
            }

            // The key exposes exactly the sliced dimensions, nothing more.
            expect(Object.keys(tags).sort()).toEqual([...uniqueSliced].sort());
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
