/**
 * Table-driven example tests for `detectLayout` (task 10.5).
 *
 * These exhaustively walk every recognized app-suffix pair the design lists
 * (Req 21.2), a representative set of unrecognized patterns (Req 21.2 negative
 * space), and the app-column-wins ambiguity case (Req 21.4). They complement
 * the sanity unit tests in `layout-detector.test.ts` rather than duplicating
 * them: here the assertions are driven from a data table so a new suffix pair
 * is covered by adding one row.
 *
 * Requirements: 21.2, 21.3, 21.4.
 */

import { describe, it, expect } from "vitest";
import type { CanonicalKPIId } from "@/models/ids";
import type { AppAssignment } from "@/models/records";
import {
  detectLayout,
  RECOGNIZED_APP_SUFFIX_PAIRS,
  type ColumnMatch,
} from "./layout-detector";

const VST = "vst_p50" as CanonicalKPIId;

/** Convenience builder for a KPI-matched (non-app) column. */
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

// ---------------------------------------------------------------------------
// Recognized app-suffix pairs — every pair the engine ships (Req 21.2).
// Each row supplies the App_A header, the App_B header, and the tokens that
// should be attributed to each app. The stem `vst` keeps the pair grouped
// onto the same KPI so a wide group forms.
// ---------------------------------------------------------------------------

interface RecognizedCase {
  readonly name: string;
  readonly aHeader: string;
  readonly bHeader: string;
}

const RECOGNIZED_CASES: readonly RecognizedCase[] = [
  { name: "_a / _b", aHeader: "vst_a", bHeader: "vst_b" },
  { name: "_app_a / _app_b", aHeader: "vst_app_a", bHeader: "vst_app_b" },
  { name: "_current / _new", aHeader: "vst_current", bHeader: "vst_new" },
  { name: "_control / _variant", aHeader: "vst_control", bHeader: "vst_variant" },
  { name: "_baseline / _candidate", aHeader: "vst_baseline", bHeader: "vst_candidate" },
];

describe("detectLayout — recognized app-suffix pairs classify as wide (Req 21.2)", () => {
  it.each(RECOGNIZED_CASES)(
    "classifies wide and attributes first→App_A, second→App_B for the $name pair",
    ({ aHeader, bHeader }) => {
      const result = detectLayout([
        plain("date"),
        plain("platform"),
        kpi(aHeader),
        kpi(bHeader),
      ]);

      expect(result.layout).toBe("wide");
      expect(result.wideGroups).toHaveLength(1);

      const group = result.wideGroups[0];
      expect(group.kpiId).toBe(VST);
      expect(group.columns).toHaveLength(2);

      const byHeader = new Map<string, AppAssignment>(
        group.columns.map((c) => [c.header, c.app]),
      );
      expect(byHeader.get(aHeader)).toBe("App_A");
      expect(byHeader.get(bHeader)).toBe("App_B");

      // No ambiguity when only qualified columns are present.
      expect(result.ambiguity).toBeUndefined();
    },
  );

  it("keeps RECOGNIZED_APP_SUFFIX_PAIRS and the table in sync", () => {
    // Every recognized pair should have exactly one covering example row so
    // adding a pair to the engine forces a new table row here.
    expect(RECOGNIZED_CASES).toHaveLength(RECOGNIZED_APP_SUFFIX_PAIRS.length);
  });
});

// ---------------------------------------------------------------------------
// Unrecognized patterns — must NOT produce a wide layout (Req 21.2).
// The layout defaults to `long` (file-level assignment handled downstream).
// ---------------------------------------------------------------------------

interface UnrecognizedCase {
  readonly name: string;
  readonly columns: readonly ColumnMatch[];
}

const UNRECOGNIZED_CASES: readonly UnrecognizedCase[] = [
  {
    name: "arbitrary _x / _y suffixes",
    columns: [kpi("vst_x"), kpi("vst_y")],
  },
  {
    name: "single app of the _a / _b pair (only _a present)",
    columns: [kpi("vst_a"), plain("date")],
  },
  {
    name: "single app of the _current / _new pair (only _new present)",
    columns: [kpi("vst_new"), plain("date")],
  },
  {
    name: "two App_A tokens, no App_B (_a and _current on the same KPI)",
    columns: [kpi("vst_a"), kpi("vst_current")],
  },
  {
    name: "no suffix at all",
    columns: [kpi("vst"), plain("date"), plain("platform")],
  },
  {
    name: "same recognized token twice (_a and _a on different KPIs)",
    columns: [kpi("vst_a"), kpi("ttfb_a", "ttfb_p50" as CanonicalKPIId)],
  },
  {
    name: "bare token columns carry no KPI stem",
    columns: [kpi("a"), kpi("b")],
  },
];

describe("detectLayout — unrecognized patterns do not classify as wide (Req 21.2)", () => {
  it.each(UNRECOGNIZED_CASES)(
    "returns long with no wide groups for: $name",
    ({ columns }) => {
      const result = detectLayout(columns);
      expect(result.layout).toBe("long");
      expect(result.wideGroups).toHaveLength(0);
      expect(result.ambiguity).toBeUndefined();
    },
  );
});

// ---------------------------------------------------------------------------
// App-column-wins ambiguity — an app column plus qualified columns (Req 21.4).
// The app column wins (layout = long), but the wide grouping and the ambiguity
// are still surfaced as an overridable default (Req 21.3, 21.4).
// ---------------------------------------------------------------------------

describe("detectLayout — app column wins over qualified columns (Req 21.3, 21.4)", () => {
  it.each(RECOGNIZED_CASES)(
    "prefers the app column (long) and reports ambiguity when combined with the $name pair",
    ({ aHeader, bHeader }) => {
      const result = detectLayout([
        appColumn("app"),
        kpi(aHeader),
        kpi(bHeader),
        plain("date"),
      ]);

      // App column wins → long (Req 21.4).
      expect(result.layout).toBe("long");

      // Ambiguity is reported for the modal to surface (Req 21.4).
      expect(result.ambiguity?.kind).toBe("app_column_and_qualified_columns");
      expect(result.ambiguity?.appColumns).toEqual(["app"]);
      expect(result.ambiguity?.qualifiedColumns).toEqual(
        expect.arrayContaining([aHeader, bHeader]),
      );
      expect(result.ambiguity?.detail).toContain("app");

      // Wide groups are still exposed so the modal can offer overrides
      // (Req 21.3 — detection is a default, not a decision).
      expect(result.wideGroups).toHaveLength(1);
      expect(result.wideGroups[0].columns).toHaveLength(2);
    },
  );

  it("reports every app column header when more than one app column is present", () => {
    const result = detectLayout([
      appColumn("app"),
      appColumn("application"),
      kpi("vst_a"),
      kpi("vst_b"),
    ]);

    expect(result.layout).toBe("long");
    expect(result.ambiguity?.appColumns).toEqual(["app", "application"]);
    expect(result.wideGroups).toHaveLength(1);
  });
});
