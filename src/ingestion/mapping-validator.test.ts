/**
 * Sanity unit tests for `validateMapping`.
 *
 * The exhaustive example coverage lives in task 11.5. These pin the core
 * behaviours called out in Req 6.4, 7.8, 7.9, 16.4: the invalid-schema verdict
 * on a file with no mappable columns, the missing-KPI block, the duplicate
 * `(kpiId, app)` block at pair granularity, and the wide-layout allowance of
 * one KPI under two apps.
 */

import { describe, it, expect } from "vitest";
import type { CanonicalKPIId } from "@/models/ids";
import type { MappingTarget } from "@/models/config";
import { validateMapping, type MappingAssignments } from "./mapping-validator";

const VST = "vst_p50" as CanonicalKPIId;

function kpi(kpiId: CanonicalKPIId = VST, app?: "App_A" | "App_B"): MappingTarget {
  return app ? { kind: "kpi", kpiId, app } : { kind: "kpi", kpiId };
}

const DIMENSION: MappingTarget = { kind: "dimension", dimensionId: "platform" };
const TIMESTAMP: MappingTarget = { kind: "timestamp" };
const UNMAPPED: MappingTarget = { kind: "unmapped" };

function mapping(assignments: Record<string, MappingTarget>): MappingAssignments {
  return assignments;
}

describe("validateMapping — no mappable columns (Req 6.4, 16.4)", () => {
  it("reports invalid schema when nothing maps to a KPI or dimension", () => {
    const result = validateMapping(mapping({ ts: TIMESTAMP, junk: UNMAPPED }));

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].kind).toBe("no_mappable_columns");
  });

  it("does not also raise no_kpi_mapped for an empty schema", () => {
    const result = validateMapping(mapping({}));

    expect(result.errors.map((e) => e.kind)).toEqual(["no_mappable_columns"]);
  });
});

describe("validateMapping — no KPI mapped (Req 7.8)", () => {
  it("blocks a mappable schema that maps only dimensions", () => {
    const result = validateMapping(mapping({ platform: DIMENSION, ts: TIMESTAMP }));

    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.kind)).toContain("no_kpi_mapped");
  });
});

describe("validateMapping — duplicate (kpiId, app) pair (Req 7.9)", () => {
  it("blocks two columns mapping to the same KPI and same app", () => {
    const result = validateMapping(
      mapping({ vst_a: kpi(VST, "App_A"), startup_a: kpi(VST, "App_A") }),
    );

    expect(result.valid).toBe(false);
    expect(result.duplicateConflicts).toHaveLength(1);
    const conflict = result.duplicateConflicts[0];
    expect(conflict.kpiId).toBe(VST);
    expect(conflict.app).toBe("App_A");
    expect(conflict.columns).toEqual(["vst_a", "startup_a"]);
    expect(conflict.detail).toContain(VST);
    expect(conflict.detail).toContain("App_A");
    expect(conflict.detail).toContain("vst_a");
    expect(conflict.detail).toContain("startup_a");
  });

  it("blocks two long-layout columns for the same KPI with no per-column app", () => {
    const result = validateMapping(mapping({ vst: kpi(), vst2: kpi() }));

    expect(result.valid).toBe(false);
    expect(result.duplicateConflicts).toHaveLength(1);
    expect(result.duplicateConflicts[0].app).toBeNull();
  });

  it("allows one KPI mapped once per app in wide layout", () => {
    const result = validateMapping(
      mapping({ vst_a: kpi(VST, "App_A"), vst_b: kpi(VST, "App_B") }),
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.duplicateConflicts).toHaveLength(0);
  });
});

describe("validateMapping — valid mapping", () => {
  it("accepts a single KPI plus dimension and timestamp", () => {
    const result = validateMapping(
      mapping({ vst: kpi(), platform: DIMENSION, ts: TIMESTAMP }),
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
