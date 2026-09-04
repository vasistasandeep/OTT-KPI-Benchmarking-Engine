/**
 * Sanity unit tests for the per-KPI raw-mode compute functions and the generic
 * `sum` / `ratio` kinds. Exhaustive property coverage of rejection invariants
 * lives in the dedicated property test (task 6.11).
 */

import { describe, it, expect } from "vitest";
import { NO_DATA } from "../models/sentinels";
import type { RawSessionFields } from "../models/records";
import {
  sum,
  ratio,
  ebvs,
  rebufferRate,
  avgRenderedBitrate,
  downshiftFrequency,
  totalWatchTime,
  avgSessionDuration,
  completionQuartileRates,
  browseToPlay,
  adFillRate,
  adStartFailure,
  vcrAds,
  adPodDropoff,
  cdnCacheHitRatio,
  noDataReason,
} from "./raw-mode";

describe("sum", () => {
  it("totals a field across the group", () => {
    const s: RawSessionFields[] = [{ playTimeMs: 100 }, { playTimeMs: 250 }];
    expect(sum(s, "playTimeMs")).toBe(350);
  });

  it("treats missing values as 0 and returns 0 (not NO_DATA) for present rows", () => {
    const s: RawSessionFields[] = [{ playTimeMs: 0 }, {}];
    expect(sum(s, "playTimeMs")).toBe(0);
  });

  it("returns NO_DATA for an empty group", () => {
    expect(sum([], "playTimeMs")).toBe(NO_DATA);
  });
});

describe("ratio", () => {
  it("divides summed numerator by session count", () => {
    const s: RawSessionFields[] = [{ downshiftCount: 2 }, { downshiftCount: 4 }];
    expect(ratio(s, "downshiftCount", "sessionCount")).toBe(3);
  });

  it("divides summed numerator by summed denominator field with scaling", () => {
    const s: RawSessionFields[] = [{ cacheHit: 1 }, { cacheHit: 0 }];
    // 1/2 * 100 = 50
    expect(ratio(s, "cacheHit", "sessionCount", 100)).toBe(50);
  });

  it("returns NO_DATA when the denominator field sums to 0", () => {
    const s: RawSessionFields[] = [{ rebufferEventCount: 3, viewingTimeMs: 0 }];
    expect(ratio(s, "rebufferEventCount", "viewingTimeMs")).toBe(NO_DATA);
  });

  it("returns NO_DATA for an empty group", () => {
    expect(ratio([], "downshiftCount", "sessionCount")).toBe(NO_DATA);
  });
});

describe("ebvs", () => {
  it("computes 100 * sum(exitBeforeStart) / sum(playbackAttempt)", () => {
    const s: RawSessionFields[] = [
      { exitBeforeStart: 1, playbackAttempt: 1 },
      { exitBeforeStart: 0, playbackAttempt: 1 },
      { exitBeforeStart: 0, playbackAttempt: 1 },
      { exitBeforeStart: 0, playbackAttempt: 1 },
    ];
    expect(ebvs(s)).toBe(25);
  });

  it("returns NO_DATA when there are no playback attempts", () => {
    expect(ebvs([{ exitBeforeStart: 0, playbackAttempt: 0 }])).toBe(NO_DATA);
    expect(ebvs([])).toBe(NO_DATA);
  });
});

describe("rebufferRate", () => {
  it("computes events per viewing hour", () => {
    // 6 events over 2 viewing hours (7_200_000 ms) = 3 events/hour
    const s: RawSessionFields[] = [
      { rebufferEventCount: 4, viewingTimeMs: 3_600_000 },
      { rebufferEventCount: 2, viewingTimeMs: 3_600_000 },
    ];
    expect(rebufferRate(s)).toBe(3);
  });

  it("returns NO_DATA when there is no viewing time", () => {
    expect(rebufferRate([{ rebufferEventCount: 5, viewingTimeMs: 0 }])).toBe(NO_DATA);
  });
});

describe("avgRenderedBitrate", () => {
  it("computes watch-time-weighted mean in Mbps", () => {
    // Session A: 2000 kbps for 3s, Session B: 8000 kbps for 1s.
    // weighted mean kbps = (2000*3000 + 8000*1000) / 4000 = 14e6/4000 = 3500 kbps
    // = 3.5 Mbps
    const s: RawSessionFields[] = [
      { renderedBitrateKbps: 2000, playTimeMs: 3000 },
      { renderedBitrateKbps: 8000, playTimeMs: 1000 },
    ];
    expect(avgRenderedBitrate(s)).toBeCloseTo(3.5, 10);
  });

  it("returns NO_DATA when total play time is 0", () => {
    expect(avgRenderedBitrate([{ renderedBitrateKbps: 5000, playTimeMs: 0 }])).toBe(
      NO_DATA,
    );
  });
});

describe("downshiftFrequency", () => {
  it("computes drops per session", () => {
    const s: RawSessionFields[] = [{ downshiftCount: 1 }, { downshiftCount: 3 }];
    expect(downshiftFrequency(s)).toBe(2);
  });

  it("returns NO_DATA for an empty group", () => {
    expect(downshiftFrequency([])).toBe(NO_DATA);
  });
});

describe("totalWatchTime", () => {
  it("converts summed play-time ms to hours", () => {
    const s: RawSessionFields[] = [
      { playTimeMs: 3_600_000 },
      { playTimeMs: 1_800_000 },
    ];
    expect(totalWatchTime(s)).toBe(1.5);
  });

  it("returns NO_DATA for an empty group", () => {
    expect(totalWatchTime([])).toBe(NO_DATA);
  });
});

describe("avgSessionDuration", () => {
  it("computes mean session duration in minutes", () => {
    // mean ms = (60_000 + 120_000) / 2 = 90_000 ms = 1.5 min
    const s: RawSessionFields[] = [
      { sessionDurationMs: 60_000 },
      { sessionDurationMs: 120_000 },
    ];
    expect(avgSessionDuration(s)).toBe(1.5);
  });

  it("returns NO_DATA for an empty group", () => {
    expect(avgSessionDuration([])).toBe(NO_DATA);
  });
});

describe("completionQuartileRates", () => {
  it("counts nested quartiles over started sessions, monotonic non-increasing", () => {
    const s: RawSessionFields[] = [
      { quartileReached: 100 },
      { quartileReached: 75 },
      { quartileReached: 50 },
      { quartileReached: 0 },
    ];
    const r = completionQuartileRates(s);
    // reached>=25: 3/4=75, >=50: 3/4=75, >=75: 2/4=50, >=100: 1/4=25
    expect(r[25]).toBe(75);
    expect(r[50]).toBe(75);
    expect(r[75]).toBe(50);
    expect(r[100]).toBe(25);
    expect(r[25]).toBeGreaterThanOrEqual(r[50] as number);
    expect(r[50]).toBeGreaterThanOrEqual(r[75] as number);
    expect(r[75]).toBeGreaterThanOrEqual(r[100] as number);
  });

  it("returns NO_DATA for every quartile when there are no sessions", () => {
    const r = completionQuartileRates([]);
    expect(r[25]).toBe(NO_DATA);
    expect(r[50]).toBe(NO_DATA);
    expect(r[75]).toBe(NO_DATA);
    expect(r[100]).toBe(NO_DATA);
  });
});

describe("browseToPlay", () => {
  it("computes 100 * sum(playEvent) / sum(browseEvent)", () => {
    const s: RawSessionFields[] = [
      { browseEvent: 1, playEvent: 1 },
      { browseEvent: 1, playEvent: 0 },
    ];
    expect(browseToPlay(s)).toBe(50);
  });

  it("returns NO_DATA when there are no browse events", () => {
    expect(browseToPlay([{ browseEvent: 0, playEvent: 0 }])).toBe(NO_DATA);
  });
});

describe("ad metrics", () => {
  it("adFillRate = 100 * filled / requested", () => {
    const s: RawSessionFields[] = [{ adRequestCount: 10, adFilledCount: 8 }];
    expect(adFillRate(s)).toBe(80);
    expect(adFillRate([{ adRequestCount: 0, adFilledCount: 0 }])).toBe(NO_DATA);
  });

  it("adStartFailure = 100 * failures / filled", () => {
    const s: RawSessionFields[] = [{ adFilledCount: 4, adStartFailureCount: 1 }];
    expect(adStartFailure(s)).toBe(25);
    expect(adStartFailure([{ adFilledCount: 0 }])).toBe(NO_DATA);
  });

  it("vcrAds = 100 * complete / filled", () => {
    const s: RawSessionFields[] = [{ adFilledCount: 4, adCompleteCount: 3 }];
    expect(vcrAds(s)).toBe(75);
    expect(vcrAds([{ adFilledCount: 0 }])).toBe(NO_DATA);
  });

  it("adPodDropoff = 100 * abandon / start", () => {
    const s: RawSessionFields[] = [{ adPodStartCount: 5, adPodAbandonCount: 1 }];
    expect(adPodDropoff(s)).toBe(20);
    expect(adPodDropoff([{ adPodStartCount: 0 }])).toBe(NO_DATA);
  });
});

describe("cdnCacheHitRatio", () => {
  it("computes 100 * sum(cacheHit) / sessions", () => {
    const s: RawSessionFields[] = [
      { cacheHit: 1 },
      { cacheHit: 1 },
      { cacheHit: 0 },
      { cacheHit: 1 },
    ];
    expect(cdnCacheHitRatio(s)).toBe(75);
  });

  it("returns NO_DATA for an empty group", () => {
    expect(cdnCacheHitRatio([])).toBe(NO_DATA);
  });
});

describe("noDataReason", () => {
  it("reports pre-aggregated-only KPIs as not derivable from session logs", () => {
    expect(noDataReason("churn_rate")).toBe("not derivable from session logs");
    expect(noDataReason("arpu")).toBe("not derivable from session logs");
  });

  it("names the userId column for distinct-count KPIs when unmapped", () => {
    expect(noDataReason("dau")).toBe("requires a mapped `userId` column");
    expect(noDataReason("mau", new Set())).toBe("requires a mapped `userId` column");
  });

  it("names the missing session fields for conditional KPIs", () => {
    expect(noDataReason("ad_fill_rate")).toBe(
      "requires a mapped `adRequestCount`, `adFilledCount` column",
    );
  });

  it("returns null when all required fields are mapped", () => {
    expect(
      noDataReason("rebuffer_ratio", new Set(["bufferingMs", "playTimeMs"])),
    ).toBeNull();
    expect(noDataReason("dau", new Set(["userId"]))).toBeNull();
  });
});
