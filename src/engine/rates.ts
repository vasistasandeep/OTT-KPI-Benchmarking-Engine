/**
 * Raw-session rate KPIs computed from summed numerators and denominators.
 *
 * Both functions operate over an array of `RawSessionFields` (one entry per
 * session), summing the relevant fields across the group and returning either a
 * finite percentage rounded to 2 decimals or the `NO_DATA` sentinel when the
 * denominator is zero (no contributing sessions). Missing/undefined fields are
 * treated as 0 so partially-mapped sessions still contribute what they carry.
 *
 * Requirements: 5.2 (Rebuffer Ratio), 5.3 (VSF Rate), 5.5 & 16.1 (NO_DATA on
 * zero divisor).
 */

import { NO_DATA } from "../models/sentinels";
import type { Numeric } from "../models/sentinels";
import type { RawSessionFields } from "../models/records";

/** Round a finite number to 2 decimal places. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Rebuffer Ratio (Req 5.2):
 *
 *   100 * sum(bufferingMs) / (sum(playTimeMs) + sum(bufferingMs))
 *
 * Rounded to 2 decimals and bounded in [0, 100]. When
 * `sum(playTimeMs) + sum(bufferingMs) == 0` the ratio is undefined, so the
 * function returns `NO_DATA` (Req 5.5, 16.1).
 */
export function rebufferRatio(sessions: readonly RawSessionFields[]): Numeric {
  let sumBuffering = 0;
  let sumPlayTime = 0;
  for (const s of sessions) {
    sumBuffering += s.bufferingMs ?? 0;
    sumPlayTime += s.playTimeMs ?? 0;
  }
  const denominator = sumPlayTime + sumBuffering;
  if (denominator === 0) {
    return NO_DATA;
  }
  return round2((100 * sumBuffering) / denominator);
}

/**
 * Video Start Failure (VSF) Rate (Req 5.3):
 *
 *   100 * sum(startFailure) / sum(playbackAttempt)
 *
 * Rounded to 2 decimals and bounded in [0, 100] (given each
 * `startFailure <= playbackAttempt`). When `sum(playbackAttempt) == 0` the rate
 * is undefined, so the function returns `NO_DATA` (Req 5.5).
 */
export function vsfRate(sessions: readonly RawSessionFields[]): Numeric {
  let sumStartFailure = 0;
  let sumPlaybackAttempt = 0;
  for (const s of sessions) {
    sumStartFailure += s.startFailure ?? 0;
    sumPlaybackAttempt += s.playbackAttempt ?? 0;
  }
  if (sumPlaybackAttempt === 0) {
    return NO_DATA;
  }
  return round2((100 * sumStartFailure) / sumPlaybackAttempt);
}
