/**
 * Property-based coverage for raw-record rejection (Req 5.7, 4.3).
 *
 * Records the equivalence guarantee that record rejection must uphold: dropping
 * the invalid sessions before computing a KPI must leave the KPI identical to
 * computing it over only the sessions that were valid all along, and the count
 * of rejected notes must equal the count of invalid sessions injected.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { RawSessionFields } from "../models/records";
import { rebufferRatio, vsfRate } from "./rates";
import { validateSessions, type IdentifiedSession } from "./rejection";

// Local arbitraries (do NOT edit the shared src/test/arbitraries.ts).

/** The required fields for the two rate KPIs exercised below. */
const REQUIRED_FIELDS: (keyof RawSessionFields)[] = [
  "bufferingMs",
  "playTimeMs",
  "startFailure",
  "playbackAttempt",
];

/** A generated session tagged with whether it was built to be valid. */
interface TaggedSession {
  readonly item: IdentifiedSession;
  /** True when every required field is present, finite, and non-negative. */
  readonly isValid: boolean;
}

/** A fully-valid session: every required field present, finite, non-negative. */
const arbValidFields = fc.record({
  bufferingMs: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
  playTimeMs: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
  startFailure: fc.constantFrom<0 | 1>(0, 1),
  playbackAttempt: fc.constantFrom<0 | 1>(0, 1),
});

/**
 * The three ways a session can be invalid under Req 5.7, each mutating one
 * required field of an otherwise-valid record: a missing field, a non-numeric
 * value, or a negative number.
 */
const arbInvalidFields = arbValidFields.chain((base) =>
  fc.tuple(
    fc.constantFrom<keyof RawSessionFields>(...REQUIRED_FIELDS),
    fc.constantFrom("missing", "non_numeric", "negative"),
  ).map(([field, kind]) => {
    const fields: RawSessionFields = { ...base };
    switch (kind) {
      case "missing":
        delete fields[field as string];
        break;
      case "non_numeric":
        // A string in a numeric slot is non-numeric per classifyField.
        (fields as Record<string, unknown>)[field as string] = "not-a-number";
        break;
      case "negative":
        (fields as Record<string, unknown>)[field as string] = -1;
        break;
    }
    return fields;
  }),
);

/**
 * `arbSession` with a tunable validity flag: `valid` sessions carry clean
 * required fields, `invalid` sessions inject exactly one Req-5.7 fault. Each
 * carries a stable id so rejections can be tallied.
 */
const arbSession: fc.Arbitrary<TaggedSession> = fc
  .tuple(fc.uuid(), fc.boolean(), arbValidFields, arbInvalidFields)
  .map(([id, shouldBeValid, validFields, invalidFields]) => ({
    item: { id, session: shouldBeValid ? validFields : invalidFields },
    isValid: shouldBeValid,
  }));

// Feature: ott-kpi-benchmarking-engine, Property 8: For any mix of valid and invalid raw records (invalid = missing required field, non-numeric, or negative), the KPI computed over the full set equals the KPI computed over the valid subset alone, and the count of rejected records equals the count of invalid records.
describe("validateSessions — Property 8: rejected-records equivalence", () => {
  it("KPI over the full set (after rejection) equals KPI over the valid subset, and rejected count equals invalid count", () => {
    fc.assert(
      fc.property(fc.array(arbSession, { maxLength: 50 }), (tagged) => {
        const all = tagged.map((t) => t.item);
        const expectedValid = tagged.filter((t) => t.isValid).map((t) => t.item);
        const expectedInvalidCount = tagged.length - expectedValid.length;

        const { valid, rejected } = validateSessions(all, REQUIRED_FIELDS);

        // Rejected count equals the count of invalid records injected.
        expect(rejected).toHaveLength(expectedInvalidCount);
        expect(valid).toHaveLength(expectedValid.length);

        // KPI over the full set (post-rejection valid subset) equals the KPI
        // computed over only the sessions known to be valid all along.
        const validSessions = valid.map((v) => v.session);
        const expectedSessions = expectedValid.map((v) => v.session);

        expect(rebufferRatio(validSessions)).toEqual(rebufferRatio(expectedSessions));
        expect(vsfRate(validSessions)).toEqual(vsfRate(expectedSessions));
      }),
      { numRuns: 100 },
    );
  });
});
