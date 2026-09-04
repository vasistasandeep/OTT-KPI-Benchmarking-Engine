/**
 * Slice filtering for the recompute pipeline.
 *
 * A {@link FilterSlice} describes the analyst's active view: a date range, a
 * bucket granularity, per-dimension chip selections, and an App_A/App_B toggle.
 * `applySlice` turns that view into the concrete subset of a dataset's records
 * the aggregation engine should see.
 *
 * Two design rules are enforced here so the slice is always reproducible and
 * unambiguous (design "Date-range boundaries", Req 26.7, 26.8, 26.9):
 *
 * - **Inclusive UTC bucket boundaries.** A record is in range when
 *   `from <= record.bucket.dayUtc <= to` at day granularity, or
 *   `from <= record.bucket.hourUtc <= to` at hour granularity. Both ends are
 *   inclusive, and the comparison is on the normalized UTC bucket, never on the
 *   raw timestamp or a local rendering (Req 26.7).
 * - **Presets resolved to explicit from/to.** The `7d`/`30d` presets are
 *   resolved to explicit `from`/`to` bucket strings *before* filtering, relative
 *   to a supplied "now", so the same slice yields the same records regardless of
 *   when it is evaluated (Req 26.8, 26.9). The window is the last N complete UTC
 *   days plus the current partial day.
 *
 * Pure functions: no DOM, no storage, no mutation of inputs.
 */

import type { KPIRecord } from "@/models/records";
import type { FilterSlice } from "@/models/results";
import type { DimensionId } from "@/models/ids";
import { UNKNOWN_MEMBER } from "@/registry/dimensions";

const MS_PER_DAY = 86_400_000;

/** Number of days each preset spans, counting back from (and including) today. */
const PRESET_DAYS: Record<"7d" | "30d", number> = {
  "7d": 7,
  "30d": 30,
};

/** A concrete, explicit date window on the UTC bucket, both ends inclusive. */
export interface ResolvedDateRange {
  /** Inclusive lower bound, as a bucket string at the slice's granularity. */
  from: string;
  /** Inclusive upper bound, as a bucket string at the slice's granularity. */
  to: string;
}

/** The UTC `YYYY-MM-DD` day of a millisecond epoch value. */
function dayUtcOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The bucket string for a UTC day at the requested granularity: the day itself
 * at day granularity, or the day's first/last hour at hour granularity. The
 * `edge` selects the top-of-day hour for a lower bound and the last hour for an
 * upper bound so an hour-granularity window still spans the whole boundary day.
 */
function bucketAt(dayUtc: string, granularity: "hour" | "day", edge: "start" | "end"): string {
  if (granularity === "day") {
    return dayUtc;
  }
  return edge === "start" ? `${dayUtc}T00:00:00Z` : `${dayUtc}T23:00:00Z`;
}

/**
 * Resolve a {@link FilterSlice}'s date range to an explicit, inclusive `from`/`to`
 * pair expressed on the slice's bucket granularity (Req 26.8, 26.9).
 *
 * `7d`/`30d` presets become the last N complete UTC days plus the current
 * partial day, relative to `nowMs` (defaults to `Date.now()`, injected by tests
 * for reproducibility). A `custom` range passes its own `from`/`to` through,
 * normalized to the bucket granularity; a custom range missing a bound is left
 * unbounded on that side.
 */
export function resolveDateRange(
  slice: FilterSlice,
  nowMs: number = Date.now(),
): ResolvedDateRange {
  const { dateRange, granularity } = slice;

  if (dateRange.preset === "custom") {
    // Custom ranges are already explicit; normalize any date-only bound to the
    // slice granularity. An absent bound stays unbounded (min/max sentinel).
    const from = dateRange.from
      ? bucketAt(dateRange.from.slice(0, 10), granularity, "start")
      : bucketAt("0000-01-01", granularity, "start");
    const to = dateRange.to
      ? bucketAt(dateRange.to.slice(0, 10), granularity, "end")
      : bucketAt("9999-12-31", granularity, "end");
    return { from, to };
  }

  const days = PRESET_DAYS[dateRange.preset];
  const todayUtc = dayUtcOf(nowMs);
  // The window includes today (the current partial day) plus the previous
  // (days - 1) complete days, so `7d` spans today and the six days before it.
  const fromMs = Date.parse(`${todayUtc}T00:00:00Z`) - (days - 1) * MS_PER_DAY;
  const fromDay = dayUtcOf(fromMs);

  return {
    from: bucketAt(fromDay, granularity, "start"),
    to: bucketAt(todayUtc, granularity, "end"),
  };
}

/**
 * Whether a record falls within `[from, to]` on its UTC bucket at the given
 * granularity. Both ends inclusive; the comparison is lexicographic on the ISO
 * bucket string, which is monotonic in time for the fixed formats we emit, so
 * it matches chronological order without parsing (Req 26.7).
 */
function inDateRange(record: KPIRecord, range: ResolvedDateRange, granularity: "hour" | "day"): boolean {
  const bucket = granularity === "day" ? record.bucket.dayUtc : record.bucket.hourUtc;
  return bucket >= range.from && bucket <= range.to;
}

/**
 * Whether a record matches the slice's per-dimension chip selections. A
 * dimension with no (or an empty) selection is unconstrained. A record missing
 * a value for a selected dimension is treated as the `"Unknown"` member, so an
 * explicit `"Unknown"` selection includes it (Req 16.2, 10.3).
 */
function matchesDimensions(record: KPIRecord, slice: FilterSlice): boolean {
  for (const [dim, selected] of Object.entries(slice.dimensionSelections)) {
    if (!selected || selected.length === 0) {
      continue;
    }
    const value = record.dimensions?.[dim as DimensionId] ?? UNKNOWN_MEMBER;
    if (!selected.includes(value)) {
      return false;
    }
  }
  return true;
}

/**
 * Apply a {@link FilterSlice} to a dataset's records, returning only those in
 * the resolved date window, matching every selected dimension, and belonging to
 * a toggled app (Req 10.3, 10.4, 26.7).
 *
 * @param records the active dataset's records.
 * @param slice   the active filter slice.
 * @param nowMs   the reference "now" for preset resolution (test-injectable).
 */
export function applySlice(
  records: readonly KPIRecord[],
  slice: FilterSlice,
  nowMs: number = Date.now(),
): KPIRecord[] {
  const range = resolveDateRange(slice, nowMs);
  const apps = slice.apps.length > 0 ? new Set(slice.apps) : null;

  return records.filter(
    (record) =>
      inDateRange(record, range, slice.granularity) &&
      (apps === null || apps.has(record.app)) &&
      matchesDimensions(record, slice),
  );
}
