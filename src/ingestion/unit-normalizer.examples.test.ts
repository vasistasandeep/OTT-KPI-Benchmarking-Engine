/**
 * UnitNormalizer worked-example tests (task 10.8).
 *
 * Focused examples for the concrete cases called out in the design's "Unit
 * inference and normalization" section:
 *
 *   - per-header-token inference (`vst_ms`, `vst_sec`/`seconds`, `bitrate_kbps`);
 *   - the `_s`-on-a-bitrate near-miss (a bitrate KPI has no `s` accepted unit,
 *     so a trailing `_s` must NOT be read as seconds);
 *   - the unknown-unit fallback that assumes the KPI's canonical unit and
 *     raises the ASSUMED_UNIT advisory.
 *
 * Uses real registry KPI ids and their accepted units:
 *   - vst_p50            → canonical `s`,  accepts { ms: 0.001, s: 1 }
 *   - ttfb               → canonical `ms`, accepts { s: 1000, ms: 1 }
 *   - avg_rendered_bitrate → canonical `Mbps`, accepts { bps, kbps: 0.001, Mbps: 1 } (no `s`)
 *
 * Validates: Requirements 22.3, 22.4, 22.6
 */

import { describe, expect, it } from "vitest";

import {
  inferUnit,
  normalizeMappedValue,
  resolveUnit,
} from "./unit-normalizer";

describe("per-header-token inference (Req 22.3, 22.4)", () => {
  it("reads `vst_ms` as milliseconds for a seconds-canonical KPI", () => {
    expect(inferUnit("vst_ms", "vst_p50")).toEqual({ token: "ms", factor: 0.001 });
  });

  it("reads a `_sec` abbreviation as seconds", () => {
    expect(inferUnit("vst_sec", "vst_p50")).toEqual({ token: "s", factor: 1 });
  });

  it("reads a spelled-out `seconds` token as seconds", () => {
    expect(inferUnit("video_start_time_seconds", "vst_p50")).toEqual({
      token: "s",
      factor: 1,
    });
  });

  it("reads `bitrate_kbps` as kbps for the Mbps-canonical bitrate KPI", () => {
    expect(inferUnit("bitrate_kbps", "avg_rendered_bitrate")).toEqual({
      token: "kbps",
      factor: 0.001,
    });
  });

  it("normalizes an inferred value to the canonical unit with no advisory", () => {
    // 1500 ms → 1.5 s.
    const result = normalizeMappedValue(1500, "vst_ms", "vst_p50");
    expect(result.value).toBeCloseTo(1.5, 10);
    expect(result.advisory).toBeUndefined();

    // 2000 kbps → 2 Mbps.
    const bitrate = normalizeMappedValue(2000, "bitrate_kbps", "avg_rendered_bitrate");
    expect(bitrate.value).toBeCloseTo(2, 10);
    expect(bitrate.advisory).toBeUndefined();
  });
});

describe("`_s`-on-a-bitrate near-miss (Req 22.3)", () => {
  it("does not read a trailing `_s` as seconds because bitrate has no `s` unit", () => {
    // avg_rendered_bitrate accepts bps/kbps/Mbps only — the `s` token is absent.
    expect(inferUnit("bitrate_s", "avg_rendered_bitrate")).toBeUndefined();
  });

  it("falls back to the canonical bitrate unit for the `_s` near-miss", () => {
    const resolved = resolveUnit("bitrate_s", "avg_rendered_bitrate");
    expect(resolved.assumed).toBe(true);
    expect(resolved.unit).toEqual({ token: "Mbps", factor: 1 });
  });

  it("still reads `_s` as seconds when the KPI actually accepts seconds", () => {
    // Sanity contrast: ttfb accepts `s`, so a `_s` suffix IS a real unit token.
    expect(inferUnit("ttfb_s", "ttfb")).toEqual({ token: "s", factor: 1000 });
  });
});

describe("unknown-unit fallback and advisory (Req 22.6)", () => {
  it("assumes the canonical unit at factor 1 when no token is inferable", () => {
    const resolved = resolveUnit("startup_metric", "vst_p50");
    expect(resolved.assumed).toBe(true);
    expect(resolved.unit).toEqual({ token: "s", factor: 1 });
  });

  it("passes the value through unchanged and raises ASSUMED_UNIT", () => {
    const result = normalizeMappedValue(1.5, "startup_metric", "vst_p50");
    expect(result.value).toBe(1.5);
    expect(result.advisory?.code).toBe("ASSUMED_UNIT");
    // The advisory names the source column and the assumed canonical unit.
    expect(result.advisory?.detail).toContain("startup_metric");
    expect(result.advisory?.detail).toContain("vst_p50");
    expect(result.advisory?.detail).toContain('"s"');
  });

  it("raises ASSUMED_UNIT for a bitrate column with no recognizable unit", () => {
    const result = normalizeMappedValue(3, "rendered_quality", "avg_rendered_bitrate");
    expect(result.value).toBe(3);
    expect(result.advisory?.code).toBe("ASSUMED_UNIT");
    expect(result.advisory?.detail).toContain("rendered_quality");
    expect(result.advisory?.detail).toContain('"Mbps"');
  });
});
