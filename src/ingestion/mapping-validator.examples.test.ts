/**
 * Table-driven example tests for `validateMapping` (task 11.5).
 *
 * The sanity unit tests in `mapping-validator.test.ts` pin one representative
 * case per gate. These exhaustively walk the acceptance criteria from a data
 * table so a new scenario is covered by adding a row:
 *
 *   - Invalid-schema rejection when no columns are mappable (Req 6.4, 16.4):
 *     the file resolves to neither a KPI nor a dimension, so its records must
 *     not be persisted and confirmation is never offered.
 *   - Missing-KPI block (Req 7.8): the schema is mappable (a dimension, say)
 *     but no column maps to a KPI, so confirmation is blocked.
 *   - The `(kpiId, app)` duplicate rule (Req 7.9) in its three forms:
 *       * valid — one KPI mapped at most once per effective app;
 *       * blocked — two columns colliding on the same `(kpiId, app)` pair;
 *       * long-layout collapse — two long/file-level columns for the same KPI
 *         (no per-column app) collapse to one effective app and collide.
 *
 * Requirements: 6.4, 7.8, 7.9.
 */

import { describe, it, expect } from "vitest";
import type { CanonicalKPIId } from "@/models/ids";
import type { MappingTarget } from "@/models/config";
import {
  validateMapping,
  type MappingAssignments,
  type MappingValidationErrorKind,
} from "./mapping-validator";

// ---------------------------------------------------------------------------
// Target builders — keep the tables terse and unambiguous.
// ---------------------------------------------------------------------------

const VST = "vst_p50" as CanonicalKPIId;
const REBUFFER = "rebuffer_ratio" as CanonicalKPIId;

/** A KPI target, optionally app-qualified (wide layout). */
function kpi(kpiId: CanonicalKPIId = VST, app?: "App_A" | "App_B"): MappingTarget {
  return app ? { kind: "kpi", kpiId, app } : { kind: "kpi", kpiId };
}

const DIMENSION: MappingTarget = { kind: "dimension", dimensionId: "platform" };
const TIMESTAMP: MappingTarget = { kind: "timestamp" };
const APP: MappingTarget = { kind: "app" };
const UNMAPPED: MappingTarget = { kind: "unmapped" };

// ===========================================================================
// Req 6.4 / 16.4 — invalid-schema rejection when no columns are mappable.
// A column is "mappable" only when it targets a KPI or a dimension; timestamp,
// app, and unmapped columns do not count, so a file made only of those is an
// invalid schema whose records are not saved.
// ===========================================================================

interface InvalidSchemaCase {
  readonly name: string;
  readonly assignments: MappingAssignments;
}

const INVALID_SCHEMA_CASES: readonly InvalidSchemaCase[] = [
  { name: "empty assignment set", assignments: {} },
  { name: "only a timestamp column", assignments: { ts: TIMESTAMP } },
  { name: "only an app column", assignments: { which_app: APP } },
  { name: "only unmapped columns", assignments: { junk: UNMAPPED, more_junk: UNMAPPED } },
  {
    name: "a mix of timestamp, app, and unmapped only",
    assignments: { ts: TIMESTAMP, which_app: APP, junk: UNMAPPED },
  },
];

describe("validateMapping examples — invalid schema, no mappable columns (Req 6.4, 16.4)", () => {
  it.each(INVALID_SCHEMA_CASES)(
    "rejects $name as an invalid schema and offers no other finding",
    ({ assignments }) => {
      const result = validateMapping(assignments);

      expect(result.valid).toBe(false);
      // The invalid-schema finding is raised alone: it is mutually exclusive
      // with the missing-KPI finding (an empty schema trivially has no KPI).
      expect(result.errors.map((e) => e.kind)).toEqual<MappingValidationErrorKind[]>([
        "no_mappable_columns",
      ]);
      expect(result.duplicateConflicts).toHaveLength(0);
    },
  );
});

// ===========================================================================
// Req 7.8 — missing-KPI block. The schema is mappable (has a dimension) but no
// column maps to a KPI, so there is nothing to benchmark and confirmation is
// blocked. This is recoverable inside the modal, unlike the invalid schema.
// ===========================================================================

interface MissingKpiCase {
  readonly name: string;
  readonly assignments: MappingAssignments;
}

const MISSING_KPI_CASES: readonly MissingKpiCase[] = [
  { name: "a lone dimension", assignments: { platform: DIMENSION } },
  { name: "a dimension plus a timestamp", assignments: { platform: DIMENSION, ts: TIMESTAMP } },
  {
    name: "a dimension alongside app and unmapped columns",
    assignments: { platform: DIMENSION, which_app: APP, junk: UNMAPPED },
  },
];

describe("validateMapping examples — missing-KPI block (Req 7.8)", () => {
  it.each(MISSING_KPI_CASES)(
    "blocks confirmation for $name because no column maps to a KPI",
    ({ assignments }) => {
      const result = validateMapping(assignments);

      expect(result.valid).toBe(false);
      expect(result.errors.map((e) => e.kind)).toContain<MappingValidationErrorKind>(
        "no_kpi_mapped",
      );
      // The schema *is* mappable, so the invalid-schema finding must not fire.
      expect(result.errors.map((e) => e.kind)).not.toContain<MappingValidationErrorKind>(
        "no_mappable_columns",
      );
      expect(result.duplicateConflicts).toHaveLength(0);
    },
  );
});

// ===========================================================================
// Req 7.9 — the (kpiId, app) duplicate rule in its valid / blocked / long-
// layout-collapse forms.
// ===========================================================================

interface DuplicateCase {
  readonly name: string;
  readonly assignments: MappingAssignments;
  /** Whether the mapping should pass. */
  readonly valid: boolean;
  /** For blocked cases, the expected conflicts (kpiId, app, offending columns). */
  readonly expectedConflicts?: readonly {
    readonly kpiId: CanonicalKPIId;
    readonly app: "App_A" | "App_B" | null;
    readonly columns: readonly string[];
  }[];
}

const DUPLICATE_CASES: readonly DuplicateCase[] = [
  // --- valid: one KPI at most once per effective app ---------------------
  {
    name: "wide layout — one KPI once under each of two apps",
    assignments: { vst_a: kpi(VST, "App_A"), vst_b: kpi(VST, "App_B") },
    valid: true,
  },
  {
    name: "wide layout — two distinct KPIs each under two apps",
    assignments: {
      vst_a: kpi(VST, "App_A"),
      vst_b: kpi(VST, "App_B"),
      reb_a: kpi(REBUFFER, "App_A"),
      reb_b: kpi(REBUFFER, "App_B"),
    },
    valid: true,
  },
  {
    name: "long layout — one KPI column plus a dimension",
    assignments: { vst: kpi(), platform: DIMENSION, ts: TIMESTAMP },
    valid: true,
  },
  // --- blocked: same (kpiId, app) pair reached by two columns ------------
  {
    name: "wide layout — two columns collide on the same KPI and app",
    assignments: { vst_a: kpi(VST, "App_A"), startup_a: kpi(VST, "App_A") },
    valid: false,
    expectedConflicts: [{ kpiId: VST, app: "App_A", columns: ["vst_a", "startup_a"] }],
  },
  {
    name: "wide layout — separate collisions on each app of one KPI",
    assignments: {
      vst_a: kpi(VST, "App_A"),
      startup_a: kpi(VST, "App_A"),
      vst_b: kpi(VST, "App_B"),
      startup_b: kpi(VST, "App_B"),
    },
    valid: false,
    expectedConflicts: [
      { kpiId: VST, app: "App_A", columns: ["vst_a", "startup_a"] },
      { kpiId: VST, app: "App_B", columns: ["vst_b", "startup_b"] },
    ],
  },
  // --- long-layout collapse: no per-column app → one effective app -------
  {
    name: "long layout — two columns for the same KPI collapse to one app and collide",
    assignments: { vst: kpi(), vst2: kpi() },
    valid: false,
    expectedConflicts: [{ kpiId: VST, app: null, columns: ["vst", "vst2"] }],
  },
  {
    name: "long layout — three columns for the same KPI all collide under one app",
    assignments: { vst: kpi(), vst2: kpi(), vst3: kpi() },
    valid: false,
    expectedConflicts: [{ kpiId: VST, app: null, columns: ["vst", "vst2", "vst3"] }],
  },
];

describe("validateMapping examples — (kpiId, app) duplicate rule (Req 7.9)", () => {
  it.each(DUPLICATE_CASES)("$name", ({ assignments, valid, expectedConflicts }) => {
    const result = validateMapping(assignments);

    expect(result.valid).toBe(valid);

    if (valid) {
      expect(result.errors).toHaveLength(0);
      expect(result.duplicateConflicts).toHaveLength(0);
      return;
    }

    // Blocked: exactly the expected duplicate conflicts, order-independent.
    expect(expectedConflicts).toBeDefined();
    expect(result.duplicateConflicts).toHaveLength(expectedConflicts!.length);

    for (const expected of expectedConflicts!) {
      const match = result.duplicateConflicts.find(
        (c) => c.kpiId === expected.kpiId && c.app === expected.app,
      );
      expect(match, `expected a conflict for ${expected.kpiId}/${expected.app}`).toBeDefined();
      // Same offending columns, regardless of order.
      expect([...match!.columns].sort()).toEqual([...expected.columns].sort());
      // Every duplicate conflict is mirrored by a blocking error whose detail
      // names the KPI, the app, and each offending column (Req 7.9).
      expect(match!.detail).toContain(String(expected.kpiId));
      for (const col of expected.columns) {
        expect(match!.detail).toContain(col);
      }
      expect(result.errors.some((e) => e.kind === "duplicate_kpi_app" && e.detail === match!.detail)).toBe(
        true,
      );
    }
  });
});
