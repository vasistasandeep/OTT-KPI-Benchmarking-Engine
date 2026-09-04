/**
 * Record grouping for the aggregation engine.
 *
 * `groupRecords` partitions valid records into disjoint groups keyed by
 * `(app, timePeriod, dimension tags)` before any KPI is computed (Req 5.6).
 * The `timePeriod` is the record's UTC bucket at the requested granularity
 * (hour or day), already assigned at ingestion (Req 26.5). The `dimension tags`
 * are the record's values for the dimensions being sliced on; when a record is
 * missing a value for a sliced dimension it is placed under the defined
 * `"Unknown"` member rather than dropped (Req 16.2).
 *
 * The partition is total over the input: every input record lands in exactly
 * one group, so the union of all groups is exactly the input set and no two
 * groups share a record. This is the guarantee the grouping-partition property
 * (Property 7) checks.
 *
 * Pure function: no DOM, no storage, no side effects.
 */

import type { AppAssignment, KPIRecord } from "@/models";
import type { DimensionId } from "@/registry/dimensions";
import { UNKNOWN_MEMBER } from "@/registry/dimensions";

/** Bucket granularity a group is keyed at. */
export type GroupGranularity = "hour" | "day";

/**
 * The identifying key of a group: the app, the UTC time bucket at the active
 * granularity, and the record's value for each sliced dimension (in the order
 * the dimensions were supplied). Missing dimension values are `"Unknown"`.
 */
export interface GroupKey {
  app: AppAssignment;
  /** UTC bucket value: `hourUtc` at hour granularity, `dayUtc` at day. */
  timePeriod: string;
  /** Value per sliced dimension, in the supplied dimension order. */
  dimensions: Record<DimensionId, string>;
}

/** A partition cell: its identifying key plus the records that fall in it. */
export interface RecordGroup {
  key: GroupKey;
  records: KPIRecord[];
}

/**
 * Partition `records` by `(app, timePeriod, dimension tags)`.
 *
 * @param records The valid records to partition. Callers pass records that
 *   have already survived ingestion validation; grouping does not re-validate.
 * @param dimensions The dimension ids that make up the active slice. A record's
 *   tag for each of these is read from `record.dimensions`; a missing or empty
 *   value maps to the `"Unknown"` member (Req 16.2). Dimensions not in this
 *   list do not participate in the key. Duplicate ids are ignored.
 * @param granularity Which UTC bucket to key on: `"hour"` uses `bucket.hourUtc`,
 *   `"day"` uses `bucket.dayUtc`. Defaults to `"day"`.
 * @returns One {@link RecordGroup} per distinct key. The groups are disjoint and
 *   their union is exactly `records` — no record is lost or duplicated.
 */
export function groupRecords(
  records: readonly KPIRecord[],
  dimensions: readonly DimensionId[] = [],
  granularity: GroupGranularity = "day",
): RecordGroup[] {
  // De-duplicate the sliced dimensions while preserving supplied order so the
  // key layout is stable and a repeated id cannot widen the key.
  const slicedDimensions: DimensionId[] = [];
  const seen = new Set<DimensionId>();
  for (const id of dimensions) {
    if (!seen.has(id)) {
      seen.add(id);
      slicedDimensions.push(id);
    }
  }

  const groups = new Map<string, RecordGroup>();

  for (const record of records) {
    const timePeriod =
      granularity === "hour" ? record.bucket.hourUtc : record.bucket.dayUtc;

    // Resolve the tag for each sliced dimension, defaulting missing/empty
    // values to the "Unknown" member (Req 16.2).
    const dimensionTags: Record<DimensionId, string> = {} as Record<
      DimensionId,
      string
    >;
    for (const id of slicedDimensions) {
      const value = record.dimensions?.[id];
      dimensionTags[id] = value == null || value === "" ? UNKNOWN_MEMBER : value;
    }

    const compositeKey = buildCompositeKey(
      record.app,
      timePeriod,
      slicedDimensions,
      dimensionTags,
    );

    const existing = groups.get(compositeKey);
    if (existing) {
      existing.records.push(record);
    } else {
      groups.set(compositeKey, {
        key: { app: record.app, timePeriod, dimensions: dimensionTags },
        records: [record],
      });
    }
  }

  return [...groups.values()];
}

/**
 * Build a stable string key from the group's identifying parts. Each part is
 * length-prefixed so no combination of app, time period, and dimension values
 * can collide with a different combination through delimiter injection.
 */
function buildCompositeKey(
  app: AppAssignment,
  timePeriod: string,
  slicedDimensions: readonly DimensionId[],
  dimensionTags: Record<DimensionId, string>,
): string {
  const parts: string[] = [encodePart(app), encodePart(timePeriod)];
  for (const id of slicedDimensions) {
    parts.push(encodePart(id));
    parts.push(encodePart(dimensionTags[id]));
  }
  return parts.join("|");
}

/** Length-prefix a part so `|` inside a value can never split the key. */
function encodePart(value: string): string {
  return `${value.length}:${value}`;
}
