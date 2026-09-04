import { describe, it, expect } from "vitest";
import { bucketTimestamp } from "./bucket";

describe("bucketTimestamp", () => {
  it("truncates to the top of the containing UTC hour and day", () => {
    expect(bucketTimestamp("2025-03-14T09:37:12.482Z")).toEqual({
      hourUtc: "2025-03-14T09:00:00Z",
      dayUtc: "2025-03-14",
    });
  });

  it("keeps an exact hour boundary unchanged", () => {
    expect(bucketTimestamp("2025-03-14T09:00:00Z")).toEqual({
      hourUtc: "2025-03-14T09:00:00Z",
      dayUtc: "2025-03-14",
    });
  });

  it("handles midnight (start of a UTC day)", () => {
    expect(bucketTimestamp("2025-01-01T00:00:00Z")).toEqual({
      hourUtc: "2025-01-01T00:00:00Z",
      dayUtc: "2025-01-01",
    });
  });

  it("zero-pads single-digit month, day, and hour", () => {
    expect(bucketTimestamp("2025-02-03T04:59:59Z")).toEqual({
      hourUtc: "2025-02-03T04:00:00Z",
      dayUtc: "2025-02-03",
    });
  });

  it("normalizes a non-Z UTC offset to the correct UTC hour", () => {
    // 2025-03-14T02:30:00+05:30 == 2025-03-13T21:00:00Z
    expect(bucketTimestamp("2025-03-14T02:30:00+05:30")).toEqual({
      hourUtc: "2025-03-13T21:00:00Z",
      dayUtc: "2025-03-13",
    });
  });

  it("throws on an unparseable timestamp", () => {
    expect(() => bucketTimestamp("not-a-date")).toThrow(RangeError);
  });
});
