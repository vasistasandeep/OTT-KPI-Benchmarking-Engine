/**
 * TimestampNormalizer — parses a source's mapped timestamp, converts it to UTC,
 * preserves the original UTC offset, and assigns the record its UTC hour and
 * day buckets (Req 26.1, 26.2, 26.3, 26.4, 26.5).
 *
 * The four normalization rules from the design's "Timezone policy and time
 * bucketing" section map one-to-one onto acceptance criteria:
 *
 *   1. An explicit offset (`+05:30`, `-08:00`) or a `Z` suffix is honored and
 *      the original offset is preserved in `sourceUtcOffsetMinutes`, so the
 *      source value can always be reconstructed for audit (Req 26.1).
 *   2. A naive timestamp (no offset) is interpreted as UTC,
 *      `sourceUtcOffsetMinutes` is set to `null`, and the source column is
 *      reported as offset-less so the caller can flag it in the Column_Mapping
 *      modal (Req 26.2).
 *   3. A date-only value (`2025-03-14`) is anchored at `00:00:00Z` (Req 26.3).
 *   4. An unparseable timestamp is rejected with a reason, exactly like any
 *      other invalid required field (Req 26.4).
 *
 * Bucketing is delegated to the engine's `bucketTimestamp` (the single source
 * of truth for UTC hour/day assignment, Req 26.5) — this module never
 * reimplements bucket boundaries.
 *
 * Pure function: no DOM, no storage, no side effects. The same normalization is
 * used for file ingestion, manual entry, and the mock seeder alike.
 */

import { bucketTimestamp } from "@/engine/bucket";
import type { TimeBucket } from "@/models";

/**
 * A successfully normalized timestamp.
 */
export interface NormalizedTimestamp {
  ok: true;
  /** ISO 8601 timestamp normalized to UTC with a `Z` suffix. (Req 26.1) */
  timestampUtc: string;
  /**
   * The source timestamp's original UTC offset in minutes (e.g. `330` for
   * `+05:30`, `-480` for `-08:00`, `0` for `Z`), or `null` when the source
   * carried no offset and UTC was assumed. (Req 26.1, 26.2)
   */
  sourceUtcOffsetMinutes: number | null;
  /**
   * True when the source carried no offset and UTC was assumed, so the caller
   * can flag the timestamp column in the Column_Mapping modal. (Req 26.2)
   */
  offsetAssumed: boolean;
  /**
   * True when the source was a bare calendar date anchored at `00:00:00Z`.
   * (Req 26.3)
   */
  dateOnly: boolean;
  /** UTC hour and day buckets assigned from `timestampUtc`. (Req 26.5) */
  bucket: TimeBucket;
}

/**
 * A rejected timestamp: the value could not be parsed. (Req 26.4)
 */
export interface RejectedTimestamp {
  ok: false;
  /** Human-readable reason the timestamp was rejected. (Req 26.4) */
  reason: string;
}

/** The outcome of normalizing a single mapped timestamp. */
export type TimestampNormalizationResult = NormalizedTimestamp | RejectedTimestamp;

/**
 * Matches a date-only value: `YYYY-MM-DD` with no time component. (Req 26.3)
 */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Matches an ISO-like date-time and captures its optional trailing offset. The
 * time separator may be `T` or a space, seconds and fractional seconds are
 * optional, and the offset is `Z`, `+HH:MM`, `-HH:MM`, `+HHMM`, or `-HHMM`.
 *
 * Group 1: the date + time portion (no offset).
 * Group 2: the offset token (`Z`, `+05:30`, ...), or undefined when naive.
 */
const DATE_TIME =
  /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parse an explicit offset token into signed minutes. `Z` is `0`.
 *
 * @returns Offset in minutes, or `null` when the token is malformed.
 */
function parseOffsetMinutes(offset: string): number | null {
  if (offset === "Z" || offset === "z") return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const hours = Number(m[2]);
  const minutes = Number(m[3]);
  if (hours > 23 || minutes > 59) return null;
  return sign * (hours * 60 + minutes);
}

/**
 * Format an offset in minutes as an ISO offset token, e.g. `330` -> `+05:30`,
 * `0` -> `Z`. Used to build a string `Date.parse` interprets deterministically.
 */
function formatOffset(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "Z";
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/**
 * Normalize a single mapped timestamp to UTC and assign its time buckets.
 *
 * Trims the input first, then applies the four rules above in order:
 * date-only anchoring, explicit-offset honoring, and naive-as-UTC assumption
 * all produce a UTC `timestampUtc`; anything that does not match a recognized
 * shape (or names an impossible calendar instant) is rejected with a reason.
 *
 * @param raw The mapped timestamp value from the source, manual entry, or seed.
 * @returns A {@link NormalizedTimestamp} on success or a
 *   {@link RejectedTimestamp} with a reason on failure. (Req 26.1–26.5)
 */
export function normalizeTimestamp(raw: string): TimestampNormalizationResult {
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, reason: "Timestamp is empty." };
  }

  // Rule 3: a bare calendar date is anchored at 00:00:00Z. (Req 26.3)
  const dateMatch = DATE_ONLY.exec(value);
  if (dateMatch) {
    // Anchor at midnight UTC, then canonicalize through `toUtcIso` so the output
    // format matches the date-time paths (a trailing `.000Z`).
    const timestampUtc = toUtcIso(`${value}T00:00:00`, 0);
    if (timestampUtc === null) {
      return { ok: false, reason: `Timestamp "${raw}" is not a valid calendar date.` };
    }
    return finalize(timestampUtc, null, /* offsetAssumed */ false, /* dateOnly */ true);
  }

  // Rules 1 & 2: a date-time, with or without an offset. (Req 26.1, 26.2)
  const dtMatch = DATE_TIME.exec(value);
  if (dtMatch) {
    const [, dateTime, offsetToken] = dtMatch;
    // Use a `T` separator so every downstream string is canonical ISO 8601.
    const isoDateTime = dateTime.replace(" ", "T");

    if (offsetToken === undefined) {
      // Naive timestamp: interpret as UTC, offset absent. (Req 26.2)
      const timestampUtc = toUtcIso(isoDateTime, 0);
      if (timestampUtc === null) {
        return { ok: false, reason: `Timestamp "${raw}" names an invalid instant.` };
      }
      return finalize(timestampUtc, null, /* offsetAssumed */ true, /* dateOnly */ false);
    }

    // Explicit offset or Z: honor it and preserve the original offset. (Req 26.1)
    const offsetMinutes = parseOffsetMinutes(offsetToken);
    if (offsetMinutes === null) {
      return { ok: false, reason: `Timestamp "${raw}" has an invalid UTC offset.` };
    }
    const timestampUtc = toUtcIso(isoDateTime, offsetMinutes);
    if (timestampUtc === null) {
      return { ok: false, reason: `Timestamp "${raw}" names an invalid instant.` };
    }
    return finalize(timestampUtc, offsetMinutes, /* offsetAssumed */ false, /* dateOnly */ false);
  }

  // Rule 4: anything else is rejected with a reason. (Req 26.4)
  return { ok: false, reason: `Timestamp "${raw}" could not be parsed.` };
}

/**
 * Convert a naive ISO date-time plus a known offset into a UTC ISO string.
 * Builds an offset-qualified string so `Date.parse` resolves it deterministically
 * (a naive string would otherwise be read in the host's local zone).
 *
 * @returns The UTC ISO string, or `null` when the instant is invalid.
 */
function toUtcIso(isoDateTime: string, offsetMinutes: number): string | null {
  const qualified = `${isoDateTime}${formatOffset(offsetMinutes)}`;
  const ms = Date.parse(qualified);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Build a successful result, assigning the record its UTC hour/day buckets via
 * the engine's `bucketTimestamp` (never reimplemented here). (Req 26.5)
 */
function finalize(
  timestampUtc: string,
  sourceUtcOffsetMinutes: number | null,
  offsetAssumed: boolean,
  dateOnly: boolean,
): NormalizedTimestamp {
  return {
    ok: true,
    timestampUtc,
    sourceUtcOffsetMinutes,
    offsetAssumed,
    dateOnly,
    bucket: bucketTimestamp(timestampUtc),
  };
}
