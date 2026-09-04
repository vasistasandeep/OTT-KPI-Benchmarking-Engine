/**
 * Per-KPI raw-mode compute functions plus the generic `sum` and `ratio`
 * aggregation kinds, driven by the design's raw-mode coverage matrix.
 *
 * Each function takes the *valid* sessions of a group (callers reject missing /
 * non-numeric / negative rows first via `rejection.ts`, Req 5.7) and returns a
 * finite value in the KPI's canonical unit or the `NO_DATA` sentinel when the
 * governing divisor is zero — i.e. no session in the group carries the data the
 * KPI needs (Req 5.5, 16.1). Missing optional fields on an otherwise valid
 * session are treated as 0 so partially-populated sessions still contribute
 * what they carry, exactly as the existing `rates.ts` helpers do.
 *
 * Rebuffer Ratio and VSF Rate already live in `rates.ts`; this module covers the
 * rest of the matrix: Exit Before Video Start, Rebuffer Rate, watch-time-
 * weighted Average Rendered Bitrate, Downshift Frequency, Total Watch Time,
 * Average Session Duration, completion-quartile rates, Browse-to-Play, the four
 * ad metrics, and CDN Cache Hit Ratio — plus generic `sum` and `ratio` kinds.
 *
 * KPIs that a playback session log cannot express are reported with a specific
 * reason via {@link noDataReason} so the UI can distinguish an unmappable KPI
 * from an empty slice (design "Behavior for KPIs that are not raw-computable",
 * Req 5.1, 16.5).
 *
 * All functions are pure: no rounding beyond the documented 2-decimal rule, no
 * mutation, no DOM, no storage.
 *
 * Requirements: 4.3, 5.1, 5.7, 16.1 (and the raw-mode coverage matrix formulas
 * for Req 1.3–1.6).
 */

import { NO_DATA } from "@/models/sentinels";
import type { Numeric } from "@/models/sentinels";
import type { RawSessionFields } from "@/models/records";
import type { CanonicalKPIId } from "@/models/ids";
import { KPI_BY_ID } from "@/registry/kpi-registry";

/** Milliseconds in one hour, for watch-time / per-hour conversions. */
const MS_PER_HOUR = 3_600_000;
/** Milliseconds in one minute, for session-duration conversion. */
const MS_PER_MINUTE = 60_000;
/** Kbps -> Mbps conversion factor for rendered bitrate. */
const KBPS_PER_MBPS = 1000;

/** Round a finite number to 2 decimal places (percentage/rate presentation). */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Read a numeric field, treating a missing/undefined value as 0. */
function num(session: RawSessionFields, field: keyof RawSessionFields): number {
  const v = session[field as string];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ---------------------------------------------------------------------------
// Generic aggregation kinds
// ---------------------------------------------------------------------------

/**
 * Generic `sum` kind: total a single field across the group, in field units.
 *
 * With no contributing sessions the total is undefined for aggregation purposes
 * and the function returns `NO_DATA` (Req 5.5, 16.1). A group of sessions that
 * all carry 0 sums to a defined 0 and is *not* NO_DATA — the distinction is
 * "no records" vs "records summing to zero".
 */
export function sum(
  sessions: readonly RawSessionFields[],
  field: keyof RawSessionFields,
): Numeric {
  if (sessions.length === 0) {
    return NO_DATA;
  }
  let total = 0;
  for (const s of sessions) {
    total += num(s, field);
  }
  return total;
}

/**
 * Generic `ratio` kind: `sum(numeratorField) / denominator`, where the
 * denominator is either another summed field or the session count.
 *
 * Returns `NO_DATA` when the denominator is 0 (no sessions, or the denominator
 * field sums to zero) so a divide-by-zero never surfaces (Req 5.5, 16.1).
 *
 * @param sessions        The valid sessions of the group.
 * @param numeratorField  Field summed to form the numerator.
 * @param denominator     Either `"sessionCount"` to divide by the number of
 *   sessions, or a field summed to form the denominator.
 * @param scale           Optional multiplier applied to the ratio (e.g. a unit
 *   conversion). Defaults to 1.
 */
export function ratio(
  sessions: readonly RawSessionFields[],
  numeratorField: keyof RawSessionFields,
  denominator: "sessionCount" | keyof RawSessionFields,
  scale = 1,
): Numeric {
  if (sessions.length === 0) {
    return NO_DATA;
  }
  let numerator = 0;
  for (const s of sessions) {
    numerator += num(s, numeratorField);
  }
  let denom: number;
  if (denominator === "sessionCount") {
    denom = sessions.length;
  } else {
    denom = 0;
    for (const s of sessions) {
      denom += num(s, denominator);
    }
  }
  if (denom === 0) {
    return NO_DATA;
  }
  return (numerator / denom) * scale;
}

// ---------------------------------------------------------------------------
// Playback Quality & QoE
// ---------------------------------------------------------------------------

/**
 * Exit Before Video Start (EBVS), Req 1.3 / coverage matrix:
 *
 *   100 * sum(exitBeforeStart) / sum(playbackAttempt)
 *
 * Percentage rounded to 2 decimals. `sum(playbackAttempt) == 0` → `NO_DATA`.
 */
export function ebvs(sessions: readonly RawSessionFields[]): Numeric {
  let numerator = 0;
  let denom = 0;
  for (const s of sessions) {
    numerator += num(s, "exitBeforeStart");
    denom += num(s, "playbackAttempt");
  }
  if (denom === 0) {
    return NO_DATA;
  }
  return round2((100 * numerator) / denom);
}

/**
 * Rebuffer Rate (events per viewing hour), coverage matrix:
 *
 *   sum(rebufferEventCount) / (sum(viewingTimeMs) / 3_600_000)
 *
 * `sum(viewingTimeMs) == 0` → `NO_DATA` (no viewing time to rate over).
 */
export function rebufferRate(sessions: readonly RawSessionFields[]): Numeric {
  let events = 0;
  let viewingMs = 0;
  for (const s of sessions) {
    events += num(s, "rebufferEventCount");
    viewingMs += num(s, "viewingTimeMs");
  }
  if (viewingMs === 0) {
    return NO_DATA;
  }
  const viewingHours = viewingMs / MS_PER_HOUR;
  return round2(events / viewingHours);
}

/**
 * Average Rendered Bitrate, watch-time-weighted (coverage matrix):
 *
 *   sum(renderedBitrateKbps * playTimeMs) / sum(playTimeMs), converted to Mbps
 *
 * Weighting by play time means long sessions influence the mean in proportion
 * to how long they actually played, not one-session-one-vote. `sum(playTimeMs)
 * == 0` → `NO_DATA`. Result is in Mbps (not rounded to 2 decimals — bitrate is
 * a higher-precision value, and rounding is the caller's presentation concern).
 */
export function avgRenderedBitrate(sessions: readonly RawSessionFields[]): Numeric {
  let weightedKbps = 0;
  let totalPlayMs = 0;
  for (const s of sessions) {
    const playMs = num(s, "playTimeMs");
    weightedKbps += num(s, "renderedBitrateKbps") * playMs;
    totalPlayMs += playMs;
  }
  if (totalPlayMs === 0) {
    return NO_DATA;
  }
  const meanKbps = weightedKbps / totalPlayMs;
  return meanKbps / KBPS_PER_MBPS;
}

/**
 * Downshift Frequency (drops per session), coverage matrix:
 *
 *   sum(downshiftCount) / sessions
 *
 * `sessions == 0` → `NO_DATA`.
 */
export function downshiftFrequency(sessions: readonly RawSessionFields[]): Numeric {
  return ratio(sessions, "downshiftCount", "sessionCount");
}

// ---------------------------------------------------------------------------
// User Engagement & Audience Retention
// ---------------------------------------------------------------------------

/**
 * Total Watch Time (hours), coverage matrix:
 *
 *   sum(playTimeMs) / 3_600_000
 *
 * `sessions == 0` → `NO_DATA`. A group whose play time sums to 0 yields a
 * defined 0 hours (records exist, they just have no play time).
 */
export function totalWatchTime(sessions: readonly RawSessionFields[]): Numeric {
  const totalMs = sum(sessions, "playTimeMs");
  if (totalMs === NO_DATA) {
    return NO_DATA;
  }
  return (totalMs as number) / MS_PER_HOUR;
}

/**
 * Average Session Duration (minutes), coverage matrix:
 *
 *   sum(sessionDurationMs) / sessions / 60_000
 *
 * `sessions == 0` → `NO_DATA`.
 */
export function avgSessionDuration(sessions: readonly RawSessionFields[]): Numeric {
  if (sessions.length === 0) {
    return NO_DATA;
  }
  let totalMs = 0;
  for (const s of sessions) {
    totalMs += num(s, "sessionDurationMs");
  }
  const meanMs = totalMs / sessions.length;
  return meanMs / MS_PER_MINUTE;
}

/** The four completion quartiles, in funnel order. */
const QUARTILES = [25, 50, 75, 100] as const;
/** A completion quartile threshold. */
export type Quartile = (typeof QUARTILES)[number];

/**
 * Completion-quartile rates over a group's valid sessions (coverage matrix):
 *
 *   rate(q) = 100 * count(quartileReached >= q) / count(sessions started)
 *
 * for each `q` in {25, 50, 75, 100}. "Sessions started" is the number of valid
 * sessions in the group (each represents one started playback). The counted
 * sets are nested (a session that reached 75% also reached 25% and 50%), so the
 * rates are monotonic non-increasing by construction: `rate(25) >= rate(50) >=
 * rate(75) >= rate(100)`.
 *
 * With no sessions every quartile is `NO_DATA` (Req 5.5, 16.1).
 *
 * This computes the *raw-mode* quartile rates only. Pre-aggregated monotonicity
 * checking and the `NON_MONOTONIC_QUARTILES` advisory are handled separately
 * (task 6.12).
 *
 * @returns a record keyed by quartile threshold, each a percentage rounded to
 *   2 decimals or `NO_DATA`.
 */
export function completionQuartileRates(
  sessions: readonly RawSessionFields[],
): Record<Quartile, Numeric> {
  if (sessions.length === 0) {
    return { 25: NO_DATA, 50: NO_DATA, 75: NO_DATA, 100: NO_DATA };
  }

  const counts: Record<Quartile, number> = { 25: 0, 50: 0, 75: 0, 100: 0 };
  for (const s of sessions) {
    const reached = num(s, "quartileReached");
    for (const q of QUARTILES) {
      if (reached >= q) {
        counts[q] += 1;
      }
    }
  }

  const started = sessions.length;
  return {
    25: round2((100 * counts[25]) / started),
    50: round2((100 * counts[50]) / started),
    75: round2((100 * counts[75]) / started),
    100: round2((100 * counts[100]) / started),
  };
}

/**
 * Browse-to-Play Conversion, coverage matrix:
 *
 *   100 * sum(playEvent) / sum(browseEvent)
 *
 * `sum(browseEvent) == 0` → `NO_DATA` (no browse events to convert from).
 */
export function browseToPlay(sessions: readonly RawSessionFields[]): Numeric {
  let plays = 0;
  let browses = 0;
  for (const s of sessions) {
    plays += num(s, "playEvent");
    browses += num(s, "browseEvent");
  }
  if (browses === 0) {
    return NO_DATA;
  }
  return round2((100 * plays) / browses);
}

// ---------------------------------------------------------------------------
// Monetization & AdTech
// ---------------------------------------------------------------------------

/**
 * Ad Fill Rate: `100 * sum(adFilledCount) / sum(adRequestCount)`.
 * `sum(adRequestCount) == 0` → `NO_DATA`.
 */
export function adFillRate(sessions: readonly RawSessionFields[]): Numeric {
  return percentageRatio(sessions, "adFilledCount", "adRequestCount");
}

/**
 * Ad Start Failure: `100 * sum(adStartFailureCount) / sum(adFilledCount)`.
 * `sum(adFilledCount) == 0` → `NO_DATA`.
 */
export function adStartFailure(sessions: readonly RawSessionFields[]): Numeric {
  return percentageRatio(sessions, "adStartFailureCount", "adFilledCount");
}

/**
 * Video Completion Rate for Ads: `100 * sum(adCompleteCount) / sum(adFilledCount)`.
 * `sum(adFilledCount) == 0` → `NO_DATA`.
 */
export function vcrAds(sessions: readonly RawSessionFields[]): Numeric {
  return percentageRatio(sessions, "adCompleteCount", "adFilledCount");
}

/**
 * Ad Pod Drop-off Rate: `100 * sum(adPodAbandonCount) / sum(adPodStartCount)`.
 * `sum(adPodStartCount) == 0` → `NO_DATA`.
 */
export function adPodDropoff(sessions: readonly RawSessionFields[]): Numeric {
  return percentageRatio(sessions, "adPodAbandonCount", "adPodStartCount");
}

// ---------------------------------------------------------------------------
// Infrastructure & Delivery
// ---------------------------------------------------------------------------

/**
 * CDN Cache Hit Ratio: `100 * sum(cacheHit) / sessions`.
 * `sessions == 0` → `NO_DATA`.
 */
export function cdnCacheHitRatio(sessions: readonly RawSessionFields[]): Numeric {
  const r = ratio(sessions, "cacheHit", "sessionCount", 100);
  return r === NO_DATA ? NO_DATA : round2(r as number);
}

/**
 * Shared percentage-ratio helper: `100 * sum(numeratorField) / sum(denomField)`
 * rounded to 2 decimals, `NO_DATA` when the denominator sums to 0.
 */
function percentageRatio(
  sessions: readonly RawSessionFields[],
  numeratorField: keyof RawSessionFields,
  denomField: keyof RawSessionFields,
): Numeric {
  let numerator = 0;
  let denom = 0;
  for (const s of sessions) {
    numerator += num(s, numeratorField);
    denom += num(s, denomField);
  }
  if (denom === 0) {
    return NO_DATA;
  }
  return round2((100 * numerator) / denom);
}

// ---------------------------------------------------------------------------
// NO_DATA reasons for KPIs not derivable from mapped session fields (Req 5.1)
// ---------------------------------------------------------------------------

/**
 * The session fields each raw-computable KPI requires to be *mapped* before it
 * can be derived (design coverage matrix). A KPI whose required fields are not
 * all mapped behaves like a pre-aggregated-only KPI in a raw dataset: it emits
 * `NO_DATA` with a "requires a mapped ... column" reason.
 *
 * `userId` is called out specially so the reason can name it (the coverage
 * matrix uses the "requires a mapped `userId` column" wording for DAU/WAU/MAU).
 */
const RAW_REQUIRED_FIELDS: Partial<Record<CanonicalKPIId, (keyof RawSessionFields)[]>> = {
  vst_p50: ["vstMs"],
  vst_p95: ["vstMs"],
  rebuffer_ratio: ["bufferingMs", "playTimeMs"],
  rebuffer_rate: ["rebufferEventCount", "viewingTimeMs"],
  vsf: ["startFailure", "playbackAttempt"],
  ebvs: ["exitBeforeStart", "playbackAttempt"],
  avg_rendered_bitrate: ["renderedBitrateKbps", "playTimeMs"],
  downshift_frequency: ["downshiftCount"],
  total_watch_time: ["playTimeMs"],
  avg_session_duration: ["sessionDurationMs"],
  dau: ["userId"],
  wau: ["userId"],
  mau: ["userId"],
  content_completion_25: ["quartileReached", "playbackAttempt"],
  content_completion_50: ["quartileReached", "playbackAttempt"],
  content_completion_75: ["quartileReached", "playbackAttempt"],
  content_completion_100: ["quartileReached", "playbackAttempt"],
  browse_to_play: ["browseEvent", "playEvent"],
  ad_fill_rate: ["adRequestCount", "adFilledCount"],
  ad_start_failure: ["adStartFailureCount", "adFilledCount"],
  vcr_ads: ["adCompleteCount", "adFilledCount"],
  ad_pod_dropoff: ["adPodAbandonCount", "adPodStartCount"],
  cdn_cache_hit_ratio: ["cacheHit"],
  manifest_fetch_latency: ["manifestFetchMs"],
  ttfb: ["ttfbMs"],
};

/**
 * The specific reason a KPI is not derivable from the mapped session fields, or
 * `null` when the KPI *is* derivable given `mappedFields` (Req 5.1, 16.5).
 *
 * Two shapes of un-derivability, matching the design:
 *
 * - `rawModeComputable: false` (Churn Rate, ARPU) → "not derivable from session
 *   logs" — a session log structurally lacks the data (billing, subscription
 *   lifecycle).
 * - `rawModeComputable: true` but a required field was not mapped → "requires a
 *   mapped `<field>` column"; the distinct-count KPIs specifically call out the
 *   `userId` column.
 *
 * Callers pass the set of session fields the active mapping actually populated;
 * when every required field is mapped the function returns `null`, meaning the
 * KPI should be computed rather than reported as no-data.
 *
 * @param kpiId        The KPI to check.
 * @param mappedFields The session fields the current mapping populates. Defaults
 *   to none, which reports every conditional KPI as needing its field(s).
 * @returns the no-data reason string, or `null` if the KPI is derivable.
 */
export function noDataReason(
  kpiId: CanonicalKPIId,
  mappedFields: ReadonlySet<keyof RawSessionFields> = new Set(),
): string | null {
  const def = KPI_BY_ID[kpiId];
  if (def && def.rawModeComputable === false) {
    return "not derivable from session logs";
  }

  const required = RAW_REQUIRED_FIELDS[kpiId];
  if (!required) {
    // Unknown KPI or one with no declared raw requirement: nothing to gate on.
    return null;
  }

  const missing = required.filter((f) => !mappedFields.has(f));
  if (missing.length === 0) {
    return null;
  }
  if (missing.includes("userId")) {
    return "requires a mapped `userId` column";
  }
  const names = missing.map((f) => `\`${String(f)}\``).join(", ");
  return `requires a mapped ${names} column`;
}
