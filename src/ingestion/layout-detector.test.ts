/**
 * Sanity unit tests for `detectLayout`.
 *
 * The exhaustive table-driven coverage over every recognized/unrecognized
 * app-suffix pattern lives in the dedicated example tests (task 10.5). These
 * pin the core behaviours called out in Req 21.2–21.4: wide classification on
 * a recognized pair, app-first/app-second attribution, the app-column-wins
 * ambiguity, and the long/file-level default.
 */

import { describe, it, expect } from "vitest";
import type { CanonicalKPIId } from "@/models/ids";
import { detectLayout, type ColumnMatch } from "./layout-detector";

const VST = "vst_p50" as CanonicalKPIId;

/** Convenience builder for a KPI-matched column. */
function kpi(header: string, kpiId: CanonicalKPIId = VST): ColumnMatch {
  return { header, kpiId, isAppColumn: false };
}

/** Convenience builder for the app column. */
function appColumn(header: string): ColumnMatch {
  return { header, kpiId: null, isAppColumn: true };
}

/** Convenience builder for a non-KPI, non-app column (dimension/timestamp). */
function plain(header: string): ColumnMatch {
  return { header, kpiId: null, isAppColumn: false };
}

describe("detectLayout — wide classification (Req 21.2)", () => {
  it("classifies `wide` on an `_a` / `_b` suffix pair and attributes first→App_A, second→App_B", () => {
    const result = detectLayout([plain("date"), plain("platform"), kpi("vst_a"), kpi("vst_b")]);

    expect(result.layout).toBe("wide");
    expect(result.wideGroups).toHaveLength(1);

    const cols = result.wideGroups[0].columns;
    expect(cols.find((c) => c.header === "vst_a")?.app).toBe("App_A");
    expect(cols.find((c) => c.header === "vst_b")?.app).toBe("App_B");
  });

  it("classifies `wide` on an `_app_a` / `_app_b` pair without mis-splitting on the bare `a`/`b`", () => {
    const result = detectLayout([kpi("vst_app_a"), kpi("vst_app_b")]);

    expect(result.layout).toBe("wide");
    const cols = result.wideGroups[0].columns;
    expect(cols.find((c) => c.header === "vst_app_a")?.app).toBe("App_A");
    expect(cols.find((c) => c.header === "vst_app_b")?.app).toBe("App_B");
    // The stem should be the same KPI base, i.e. they grouped together.
    expect(result.wideGroups).toHaveLength(1);
  });

  it("classifies `wide` on the `_current` / `_new` pair", () => {
    const result = detectLayout([kpi("vst_current"), kpi("vst_new")]);
    expect(result.layout).toBe("wide");
  });

  it("classifies `wide` on the `_control` / `_variant` pair", () => {
    const result = detectLayout([kpi("vst_control"), kpi("vst_variant")]);
    expect(result.layout).toBe("wide");
  });

  it("classifies `wide` on the `_baseline` / `_candidate` pair", () => {
    const result = detectLayout([kpi("vst_baseline"), kpi("vst_candidate")]);
    expect(result.layout).toBe("wide");
  });
});

describe("detectLayout — long / file-level default (Req 21.1)", () => {
  it("returns `long` with no wide groups when an app column is present", () => {
    const result = detectLayout([appColumn("app"), kpi("vst"), plain("date")]);
    expect(result.layout).toBe("long");
    expect(result.wideGroups).toHaveLength(0);
    expect(result.ambiguity).toBeUndefined();
  });

  it("defaults to `long` (file-level handled downstream) when neither app column nor qualified columns exist", () => {
    const result = detectLayout([kpi("vst"), plain("date"), plain("platform")]);
    expect(result.layout).toBe("long");
    expect(result.wideGroups).toHaveLength(0);
  });

  it("does not classify `wide` when only one app of a pair is present", () => {
    const result = detectLayout([kpi("vst_a"), plain("date")]);
    expect(result.layout).toBe("long");
    expect(result.wideGroups).toHaveLength(0);
  });
});

describe("detectLayout — app-column-wins ambiguity (Req 21.4)", () => {
  it("prefers the app column (long) and reports the ambiguity when both are present", () => {
    const result = detectLayout([appColumn("app"), kpi("vst_a"), kpi("vst_b")]);

    expect(result.layout).toBe("long");
    expect(result.ambiguity?.kind).toBe("app_column_and_qualified_columns");
    expect(result.ambiguity?.appColumns).toEqual(["app"]);
    expect(result.ambiguity?.qualifiedColumns).toEqual(
      expect.arrayContaining(["vst_a", "vst_b"]),
    );
    // Wide groups are still surfaced so the modal can offer per-column overrides.
    expect(result.wideGroups).toHaveLength(1);
  });
});
