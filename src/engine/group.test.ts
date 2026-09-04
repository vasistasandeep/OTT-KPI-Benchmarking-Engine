import { describe, it, expect } from "vitest";
import { groupRecords } from "./group";
import { UNKNOWN_MEMBER } from "@/registry/dimensions";
import type { AppAssignment, DimensionId, KPIRecord, TimeBucket } from "@/models";

/**
 * Minimal record builder; only the fields grouping reads are meaningful.
 * `dimensions` is accepted as a partial map to mirror real records that may not
 * carry a value for every dimension — the missing-dimension path is exactly
 * what grouping must handle (Req 16.2).
 */
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

const DAY_A: TimeBucket = { hourUtc: "2025-03-14T09:00:00Z", dayUtc: "2025-03-14" };
const DAY_A_HOUR_2: TimeBucket = { hourUtc: "2025-03-14T10:00:00Z", dayUtc: "2025-03-14" };
const DAY_B: TimeBucket = { hourUtc: "2025-03-15T09:00:00Z", dayUtc: "2025-03-15" };

describe("groupRecords", () => {
  it("partitions by app, day bucket, and sliced dimension tags", () => {
    const records: KPIRecord[] = [
      makeRecord("1", "App_A", DAY_A, { platform: "iOS" }),
      makeRecord("2", "App_A", DAY_A, { platform: "iOS" }),
      makeRecord("3", "App_A", DAY_A, { platform: "Android" }),
      makeRecord("4", "App_B", DAY_A, { platform: "iOS" }),
      makeRecord("5", "App_A", DAY_B, { platform: "iOS" }),
    ];

    const groups = groupRecords(records, ["platform"], "day");

    // (A, 03-14, iOS), (A, 03-14, Android), (B, 03-14, iOS), (A, 03-15, iOS)
    expect(groups).toHaveLength(4);

    const iosDayA = groups.find(
      (g) =>
        g.key.app === "App_A" &&
        g.key.timePeriod === "2025-03-14" &&
        g.key.dimensions.platform === "iOS",
    );
    expect(iosDayA?.records.map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("places records missing a sliced dimension under the Unknown member", () => {
    const records: KPIRecord[] = [
      makeRecord("1", "App_A", DAY_A, { platform: "iOS" }),
      makeRecord("2", "App_A", DAY_A, {}), // missing platform
      makeRecord("3", "App_A", DAY_A, { platform: "" }), // empty platform
    ];

    const groups = groupRecords(records, ["platform"], "day");

    const unknown = groups.find(
      (g) => g.key.dimensions.platform === UNKNOWN_MEMBER,
    );
    expect(unknown).toBeDefined();
    expect(unknown?.records.map((r) => r.id).sort()).toEqual(["2", "3"]);
  });

  it("produces disjoint groups whose union is exactly the input", () => {
    const records: KPIRecord[] = [
      makeRecord("1", "App_A", DAY_A, { platform: "iOS", network: "Wi-Fi" }),
      makeRecord("2", "App_A", DAY_A_HOUR_2, { platform: "iOS", network: "Wi-Fi" }),
      makeRecord("3", "App_B", DAY_B, { platform: "Android" }),
      makeRecord("4", "App_A", DAY_A, { platform: "iOS", network: "Cellular 5G" }),
    ];

    const groups = groupRecords(records, ["platform", "network"], "day");

    const collected = groups.flatMap((g) => g.records.map((r) => r.id)).sort();
    expect(collected).toEqual(["1", "2", "3", "4"]);
    // No record appears twice.
    expect(new Set(collected).size).toBe(collected.length);
  });

  it("keys on the hour bucket at hour granularity", () => {
    const records: KPIRecord[] = [
      makeRecord("1", "App_A", DAY_A, { platform: "iOS" }),
      makeRecord("2", "App_A", DAY_A_HOUR_2, { platform: "iOS" }),
    ];

    // Same day, different hours -> two groups at hour granularity.
    expect(groupRecords(records, ["platform"], "hour")).toHaveLength(2);
    // ...but one group at day granularity.
    expect(groupRecords(records, ["platform"], "day")).toHaveLength(1);
  });

  it("ignores dimensions not in the slice and returns one group when none supplied", () => {
    const records: KPIRecord[] = [
      makeRecord("1", "App_A", DAY_A, { platform: "iOS" }),
      makeRecord("2", "App_A", DAY_A, { platform: "Android" }),
    ];

    // No sliced dimensions -> partition on (app, day) only.
    const groups = groupRecords(records, [], "day");
    expect(groups).toHaveLength(1);
    expect(groups[0].records.map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("returns no groups for empty input", () => {
    expect(groupRecords([], ["platform"], "day")).toEqual([]);
  });
});
