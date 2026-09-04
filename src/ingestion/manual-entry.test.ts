import { describe, expect, it } from "vitest";

import {
  applyManualEdit,
  buildManualRecords,
  draftFromRecord,
  isEditable,
  validateManualEntry,
  type ManualEntryDraft,
} from "./manual-entry";
import type { KPIRecord } from "@/models";

/** A minimal valid draft: VST (canonical seconds) for both apps on a date. */
function baseDraft(overrides: Partial<ManualEntryDraft> = {}): ManualEntryDraft {
  return {
    date: "2025-03-14",
    dimensions: { platform: "iOS" },
    cells: [{ kpiId: "vst_p50", appAValue: "1.2", appBValue: "1.5", unit: "s" }],
    ...overrides,
  };
}

describe("validateManualEntry (Req 8.3)", () => {
  it("flags a non-numeric field and reports it invalid", () => {
    const result = validateManualEntry(
      baseDraft({
        cells: [{ kpiId: "vst_p50", appAValue: "oops", appBValue: "1.5", unit: "s" }],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.fieldErrors).toEqual([
      { kpiId: "vst_p50", app: "App_A", reason: "not a number" },
    ]);
  });

  it("treats a blank cell as no value, not an error", () => {
    const result = validateManualEntry(
      baseDraft({
        cells: [{ kpiId: "vst_p50", appAValue: "", appBValue: "1.5", unit: "s" }],
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.fieldErrors).toHaveLength(0);
  });

  it("is invalid when nothing was entered", () => {
    const result = validateManualEntry(
      baseDraft({ cells: [{ kpiId: "vst_p50", appAValue: "", appBValue: "", unit: "s" }] }),
    );
    expect(result.valid).toBe(false);
    expect(result.empty).toBe(true);
  });

  it("flags an unparseable date", () => {
    const result = validateManualEntry(baseDraft({ date: "not-a-date" }));
    expect(result.valid).toBe(false);
    expect(result.dateError).toBeDefined();
  });
});

describe("buildManualRecords (Req 8.2)", () => {
  it("builds one origin:manual record per app with canonical values", () => {
    const { records } = buildManualRecords(baseDraft(), {
      datasetId: "ds1",
      idSeed: "seed",
    });
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.origin).toBe("manual");
      expect(r.datasetId).toBe("ds1");
      expect(r.dimensions.platform).toBe("iOS");
      expect(r.timestampUtc).toBe("2025-03-14T00:00:00.000Z");
    }
    const a = records.find((r) => r.app === "App_A")!;
    expect(a.metrics?.vst_p50).toBeCloseTo(1.2);
  });

  it("excludes only the invalid field but still submits the rest (Req 8.3)", () => {
    const { records } = buildManualRecords(
      baseDraft({
        cells: [
          { kpiId: "vst_p50", appAValue: "oops", appBValue: "1.5", unit: "s" },
          { kpiId: "vst_p95", appAValue: "2.0", appBValue: "2.5", unit: "s" },
        ],
      }),
      { datasetId: "ds1", idSeed: "seed" },
    );
    const a = records.find((r) => r.app === "App_A")!;
    expect(a.metrics?.vst_p50).toBeUndefined(); // invalid field excluded
    expect(a.metrics?.vst_p95).toBeCloseTo(2.0); // valid field submitted
  });

  it("normalizes a non-canonical unit to canonical (ms -> s)", () => {
    const { records } = buildManualRecords(
      baseDraft({
        cells: [{ kpiId: "vst_p50", appAValue: "1200", appBValue: "", unit: "ms" }],
      }),
      { datasetId: "ds1", idSeed: "seed" },
    );
    expect(records).toHaveLength(1);
    expect(records[0].metrics?.vst_p50).toBeCloseTo(1.2);
  });

  it("yields a single record for a one-sided entry", () => {
    const { records } = buildManualRecords(
      baseDraft({
        cells: [{ kpiId: "vst_p50", appAValue: "1.2", appBValue: "", unit: "s" }],
      }),
      { datasetId: "ds1", idSeed: "seed" },
    );
    expect(records).toHaveLength(1);
    expect(records[0].app).toBe("App_A");
  });
});

describe("applyManualEdit (Req 27.8)", () => {
  const original: KPIRecord = {
    id: "ds1:seed:App_A",
    datasetId: "ds1",
    app: "App_A",
    timestampUtc: "2025-03-14T00:00:00.000Z",
    sourceUtcOffsetMinutes: null,
    bucket: { hourUtc: "2025-03-14T00:00:00Z", dayUtc: "2025-03-14" },
    origin: "manual",
    dimensions: {
      platform: "iOS",
      network: "Wi-Fi",
      cdn: "Akamai",
      geography: "Country",
      streamType: "VOD Movies",
    },
    metrics: { vst_p50: 1.2 },
    ingestedGranularity: "day",
  };

  it("rewrites values in place preserving the record id", () => {
    const draft = draftFromRecord(original);
    draft.cells[0].appAValue = "1.8";
    const updated = applyManualEdit(original, draft);
    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(original.id); // id preserved (never duplicated)
    expect(updated!.app).toBe("App_A");
    expect(updated!.origin).toBe("manual");
    expect(updated!.metrics?.vst_p50).toBeCloseTo(1.8);
  });

  it("returns null when the edited date does not parse", () => {
    const draft = draftFromRecord(original);
    draft.date = "garbage";
    expect(applyManualEdit(original, draft)).toBeNull();
  });
});

describe("isEditable (Req 27.9)", () => {
  it("permits only manual-origin records", () => {
    expect(isEditable({ origin: "manual" })).toBe(true);
    expect(isEditable({ origin: "file" })).toBe(false);
    expect(isEditable({ origin: "mock" })).toBe(false);
  });
});
