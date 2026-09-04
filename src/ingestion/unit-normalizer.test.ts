/**
 * UnitNormalizer sanity tests (task 10.6).
 *
 * A minimal set of examples covering inference, the canonical-unit fallback with
 * its ASSUMED_UNIT advisory, and value conversion. Exhaustive property and
 * example coverage is deferred to tasks 10.7 and 10.8.
 *
 * Validates: Requirements 22.3, 22.5, 22.6
 */

import { describe, expect, it } from "vitest";

import {
  inferUnit,
  normalizeMappedValue,
  normalizeValue,
  resolveUnit,
} from "./unit-normalizer";

describe("inferUnit (Req 22.3)", () => {
  it("infers a trailing unit suffix restricted to the KPI's accepted units", () => {
    // vst_p50 canonical is `s`, accepts { ms: 0.001, s: 1 }.
    expect(inferUnit("vst_ms", "vst_p50")).toEqual({ token: "ms", factor: 0.001 });
    expect(inferUnit("startup_time_seconds", "vst_p50")).toEqual({ token: "s", factor: 1 });
  });

  it("does not read a `_s` suffix as seconds for a KPI that does not accept `s`", () => {
    // avg_rendered_bitrate accepts bps/kbps/Mbps only — no `s`.
    expect(inferUnit("bitrate_s", "avg_rendered_bitrate")).toBeUndefined();
    expect(inferUnit("bitrate_kbps", "avg_rendered_bitrate")).toEqual({
      token: "kbps",
      factor: 0.001,
    });
  });

  it("returns undefined when no accepted-unit token appears", () => {
    expect(inferUnit("vst", "vst_p50")).toBeUndefined();
  });
});

describe("resolveUnit fallback (Req 22.6)", () => {
  it("assumes the canonical unit at factor 1 when nothing is inferable", () => {
    const resolved = resolveUnit("vst", "vst_p50");
    expect(resolved.assumed).toBe(true);
    expect(resolved.unit).toEqual({ token: "s", factor: 1 });
  });

  it("does not flag an inferred unit as assumed", () => {
    const resolved = resolveUnit("vst_ms", "vst_p50");
    expect(resolved.assumed).toBe(false);
    expect(resolved.unit.token).toBe("ms");
  });
});

describe("normalization (Req 22.5)", () => {
  it("multiplies by the resolved factor", () => {
    expect(normalizeValue(1500, { token: "ms", factor: 0.001 })).toBeCloseTo(1.5, 10);
  });

  it("is a no-op for a value already in the canonical unit", () => {
    expect(normalizeValue(1.5, { token: "s", factor: 1 })).toBe(1.5);
  });

  it("converts and reports no advisory when the unit is inferred", () => {
    const result = normalizeMappedValue(1500, "vst_ms", "vst_p50");
    expect(result.value).toBeCloseTo(1.5, 10);
    expect(result.advisory).toBeUndefined();
  });

  it("converts using the canonical unit and raises ASSUMED_UNIT on fallback", () => {
    const result = normalizeMappedValue(1.5, "vst", "vst_p50");
    expect(result.value).toBe(1.5);
    expect(result.advisory?.code).toBe("ASSUMED_UNIT");
    expect(result.advisory?.detail).toContain("vst");
    expect(result.advisory?.detail).toContain("s");
  });
});
