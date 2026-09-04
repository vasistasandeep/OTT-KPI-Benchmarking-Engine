/**
 * Record rejection for the aggregation engine (Req 5.7, 4.3).
 *
 * Two distinct rejection rules, matching the two ingestion modes:
 *
 * - **Raw sessions (Req 5.7).** A session is *rejected whole* when any field
 *   the KPI requires is missing, non-numeric, or negative. A rejected session
 *   contributes to no sum, count, or percentile input. The reason names the
 *   offending field and what was wrong with it, so the data-quality panel can
 *   explain the exclusion rather than silently dropping the row.
 *
 * - **Pre-aggregated values (Req 4.3).** A single non-numeric value in a field
 *   mapped to a numeric KPI is *excluded and reported* — but only that value.
 *   The rest of the record's metrics are unaffected. This is a per-value
 *   exclusion, not a per-record rejection: pre-aggregated rows carry many KPI
 *   columns and one bad cell must not discard the others.
 *
 * All functions here are pure: they read their inputs and return partitions and
 * `RejectedRecord` notes. They never mutate inputs, touch the DOM, or read
 * storage. Rounding, presentation, and advisory surfacing are the caller's
 * concern.
 *
 * Requirements: 5.7 (raw record rejection), 4.3 (pre-aggregated value exclusion).
 */

import type { CanonicalKPIId } from "@/models/ids";
import type { KPIRecord, RawSessionFields } from "@/models/records";
import type { RejectedRecord } from "@/models/results";

/**
 * A raw session record paired with the id used to record a rejection. The
 * aggregation engine tracks each session's originating `KPIRecord.id`; tests and
 * lightweight callers may pass any stable string.
 */
export interface IdentifiedSession {
  /** The originating record id, used to populate `RejectedRecord.recordId`. */
  readonly id: string;
  /** The raw session payload to validate. */
  readonly session: RawSessionFields;
}

/**
 * The outcome of validating a batch of raw sessions against a required-field
 * set: the sessions that passed (safe to feed the compute functions) and a
 * `RejectedRecord` note for every one that failed.
 */
export interface RawValidationResult {
  /** Sessions in which every required field is present, numeric, and >= 0. */
  readonly valid: IdentifiedSession[];
  /** One note per rejected session, naming the field and the reason. */
  readonly rejected: RejectedRecord[];
}

/** Why a single field failed validation, used to build the rejection reason. */
type FieldFault =
  | { kind: "missing" }
  | { kind: "non_numeric"; value: unknown }
  | { kind: "negative"; value: number };

/**
 * Classify a single required field on a session. Returns `null` when the field
 * is a valid, finite, non-negative number; otherwise the specific fault.
 *
 * `NaN` and `Infinity` are treated as non-numeric: they are not usable in a
 * sum, count, or percentile and would silently corrupt an aggregate.
 */
function classifyField(value: unknown): FieldFault | null {
  if (value === undefined || value === null) {
    return { kind: "missing" };
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { kind: "non_numeric", value };
  }
  if (value < 0) {
    return { kind: "negative", value };
  }
  return null;
}

/** Render a `FieldFault` as a human-readable reason fragment for a field. */
function faultReason(field: string, fault: FieldFault): string {
  switch (fault.kind) {
    case "missing":
      return `required field "${field}" is missing`;
    case "non_numeric":
      return `field "${field}" is non-numeric (${describeValue(fault.value)})`;
    case "negative":
      return `field "${field}" is negative (${fault.value})`;
  }
}

/** A compact, safe description of an unexpected value for a reason string. */
function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return `"${value}"`;
  }
  if (typeof value === "number") {
    // Covers NaN / Infinity, which stringify readably.
    return String(value);
  }
  return typeof value;
}

/**
 * Partition raw sessions into those valid for a KPI and those rejected, given
 * the fields that KPI requires (Req 5.7).
 *
 * A session is rejected as soon as *any* required field is missing, non-numeric,
 * or negative; the reason names the first offending field. Optional fields (not
 * listed in `requiredFields`) are never a rejection cause here — a KPI that can
 * tolerate a missing field simply does not list it.
 *
 * @param sessions        The identified sessions to validate.
 * @param requiredFields  The session fields this KPI needs, all of which must
 *   be present, numeric, and non-negative for the session to contribute.
 * @returns the valid sessions and one `RejectedRecord` per rejected session.
 */
export function validateSessions(
  sessions: readonly IdentifiedSession[],
  requiredFields: readonly (keyof RawSessionFields)[],
): RawValidationResult {
  const valid: IdentifiedSession[] = [];
  const rejected: RejectedRecord[] = [];

  for (const item of sessions) {
    let fault: { field: string; fault: FieldFault } | null = null;
    for (const field of requiredFields) {
      const result = classifyField(item.session[field as string]);
      if (result) {
        fault = { field: field as string, fault: result };
        break;
      }
    }

    if (fault) {
      rejected.push({
        recordId: item.id,
        field: fault.field,
        reason: faultReason(fault.field, fault.fault),
      });
    } else {
      valid.push(item);
    }
  }

  return { valid, rejected };
}

/**
 * The outcome of screening a pre-aggregated record's metric value for one KPI
 * (Req 4.3): the numeric value to aggregate, or `null` when the value was
 * excluded, in which case `rejected` carries the report.
 */
export interface PreAggValueResult {
  /** The clean numeric value, or `null` when excluded. */
  readonly value: number | null;
  /** Present only when the value was excluded and must be reported. */
  readonly rejected?: RejectedRecord;
}

/**
 * Screen a single pre-aggregated metric value for a numeric KPI (Req 4.3).
 *
 * When the value is a finite number it is returned as-is. When it is
 * non-numeric (a string, `NaN`, `Infinity`, or otherwise not a finite number)
 * it is excluded and a `RejectedRecord` naming the KPI field is produced; the
 * rest of the record is unaffected by the caller.
 *
 * A genuinely absent metric (`undefined`) is not an error — the KPI simply has
 * no value on this record — so it returns `{ value: null }` without a report.
 *
 * @param recordId The originating record id for the report.
 * @param kpiId    The KPI whose mapped column this value came from.
 * @param value    The raw value pulled from the record's metrics map.
 */
export function screenPreAggregatedValue(
  recordId: string,
  kpiId: CanonicalKPIId,
  value: unknown,
): PreAggValueResult {
  if (value === undefined || value === null) {
    return { value: null };
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return {
      value: null,
      rejected: {
        recordId,
        field: kpiId,
        reason: `non-numeric value for "${kpiId}" excluded from aggregation (${describeValue(value)})`,
      },
    };
  }
  return { value };
}

/**
 * Screen the numeric metric for one KPI across many pre-aggregated records
 * (Req 4.3). Returns the clean values in input order (excluded and absent
 * values omitted) alongside one `RejectedRecord` per excluded non-numeric cell.
 *
 * This is the batch convenience over {@link screenPreAggregatedValue} used by
 * the aggregation engine when collecting a KPI's contributing values for a
 * slice.
 */
export function collectPreAggregatedValues(
  records: readonly KPIRecord[],
  kpiId: CanonicalKPIId,
): { values: number[]; rejected: RejectedRecord[] } {
  const values: number[] = [];
  const rejected: RejectedRecord[] = [];

  for (const record of records) {
    const raw = record.metrics?.[kpiId];
    const screened = screenPreAggregatedValue(record.id, kpiId, raw);
    if (screened.rejected) {
      rejected.push(screened.rejected);
    }
    if (screened.value !== null) {
      values.push(screened.value);
    }
  }

  return { values, rejected };
}
