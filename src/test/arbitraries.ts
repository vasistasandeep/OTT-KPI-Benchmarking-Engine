// Custom fast-check arbitraries for the OTT KPI Benchmarking Engine property tests.
//
// This is a placeholder module. The concrete generators are implemented alongside
// the code they exercise, in later tasks. Per the design, the following custom
// arbitraries will be exported here:
//
//   - arbSession    : a raw session with tunable validity and an optional user identifier
//   - arbAggRow     : a value plus an optional weight
//   - arbHeader     : source header strings including alias, app-suffix, and unit-suffix variants
//   - arbKPIRecord  : a canonical KPIRecord
//   - arbUnitPair   : a KPI paired with one of its accepted units
//   - arbTimestamp  : timestamps spanning offsets, naive values, and DST-sensitive local times
//   - arbLayoutPair : the same logical rows rendered in both long and wide form
//
// Each is defined with `fast-check` (imported as `fc`) and consumed by the
// property-based tests, which run a minimum of 100 cases via
// `fc.assert(fc.property(...), { numRuns: 100 })`.

import fc from "fast-check";

/**
 * `arbHeader` — a source header string.
 *
 * A bounded alphanumeric + underscore string with a guaranteed non-empty
 * leading letter. Bounding the length (~30) and the alphabet keeps generated
 * header sets small and cheap to normalize/sort/hash, so a 100-run property
 * never approaches a fast-check hang. The non-empty first char keeps the header
 * from normalizing to an empty token (which the reuse-key hash drops).
 */
export const arbHeader: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
    fc.stringMatching(/^[A-Za-z0-9_]{0,29}$/),
  )
  .map(([head, tail]) => head + tail);
