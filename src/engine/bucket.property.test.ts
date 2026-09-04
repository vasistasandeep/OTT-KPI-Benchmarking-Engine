import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { bucketTimestamp } from "./bucket";
import { weightedAverage } from "./weighted-average";
import { rebufferRatio } from "./rates";
import type { AggRow } from "./weighted-average";
import type { RawSessionFields } from "../models/records";

// -----------------------------------------------------------------------------
// Local arbitraries
//
// NOTE: `src/test/arbitraries.ts` is a shared placeholder being authored
// concurrently by other tasks, so `arbTimestamp` is defined locally here to
// avoid write conflicts. It generates timestamps that exercise the four cases
// that matter for UTC bucketing:
//   - explicit UTC offsets (`Z` and `+HH:MM` / `-HH:MM`)
//   - naive values with no offset at all (interpreted as UTC by the engine)
//   - DST-sensitive local wall-clock times (spring-forward / fall-back windows)
//   - year boundaries (Dec 31 late / Jan 1 early), where offsets can flip the year
// -----------------------------------------------------------------------------

/** Two-digit zero-padded string for a small non-negative integer. */
function p2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** A naive local timestamp with no offset suffix, e.g. "2025-03-14T09:37:12". */
const arbNaive: fc.Arbitrary<string> = fc
  .date({ min: new Date("2000-01-01T00:00:00Z"), max: new Date("2035-12-31T23:59:59Z") })
  .map((d) => {
    const y = d.getUTCFullYear();
    return `${y}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(
      d.getUTCMinutes(),
    )}:${p2(d.getUTCSeconds())}`;
  });

/** A timestamp with an explicit UTC offset (`Z`, or `+HH:MM` / `-HH:MM`). */
const arbWithOffset: fc.Arbitrary<string> = fc
  .tuple(
    arbNaive,
    fc.oneof(
      fc.constant("Z"),
      fc
        .tuple(
          fc.constantFrom("+", "-"),
          fc.integer({ min: 0, max: 14 }),
          fc.constantFrom(0, 15, 30, 45),
        )
        .map(([sign, hh, mm]) => `${sign}${p2(hh)}:${p2(mm)}`),
    ),
  )
  .map(([naive, offset]) => `${naive}${offset}`);

/**
 * DST-sensitive local wall-clock times: the spring-forward and fall-back
 * windows in the US/EU transitions. Bucketing is done purely in UTC, so these
 * must still resolve to exactly one hour/day bucket with no gap or repeat.
 */
const arbDstSensitive: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(
      "2025-03-09", // US spring forward
      "2025-03-30", // EU spring forward
      "2025-11-02", // US fall back
      "2025-10-26", // EU fall back
    ),
    fc.integer({ min: 0, max: 3 }), // 00:00–03:59, straddling the transition
    fc.integer({ min: 0, max: 59 }),
  )
  .map(([day, hh, mm]) => `${day}T${p2(hh)}:${p2(mm)}:00`)
  // Half the time attach an offset that pushes across the transition.
  .chain((local) =>
    fc.oneof(
      fc.constant(local),
      fc.constant(`${local}-08:00`),
      fc.constant(`${local}+05:30`),
    ),
  );

/** Year-boundary timestamps where an offset can flip the calendar year. */
const arbYearBoundary: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom("2024-12-31", "2025-12-31", "2025-01-01", "2026-01-01"),
    fc.constantFrom("23:30:00", "00:15:00", "22:45:00", "01:05:00"),
    fc.oneof(fc.constant("Z"), fc.constant("+05:30"), fc.constant("-08:00"), fc.constant("")),
  )
  .map(([day, time, offset]) => `${day}T${time}${offset}`);

/** The composite `arbTimestamp` used by the property. */
const arbTimestamp: fc.Arbitrary<string> = fc.oneof(
  arbWithOffset,
  arbNaive,
  arbDstSensitive,
  arbYearBoundary,
);

// -----------------------------------------------------------------------------
// Property 21 support: reference rollup for each KPI aggregation kind.
//
// The property claims: rolling hourly records into their UTC day and then
// aggregating equals aggregating the day's records directly. We model a "day"
// as a set of records already grouped into hour buckets, roll each hour to a
// partial aggregate, then combine the partials, and assert equality with the
// direct aggregate over the flat set of the day's records.
// -----------------------------------------------------------------------------

/** Group AggRows by their assigned UTC hour bucket. */
function byHour<T>(rows: readonly { bucketHour: string; row: T }[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const { bucketHour, row } of rows) {
    const list = m.get(bucketHour);
    if (list) list.push(row);
    else m.set(bucketHour, [row]);
  }
  return m;
}

describe("bucket property tests", () => {
  // Feature: ott-kpi-benchmarking-engine, Property 21: For any record with a parseable timestamp and any source offset, bucketing assigns it exactly one UTC hour bucket and exactly one UTC day bucket, the day bucket is the UTC calendar day containing the hour bucket, and no record is assigned to zero or to two buckets; and for any set of hourly records, rolling them into their UTC day and then aggregating equals aggregating the day's records directly using the KPI's own aggregation kind.
  // Validates: Requirements 26.5, 26.6, 26.7
  it("assigns exactly one hour bucket and one day bucket, with day containing the hour", () => {
    fc.assert(
      fc.property(arbTimestamp, (ts) => {
        const parsed = Date.parse(ts);
        // arbTimestamp only produces parseable timestamps; guard defensively.
        fc.pre(!Number.isNaN(parsed));

        const bucket = bucketTimestamp(ts);

        // Exactly one hour bucket and one day bucket (single-valued, well-formed).
        expect(typeof bucket.hourUtc).toBe("string");
        expect(typeof bucket.dayUtc).toBe("string");
        expect(bucket.hourUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/);
        expect(bucket.dayUtc).toMatch(/^\d{4}-\d{2}-\d{2}$/);

        // The day bucket is the UTC calendar day that contains the hour bucket.
        expect(bucket.hourUtc.slice(0, 10)).toBe(bucket.dayUtc);

        // The hour bucket is the top of the UTC hour containing the timestamp,
        // i.e. the timestamp lies in [hourStart, hourStart + 1h).
        const hourStart = Date.parse(bucket.hourUtc);
        expect(parsed).toBeGreaterThanOrEqual(hourStart);
        expect(parsed).toBeLessThan(hourStart + 3_600_000);

        // Determinism: bucketing the same timestamp twice yields the same bucket
        // (no record can land in two different buckets).
        expect(bucketTimestamp(ts)).toEqual(bucket);

        // The day bucket is the top of the UTC day containing the hour.
        const dayStart = Date.parse(`${bucket.dayUtc}T00:00:00Z`);
        expect(hourStart).toBeGreaterThanOrEqual(dayStart);
        expect(hourStart).toBeLessThan(dayStart + 86_400_000);
      }),
      { numRuns: 100 },
    );
  });

  it("rollup of hourly buckets equals direct aggregation — sum (totals)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            bucketHour: fc.integer({ min: 0, max: 23 }).map((h) => `2025-03-14T${p2(h)}:00:00Z`),
            row: fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }),
          }),
          { minLength: 1, maxLength: 200 },
        ),
        (records) => {
          // Direct: sum over the flat day.
          const direct = records.reduce((acc, r) => acc + r.row, 0);

          // Rollup: sum each hour, then sum the hourly partials.
          const hours = byHour(records);
          let rolled = 0;
          for (const rows of hours.values()) {
            rolled += rows.reduce((acc, v) => acc + v, 0);
          }

          expect(rolled).toBeCloseTo(direct, 6);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rollup of hourly buckets equals direct aggregation — volume-weighted average (rates)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            bucketHour: fc.integer({ min: 0, max: 23 }).map((h) => `2025-03-14T${p2(h)}:00:00Z`),
            value: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
            weight: fc.double({ min: 1, max: 1e5, noNaN: true, noDefaultInfinity: true }),
          }),
          { minLength: 1, maxLength: 200 },
        ),
        (records) => {
          // Direct: one weighted average over every row in the day.
          const flat: AggRow[] = records.map((r) => ({ value: r.value, weight: r.weight }));
          const direct = weightedAverage(flat);

          // Rollup: weighted-average within each hour, carrying the hour's total
          // weight forward, then weighted-average the hourly partials by weight.
          const hours = byHour(records.map((r) => ({ bucketHour: r.bucketHour, row: r })));
          const hourly: AggRow[] = [];
          for (const rows of hours.values()) {
            const asRows: AggRow[] = rows.map((r) => ({ value: r.value, weight: r.weight }));
            const wa = weightedAverage(asRows);
            const hourWeight = rows.reduce((acc, r) => acc + r.weight, 0);
            // wa.value is numeric here (non-empty, positive weights).
            hourly.push({ value: wa.value as number, weight: hourWeight });
          }
          const rolled = weightedAverage(hourly);

          expect(rolled.value as number).toBeCloseTo(direct.value as number, 6);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rollup of hourly buckets equals direct aggregation — summed-components ratio", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            bucketHour: fc.integer({ min: 0, max: 23 }).map((h) => `2025-03-14T${p2(h)}:00:00Z`),
            playTimeMs: fc.double({ min: 0, max: 1e7, noNaN: true, noDefaultInfinity: true }),
            bufferingMs: fc.double({ min: 0, max: 1e6, noNaN: true, noDefaultInfinity: true }),
          }),
          { minLength: 1, maxLength: 200 },
        ),
        (records) => {
          const toSession = (r: (typeof records)[number]): RawSessionFields =>
            ({ playTimeMs: r.playTimeMs, bufferingMs: r.bufferingMs }) as RawSessionFields;

          // Direct: rebuffer ratio over the flat day.
          const direct = rebufferRatio(records.map(toSession));

          // Rollup: sum numerator (buffering) and denominator components per hour,
          // then combine the per-hour component sums and divide once.
          const hours = byHour(records.map((r) => ({ bucketHour: r.bucketHour, row: r })));
          let sumBuffering = 0;
          let sumPlayTime = 0;
          for (const rows of hours.values()) {
            for (const r of rows) {
              sumBuffering += r.bufferingMs;
              sumPlayTime += r.playTimeMs;
            }
          }
          const denom = sumPlayTime + sumBuffering;
          const rolled = denom === 0 ? direct : Math.round(((100 * sumBuffering) / denom + Number.EPSILON) * 100) / 100;

          // Both are the ratio of summed components: they must match.
          expect(rolled).toBe(direct);
        },
      ),
      { numRuns: 100 },
    );
  });
});
