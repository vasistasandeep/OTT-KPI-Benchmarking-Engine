/**
 * UTC time bucketing for the aggregation engine.
 *
 * `bucketTimestamp` is a total function: every record with a valid
 * `timestampUtc` is assigned exactly one `hourUtc` and exactly one `dayUtc`,
 * where `dayUtc` is the UTC calendar day that contains `hourUtc`. No record
 * ever falls into two buckets and none into zero. Because bucketing is done
 * entirely in UTC there are no DST gaps or repeated hours to resolve.
 *
 * Pure function: no DOM, no storage, no side effects. (Req 26.5)
 */

import type { TimeBucket } from "@/models";

/**
 * Assign a UTC timestamp to its hour and day buckets.
 *
 * The input is expected to be an ISO 8601 timestamp already normalized to UTC
 * (see Req 26.1). The function truncates to the top of the containing UTC hour
 * for `hourUtc` and to the containing UTC calendar day for `dayUtc`.
 *
 * @param timestampUtc ISO 8601 UTC timestamp, e.g. "2025-03-14T09:37:12.482Z".
 * @returns A {@link TimeBucket} with `hourUtc` (e.g. "2025-03-14T09:00:00Z")
 *   and `dayUtc` (e.g. "2025-03-14").
 * @throws RangeError when `timestampUtc` cannot be parsed into a valid date.
 *   Ingestion rejects unparseable timestamps before this point (Req 26.4), so
 *   callers pass only valid timestamps; the guard keeps the function total by
 *   never returning an ill-formed bucket.
 */
export function bucketTimestamp(timestampUtc: string): TimeBucket {
  const ms = Date.parse(timestampUtc);
  if (Number.isNaN(ms)) {
    throw new RangeError(`bucketTimestamp: unparseable timestamp "${timestampUtc}"`);
  }

  const date = new Date(ms);

  const year = date.getUTCFullYear();
  const month = pad2(date.getUTCMonth() + 1);
  const day = pad2(date.getUTCDate());
  const hour = pad2(date.getUTCHours());

  const dayUtc = `${year}-${month}-${day}`;
  const hourUtc = `${dayUtc}T${hour}:00:00Z`;

  return { hourUtc, dayUtc };
}

/** Left-pad a non-negative integer to two digits. */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}
