/**
 * RecordBuilder tests (task 11.1).
 *
 * Covers the four behaviours the record builder is responsible for:
 *
 *   - wide-row fan-out into one record per app, including the value+blank row
 *     collapsing to a single record (Req 21.6, 21.7, 21.8);
 *   - long and file-level app resolution (Req 21.5);
 *   - unknown dimension-value retention with an appended-member advisory (Req 2.7);
 *   - the pre-aggregated completion-quartile monotonicity advisory (Req 22.9).
 *
 * Validates: Requirements 2.7, 21.5, 21.6, 21.7, 21.8, 22.9
 */

import { describe, expect, it } from "vitest";

import type { ColumnMapping } from "@/models/config";
import {
  appendedMemberAdvisory,
  buildRecords,
  type RecordBuildContext,
} from "./record-builder";
import type { ParsedRow } from "./file-parser";

const CTX_PRE: RecordBuildContext = {
  datasetId: "ds1",
  ingestionMode: "Pre_Aggregated",
};

/** A wide mapping: timestamp, a platform dimension, and manifest latency per app. */
function wideMapping(): ColumnMapping {
  return {
    headerSetHash: "hash-wide",
    headers: ["date", "platform", "latency_a_ms", "latency_b_ms"],
    assignments: {
      date: { kind: "timestamp" },
      platform: { kind: "dimension", dimensionId: "platform" },
      latency_a_ms: { kind: "kpi", kpiId: "manifest_fetch_latency", app: "App_A" },
      latency_b_ms: { kind: "kpi", kpiId: "manifest_fetch_latency", app: "App_B" },
    },
    units: {},
    layout: "wide",
    ingestionMode: "Pre_Aggregated",
  };
}

describe("wide-row fan-out (Req 21.6, 21.7, 21.8)", () => {
  it("fans one wide row into one record per app, each carrying only its own value", () => {
    const rows: ParsedRow[] = [
      { date: "2025-03-14", platform: "iOS", latency_a_ms: "120", latency_b_ms: "95" },
    ];

    const { records, rejected } = buildRecords(rows, wideMapping(), CTX_PRE);

    expect(rejected).toEqual([]);
    expect(records).toHaveLength(2);

    const a = records.find((r) => r.app === "App_A")!;
    const b = records.find((r) => r.app === "App_B")!;

    // Each record carries the shared timestamp and dimensions (Req 21.6).
    expect(a.timestampUtc).toBe("2025-03-14T00:00:00.000Z");
    expect(b.timestampUtc).toBe(a.timestampUtc);
    expect(a.dimensions).toEqual({ platform: "iOS" });
    expect(b.dimensions).toEqual({ platform: "iOS" });

    // Each carries ONLY its own app's value; ms canonical is ms (factor 1) (Req 21.7).
    expect(a.metrics).toEqual({ manifest_fetch_latency: 120 });
    expect(b.metrics).toEqual({ manifest_fetch_latency: 95 });
  });

  it("collapses a value+blank wide row into a single record (Req 21.8)", () => {
    const rows: ParsedRow[] = [
      { date: "2025-03-14", platform: "iOS", latency_a_ms: "120", latency_b_ms: "" },
    ];

    const { records } = buildRecords(rows, wideMapping(), CTX_PRE);

    expect(records).toHaveLength(1);
    expect(records[0].app).toBe("App_A");
    expect(records[0].metrics).toEqual({ manifest_fetch_latency: 120 });
  });

  it("emits no record for a wide row blank on both sides", () => {
    const rows: ParsedRow[] = [
      { date: "2025-03-14", platform: "iOS", latency_a_ms: "", latency_b_ms: "" },
    ];

    const { records, rejected } = buildRecords(rows, wideMapping(), CTX_PRE);

    expect(records).toEqual([]);
    // A blank-both-sides row carries no data — not a structural rejection.
    expect(rejected).toEqual([]);
  });

  it("converts each app's value to the KPI's canonical unit", () => {
    const mapping = wideMapping();
    // Header carries a `s` (seconds) unit token; manifest latency is canonical ms
    // with s -> ms factor 1000, so 2 s becomes 2000 ms.
    mapping.headers = ["date", "latency_a_s", "latency_b_s"];
    mapping.assignments = {
      date: { kind: "timestamp" },
      latency_a_s: { kind: "kpi", kpiId: "manifest_fetch_latency", app: "App_A" },
      latency_b_s: { kind: "kpi", kpiId: "manifest_fetch_latency", app: "App_B" },
    };

    const rows: ParsedRow[] = [{ date: "2025-03-14", latency_a_s: "2", latency_b_s: "3" }];
    const { records } = buildRecords(rows, mapping, CTX_PRE);

    const a = records.find((r) => r.app === "App_A")!;
    const b = records.find((r) => r.app === "App_B")!;
    expect(a.metrics).toEqual({ manifest_fetch_latency: 2000 });
    expect(b.metrics).toEqual({ manifest_fetch_latency: 3000 });
  });
});

describe("long and file-level app resolution (Req 21.5)", () => {
  const longMapping: ColumnMapping = {
    headerSetHash: "hash-long",
    headers: ["date", "app", "ad_fill_rate"],
    assignments: {
      date: { kind: "timestamp" },
      app: { kind: "app" },
      ad_fill_rate: { kind: "kpi", kpiId: "ad_fill_rate" },
    },
    units: {},
    layout: "long",
    ingestionMode: "Pre_Aggregated",
  };

  it("reads the app per row from the app column (long layout)", () => {
    const rows: ParsedRow[] = [
      { date: "2025-03-14", app: "App_A", ad_fill_rate: "88" },
      { date: "2025-03-14", app: "App_B", ad_fill_rate: "91" },
    ];

    const { records, rejected } = buildRecords(rows, longMapping, CTX_PRE);

    expect(rejected).toEqual([]);
    expect(records.map((r) => r.app)).toEqual(["App_A", "App_B"]);
    expect(records[0].metrics).toEqual({ ad_fill_rate: 88 });
    expect(records[1].metrics).toEqual({ ad_fill_rate: 91 });
  });

  it("rejects a long row whose app value is unrecognized", () => {
    const rows: ParsedRow[] = [{ date: "2025-03-14", app: "", ad_fill_rate: "88" }];

    const { records, rejected } = buildRecords(rows, longMapping, CTX_PRE);

    expect(records).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].rowIndex).toBe(0);
    expect(rejected[0].reason).toMatch(/unrecognized app value/);
  });

  it("stamps the file-level app assignment onto every record", () => {
    const fileMapping: ColumnMapping = {
      headerSetHash: "hash-file",
      headers: ["date", "ad_fill_rate"],
      assignments: {
        date: { kind: "timestamp" },
        ad_fill_rate: { kind: "kpi", kpiId: "ad_fill_rate" },
      },
      units: {},
      layout: "long",
      fileAppAssignment: "App_B",
      ingestionMode: "Pre_Aggregated",
    };

    const rows: ParsedRow[] = [
      { date: "2025-03-14", ad_fill_rate: "88" },
      { date: "2025-03-15", ad_fill_rate: "90" },
    ];

    const { records } = buildRecords(rows, fileMapping, CTX_PRE);

    expect(records).toHaveLength(2);
    expect(records.every((r) => r.app === "App_B")).toBe(true);
  });

  it("rejects a row with no app column and no file-level assignment", () => {
    const noAppMapping: ColumnMapping = {
      headerSetHash: "hash-noapp",
      headers: ["date", "ad_fill_rate"],
      assignments: {
        date: { kind: "timestamp" },
        ad_fill_rate: { kind: "kpi", kpiId: "ad_fill_rate" },
      },
      units: {},
      layout: "long",
      ingestionMode: "Pre_Aggregated",
    };

    const { records, rejected } = buildRecords(
      [{ date: "2025-03-14", ad_fill_rate: "88" }],
      noAppMapping,
      CTX_PRE,
    );

    expect(records).toEqual([]);
    expect(rejected[0].reason).toMatch(/no app column/);
  });
});

describe("unknown dimension-member retention (Req 2.7)", () => {
  const mapping: ColumnMapping = {
    headerSetHash: "hash-dim",
    headers: ["date", "app", "network", "ad_fill_rate"],
    assignments: {
      date: { kind: "timestamp" },
      app: { kind: "app" },
      network: { kind: "dimension", dimensionId: "network" },
      ad_fill_rate: { kind: "kpi", kpiId: "ad_fill_rate" },
    },
    units: {},
    layout: "long",
    ingestionMode: "Pre_Aggregated",
  };

  it("retains a record with an unknown dimension value and reports the appended member", () => {
    const rows: ParsedRow[] = [
      // "Jio" is a seed ISP; "StarrySky ISP" is not.
      { date: "2025-03-14", app: "App_A", network: "Jio", ad_fill_rate: "80" },
      { date: "2025-03-14", app: "App_B", network: "StarrySky ISP", ad_fill_rate: "82" },
    ];

    const { records, appendedMembers } = buildRecords(rows, mapping, CTX_PRE);

    // Both records retained with their verbatim dimension value.
    expect(records).toHaveLength(2);
    expect(records[1].dimensions).toEqual({ network: "StarrySky ISP" });

    // The unknown value is reported once, the known seed value is not.
    expect(appendedMembers).toEqual([
      { dimensionId: "network", member: "StarrySky ISP" },
    ]);

    const advisory = appendedMemberAdvisory(appendedMembers[0]);
    expect(advisory.code).toBe("UNKNOWN_DIMENSION_MEMBER");
    expect(advisory.detail).toContain("StarrySky ISP");
  });

  it("deduplicates the same unknown value seen across multiple rows", () => {
    const rows: ParsedRow[] = [
      { date: "2025-03-14", app: "App_A", network: "NewNet", ad_fill_rate: "80" },
      { date: "2025-03-15", app: "App_A", network: "NewNet", ad_fill_rate: "81" },
    ];

    const { appendedMembers } = buildRecords(rows, mapping, CTX_PRE);
    expect(appendedMembers).toEqual([{ dimensionId: "network", member: "NewNet" }]);
  });
});

describe("completion-quartile monotonicity advisory (Req 22.9)", () => {
  const mapping: ColumnMapping = {
    headerSetHash: "hash-quart",
    headers: ["date", "app", "cc25", "cc50", "cc75", "cc100"],
    assignments: {
      date: { kind: "timestamp" },
      app: { kind: "app" },
      cc25: { kind: "kpi", kpiId: "content_completion_25" },
      cc50: { kind: "kpi", kpiId: "content_completion_50" },
      cc75: { kind: "kpi", kpiId: "content_completion_75" },
      cc100: { kind: "kpi", kpiId: "content_completion_100" },
    },
    units: {},
    layout: "long",
    ingestionMode: "Pre_Aggregated",
  };

  it("flags a non-monotonic pre-aggregated record but still emits it", () => {
    // 50% (70) exceeds 25% (60): a funnel violation.
    const rows: ParsedRow[] = [
      { date: "2025-03-14", app: "App_A", cc25: "60", cc50: "70", cc75: "40", cc100: "20" },
    ];

    const { records } = buildRecords(rows, mapping, CTX_PRE);

    expect(records).toHaveLength(1);
    const advisories = records[0].advisories ?? [];
    const quartile = advisories.find((a) => a.code === "NON_MONOTONIC_QUARTILES");
    expect(quartile).toBeDefined();
    // Record is retained and still carries its metrics (Req 22.8).
    expect(records[0].metrics).toMatchObject({
      content_completion_25: 60,
      content_completion_50: 70,
    });
  });

  it("does not flag a monotonic record", () => {
    const rows: ParsedRow[] = [
      { date: "2025-03-14", app: "App_A", cc25: "80", cc50: "60", cc75: "40", cc100: "20" },
    ];

    const { records } = buildRecords(rows, mapping, CTX_PRE);
    const advisories = records[0].advisories ?? [];
    expect(advisories.some((a) => a.code === "NON_MONOTONIC_QUARTILES")).toBe(false);
  });
});

describe("structural rejection (Req 26.4)", () => {
  it("rejects a row with an unparseable timestamp", () => {
    const mapping = wideMapping();
    const rows: ParsedRow[] = [
      { date: "not-a-date", platform: "iOS", latency_a_ms: "120", latency_b_ms: "95" },
    ];

    const { records, rejected } = buildRecords(rows, mapping, CTX_PRE);
    expect(records).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/could not be parsed/);
  });
});

describe("raw-session mode", () => {
  it("writes values into the session payload rather than metrics", () => {
    const mapping: ColumnMapping = {
      headerSetHash: "hash-raw",
      headers: ["date", "app", "ad_fill_rate"],
      assignments: {
        date: { kind: "timestamp" },
        app: { kind: "app" },
        ad_fill_rate: { kind: "kpi", kpiId: "ad_fill_rate" },
      },
      units: {},
      layout: "long",
      ingestionMode: "Raw_Session",
    };

    const { records } = buildRecords(
      [{ date: "2025-03-14", app: "App_A", ad_fill_rate: "88" }],
      mapping,
      { datasetId: "ds1", ingestionMode: "Raw_Session" },
    );

    expect(records).toHaveLength(1);
    expect(records[0].metrics).toBeUndefined();
    expect(records[0].session).toMatchObject({ ad_fill_rate: 88 });
  });
});
