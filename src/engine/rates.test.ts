/**
 * Sanity unit tests for the raw-session rate KPIs. The exhaustive
 * property-based coverage lives in the dedicated property tests (tasks 6.5-6.7).
 */

import { describe, it, expect } from "vitest";
import { NO_DATA } from "../models/sentinels";
import type { RawSessionFields } from "../models/records";
import { rebufferRatio, vsfRate } from "./rates";

describe("rebufferRatio", () => {
  it("computes 100 * sum(buffering) / (sum(playTime) + sum(buffering))", () => {
    const sessions: RawSessionFields[] = [
      { bufferingMs: 100, playTimeMs: 900 },
      { bufferingMs: 400, playTimeMs: 600 },
    ];
    // 100 * 500 / (1500 + 500) = 25
    expect(rebufferRatio(sessions)).toBe(25);
  });

  it("rounds to 2 decimals", () => {
    const sessions: RawSessionFields[] = [{ bufferingMs: 1, playTimeMs: 2 }];
    // 100 * 1 / 3 = 33.333... -> 33.33
    expect(rebufferRatio(sessions)).toBe(33.33);
  });

  it("treats missing fields as 0", () => {
    const sessions: RawSessionFields[] = [{ bufferingMs: 50 }, { playTimeMs: 150 }];
    // 100 * 50 / 200 = 25
    expect(rebufferRatio(sessions)).toBe(25);
  });

  it("returns NO_DATA when the denominator is zero", () => {
    expect(rebufferRatio([])).toBe(NO_DATA);
    expect(rebufferRatio([{ bufferingMs: 0, playTimeMs: 0 }])).toBe(NO_DATA);
  });
});

describe("vsfRate", () => {
  it("computes 100 * sum(startFailure) / sum(playbackAttempt)", () => {
    const sessions: RawSessionFields[] = [
      { startFailure: 1, playbackAttempt: 1 },
      { startFailure: 0, playbackAttempt: 1 },
      { startFailure: 0, playbackAttempt: 1 },
    ];
    // 100 * 1 / 3 = 33.33
    expect(vsfRate(sessions)).toBe(33.33);
  });

  it("returns NO_DATA when sum(playbackAttempt) is zero", () => {
    expect(vsfRate([])).toBe(NO_DATA);
    expect(vsfRate([{ startFailure: 0, playbackAttempt: 0 }])).toBe(NO_DATA);
  });
});
