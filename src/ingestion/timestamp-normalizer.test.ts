import { describe, it, expect } from "vitest";
import { normalizeTimestamp } from "./timestamp-normalizer";
import { bucketTimestamp } from "@/engine/bucket";

/**
 * Narrow a result to its success shape or fail the test with the reason, so the
 * assertions below can read `.timestampUtc` etc. without repeated guards.
 */
function expectOk(raw: string) {
  const result = normalizeTimestamp(raw);
  if (!result.ok) {
    throw new Error(`expected "${raw}" to normalize, got rejection: ${result.reason}`);
  }
  return result;
}

describe("normalizeTimestamp", () => {
  describe("explicit offset conversion (Req 26.1)", () => {
    it("converts a positive offset to UTC and preserves the offset in minutes", () => {
      // 2025-03-14T02:30:00+05:30 == 2025-03-13T21:00:00Z
      const result = expectOk("2025-03-14T02:30:00+05:30");
      expect(result.timestampUtc).toBe("2025-03-13T21:00:00.000Z");
      expect(result.sourceUtcOffsetMinutes).toBe(330);
      expect(result.offsetAssumed).toBe(false);
      expect(result.dateOnly).toBe(false);
      expect(result.bucket).toEqual({ hourUtc: "2025-03-13T21:00:00Z", dayUtc: "2025-03-13" });
    });

    it("converts a negative offset to UTC and preserves the signed offset", () => {
      // 2025-03-14T20:00:00-08:00 == 2025-03-15T04:00:00Z
      const result = expectOk("2025-03-14T20:00:00-08:00");
      expect(result.timestampUtc).toBe("2025-03-15T04:00:00.000Z");
      expect(result.sourceUtcOffsetMinutes).toBe(-480);
      expect(result.offsetAssumed).toBe(false);
      expect(result.bucket).toEqual({ hourUtc: "2025-03-15T04:00:00Z", dayUtc: "2025-03-15" });
    });

    it("accepts an offset without a colon (+0530)", () => {
      const result = expectOk("2025-03-14T02:30:00+0530");
      expect(result.timestampUtc).toBe("2025-03-13T21:00:00.000Z");
      expect(result.sourceUtcOffsetMinutes).toBe(330);
    });
  });

  describe("trailing Z (Req 26.1)", () => {
    it("honors a Z suffix and records the offset as 0", () => {
      const result = expectOk("2025-03-14T09:37:12.482Z");
      expect(result.timestampUtc).toBe("2025-03-14T09:37:12.482Z");
      expect(result.sourceUtcOffsetMinutes).toBe(0);
      expect(result.offsetAssumed).toBe(false);
      expect(result.dateOnly).toBe(false);
      expect(result.bucket).toEqual({ hourUtc: "2025-03-14T09:00:00Z", dayUtc: "2025-03-14" });
    });
  });

  describe("naive timestamp (Req 26.2)", () => {
    it("interprets a no-offset timestamp as UTC, sets offset null, and flags the column", () => {
      const result = expectOk("2025-03-14T09:37:12");
      expect(result.timestampUtc).toBe("2025-03-14T09:37:12.000Z");
      expect(result.sourceUtcOffsetMinutes).toBeNull();
      expect(result.offsetAssumed).toBe(true);
      expect(result.dateOnly).toBe(false);
      expect(result.bucket).toEqual({ hourUtc: "2025-03-14T09:00:00Z", dayUtc: "2025-03-14" });
    });

    it("accepts a space separator as a naive timestamp", () => {
      const result = expectOk("2025-03-14 09:37:00");
      expect(result.timestampUtc).toBe("2025-03-14T09:37:00.000Z");
      expect(result.sourceUtcOffsetMinutes).toBeNull();
      expect(result.offsetAssumed).toBe(true);
    });
  });

  describe("date-only anchoring (Req 26.3)", () => {
    it("anchors a bare calendar date at 00:00:00Z", () => {
      const result = expectOk("2025-03-14");
      expect(result.timestampUtc).toBe("2025-03-14T00:00:00.000Z");
      expect(result.sourceUtcOffsetMinutes).toBeNull();
      expect(result.dateOnly).toBe(true);
      expect(result.bucket).toEqual({ hourUtc: "2025-03-14T00:00:00Z", dayUtc: "2025-03-14" });
    });
  });

  describe("unparseable rejection (Req 26.4)", () => {
    it("rejects a non-date string with a reason", () => {
      const result = normalizeTimestamp("not-a-date");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("not-a-date");
        expect(result.reason.length).toBeGreaterThan(0);
      }
    });

    it("rejects an empty timestamp with a reason", () => {
      const result = normalizeTimestamp("   ");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/empty/i);
      }
    });

    it("rejects an impossible calendar instant with a reason", () => {
      const result = normalizeTimestamp("2025-13-40T99:99:99Z");
      expect(result.ok).toBe(false);
    });

    it("rejects a malformed offset with a reason", () => {
      const result = normalizeTimestamp("2025-03-14T09:00:00+99:99");
      expect(result.ok).toBe(false);
    });
  });

  it("assigns buckets consistent with the engine's bucketTimestamp", () => {
    const result = expectOk("2025-03-14T02:30:00+05:30");
    expect(result.bucket).toEqual(bucketTimestamp(result.timestampUtc));
  });
});
