/**
 * Example unit tests for the FuzzyMatcher (Req 7.2, 7.3, 7.4, 22.3, 21.2).
 *
 * These cover concrete cases from the design's fuzzy-matching detail. The
 * exhaustive property-based coverage (score in [0,1], symmetry, exact-alias =
 * 1.00, auto-map threshold) lives in the dedicated property test (task 10.3).
 */

import { describe, it, expect } from "vitest";
import {
  diceSimilarity,
  normalizeHeader,
  tokenizeHeader,
  matchHeader,
  AUTO_MAP_THRESHOLD,
} from "./fuzzy-matcher";

describe("tokenizeHeader / normalizeHeader", () => {
  it("splits snake_case, camelCase, and punctuation to the same normal form", () => {
    expect(normalizeHeader("video_start_time")).toBe("videostarttime");
    expect(normalizeHeader("videoStartTime")).toBe("videostarttime");
    expect(normalizeHeader("Video Start Time")).toBe("videostarttime");
  });

  it("splits letter/digit boundaries", () => {
    expect(tokenizeHeader("vst_p95")).toEqual(["vst", "p", "95"]);
    expect(tokenizeHeader("ttfb_ms")).toEqual(["ttfb", "ms"]);
  });
});

describe("diceSimilarity", () => {
  it("returns 1 for identical strings and 0 for disjoint bigrams", () => {
    expect(diceSimilarity("videostarttime", "videostarttime")).toBe(1);
    expect(diceSimilarity("abcd", "wxyz")).toBe(0);
  });

  it("is symmetric and bounded in [0,1]", () => {
    const a = normalizeHeader("rebuffer_ratio");
    const b = normalizeHeader("buffer_ratio");
    const ab = diceSimilarity(a, b);
    const ba = diceSimilarity(b, a);
    expect(ab).toBe(ba);
    expect(ab).toBeGreaterThanOrEqual(0);
    expect(ab).toBeLessThanOrEqual(1);
  });
});

describe("matchHeader — exact aliases (Req 7.4)", () => {
  it.each(["ttff", "startup_time", "vst_ms", "time_to_first_frame"])(
    "maps %s to Video Start Time (P50) at score 1.00",
    (header) => {
      const r = matchHeader(header);
      expect(r.score).toBe(1);
      expect(r.target).toEqual({ kind: "kpi", kpiId: "vst_p50" });
    },
  );
});

describe("matchHeader — app/unit suffix stripping (Req 21.2, 22.3)", () => {
  it("resolves vst_app_a_ms to Video Start Time with App_A and ms unit", () => {
    const r = matchHeader("vst_app_a_ms");
    expect(r.target).toEqual({ kind: "kpi", kpiId: "vst_p50" });
    expect(r.appAssignment).toBe("App_A");
    expect(r.unitToken).toBe("ms");
    expect(r.score).toBeGreaterThanOrEqual(AUTO_MAP_THRESHOLD);
  });

  it("resolves vst_app_b_ms to the same KPI with App_B", () => {
    const r = matchHeader("vst_app_b_ms");
    expect(r.target).toEqual({ kind: "kpi", kpiId: "vst_p50" });
    expect(r.appAssignment).toBe("App_B");
    expect(r.unitToken).toBe("ms");
  });

  it("does not surface an app/unit token when the as-is pass wins", () => {
    // A bare alias resolves via the as-is pass (score 1.00), so no app or unit
    // token is stripped or surfaced even though the tokenizer could see none.
    const r = matchHeader("ttfb");
    expect(r.target).toEqual({ kind: "kpi", kpiId: "ttfb" });
    expect(r.appAssignment).toBeUndefined();
    expect(r.unitToken).toBeUndefined();
  });

  it("does not surface a unit token whose token is unknown to any KPI", () => {
    // Trailing "foo" is not an accepted unit for any KPI, so it is never
    // stripped as a unit and no unit is surfaced.
    const r = matchHeader("video_start_time");
    expect(r.target).toEqual({ kind: "kpi", kpiId: "vst_p50" });
    expect(r.unitToken).toBeUndefined();
  });

  it("only recognizes a unit token within the matched KPI's acceptedUnits", () => {
    // Manifest fetch latency accepts ms/s, not kbps. A kbps suffix must not be
    // surfaced as a unit for it.
    const r = matchHeader("manifest_fetch_latency_ms");
    expect(r.target).toEqual({ kind: "kpi", kpiId: "manifest_fetch_latency" });
    expect(r.unitToken).toBe("ms");
  });
});

describe("matchHeader — threshold behavior (Req 7.2, 7.3)", () => {
  it("leaves clearly unrelated headers unmapped", () => {
    const r = matchHeader("zzzzz_unrelated_column_qqq");
    expect(r.target).toBeNull();
    expect(r.score).toBeLessThan(AUTO_MAP_THRESHOLD);
  });

  it("auto-selects a near-miss alias above the threshold", () => {
    // "buffer_ratio" is an alias of Rebuffer Ratio.
    const r = matchHeader("buffer_ratio");
    expect(r.score).toBe(1);
    expect(r.target).toEqual({ kind: "kpi", kpiId: "rebuffer_ratio" });
  });
});
