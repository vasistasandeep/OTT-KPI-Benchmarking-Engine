import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryKPIRepository } from "@/repository/InMemoryKPIRepository";
import type { KPIDataRepository } from "@/repository/KPIDataRepository";
import type { ParsedFile } from "./file-parser";
import type { ColumnMapping } from "@/models/config";
import {
  buildConfirmedMapping,
  ingestConfirmedMapping,
  proposeMappingDraft,
  requiresFileLevelApp,
  resolveColumnUnit,
  saltedHash,
} from "./ingestion-flow";
import { computeHeaderSetHash } from "./mapping-cache";

/** A file-level file: date + platform + a single vst column, no app signal. */
const fileLevelParsed: ParsedFile = {
  headers: ["date", "platform", "vst_ms"],
  rows: [
    { date: "2025-03-14", platform: "iOS", vst_ms: "1420" },
    { date: "2025-03-15", platform: "Android", vst_ms: "1380" },
  ],
  sampleValues: {
    date: ["2025-03-14", "2025-03-15"],
    platform: ["iOS", "Android"],
    vst_ms: ["1420", "1380"],
  },
};

/** A wide file: vst split into _app_a / _app_b columns. */
const wideParsed: ParsedFile = {
  headers: ["date", "platform", "vst_app_a", "vst_app_b"],
  rows: [{ date: "2025-03-14", platform: "iOS", vst_app_a: "1.42", vst_app_b: "1.28" }],
  sampleValues: {
    date: ["2025-03-14"],
    platform: ["iOS"],
    vst_app_a: ["1.42"],
    vst_app_b: ["1.28"],
  },
};

/** A long file: dedicated app column. */
const longParsed: ParsedFile = {
  headers: ["date", "app", "platform", "vst"],
  rows: [
    { date: "2025-03-14", app: "App_A", platform: "iOS", vst: "1.42" },
    { date: "2025-03-14", app: "App_B", platform: "iOS", vst: "1.28" },
  ],
  sampleValues: {
    date: ["2025-03-14", "2025-03-14"],
    app: ["App_A", "App_B"],
    platform: ["iOS", "iOS"],
    vst: ["1.42", "1.28"],
  },
};

describe("proposeMappingDraft", () => {
  it("attaches up to five samples per column (Req 7.1)", () => {
    const draft = proposeMappingDraft(fileLevelParsed);
    const vst = draft.columns.find((c) => c.header === "vst_ms")!;
    expect(vst.samples).toEqual(["1420", "1380"]);
  });

  it("fuzzy-proposes a KPI for a recognizable header and infers its unit (Req 7.2, 22.3)", () => {
    const draft = proposeMappingDraft(fileLevelParsed);
    const vst = draft.columns.find((c) => c.header === "vst_ms")!;
    expect(vst.target.kind).toBe("kpi");
    if (vst.target.kind === "kpi") {
      expect(vst.target.kpiId).toBe("vst_p50");
    }
    // "vst_ms" carries a recognized unit token; the unit resolves without assuming.
    expect(vst.unit).toBe("ms");
    expect(vst.assumedUnit).toBe(false);
  });

  it("maps a dimension header to its dimension (Req 7.1)", () => {
    const draft = proposeMappingDraft(fileLevelParsed);
    const platform = draft.columns.find((c) => c.header === "platform")!;
    expect(platform.target.kind).toBe("dimension");
  });

  it("requires a file-level app when no app signal is present (Req 21.5)", () => {
    const draft = proposeMappingDraft(fileLevelParsed);
    expect(draft.layout).toBe("long");
    expect(draft.requiresFileLevelApp).toBe(true);
  });

  it("detects wide layout and pre-fills per-column app qualifiers (Req 21.2, 21.3)", () => {
    const draft = proposeMappingDraft(wideParsed);
    expect(draft.layout).toBe("wide");
    expect(draft.requiresFileLevelApp).toBe(false);
    const a = draft.columns.find((c) => c.header === "vst_app_a")!;
    const b = draft.columns.find((c) => c.header === "vst_app_b")!;
    expect(a.target.kind === "kpi" && a.target.app).toBe("App_A");
    expect(b.target.kind === "kpi" && b.target.app).toBe("App_B");
  });

  it("does not require a file-level app when an app column is present (Req 21.5)", () => {
    const draft = proposeMappingDraft(longParsed);
    expect(draft.requiresFileLevelApp).toBe(false);
  });

  it("pre-populates from a cached mapping and marks it as reused (Req 7.7)", () => {
    const cached: ColumnMapping = {
      headerSetHash: computeHeaderSetHash(fileLevelParsed.headers),
      headers: fileLevelParsed.headers,
      assignments: {
        date: { kind: "timestamp" },
        platform: { kind: "dimension", dimensionId: "platform" },
        vst_ms: { kind: "kpi", kpiId: "vst_p95" },
      },
      units: { vst_ms: "s" },
      layout: "long",
      ingestionMode: "Pre_Aggregated",
    };
    const draft = proposeMappingDraft(fileLevelParsed, cached);
    expect(draft.fromCache).toBe(true);
    const vst = draft.columns.find((c) => c.header === "vst_ms")!;
    // Cached decision wins over fresh fuzzy matching.
    expect(vst.target.kind === "kpi" && vst.target.kpiId).toBe("vst_p95");
    expect(vst.unit).toBe("s");
  });
});

describe("requiresFileLevelApp", () => {
  it("is false for wide layout regardless of columns", () => {
    const draft = proposeMappingDraft(wideParsed);
    expect(requiresFileLevelApp(draft.columns, "wide")).toBe(false);
  });

  it("is false when a KPI column carries a per-column app qualifier", () => {
    const draft = proposeMappingDraft(wideParsed);
    // Force long layout but keep the app-qualified columns.
    expect(requiresFileLevelApp(draft.columns, "long")).toBe(false);
  });
});

describe("resolveColumnUnit", () => {
  it("infers a unit token from the header (Req 22.3)", () => {
    expect(resolveColumnUnit("vst_ms", "vst_p50")).toEqual({ unit: "ms", assumed: false });
  });

  it("falls back to the canonical unit and flags it assumed (Req 22.6)", () => {
    const r = resolveColumnUnit("startup", "vst_p50");
    expect(r.assumed).toBe(true);
    expect(r.unit).toBe("s"); // vst canonical unit
  });
});

describe("buildConfirmedMapping", () => {
  it("stamps the file-level app assignment when required (Req 21.5)", () => {
    const draft = proposeMappingDraft(fileLevelParsed);
    const mapping = buildConfirmedMapping(draft, "Pre_Aggregated", "App_A");
    expect(mapping.fileAppAssignment).toBe("App_A");
    expect(mapping.ingestionMode).toBe("Pre_Aggregated");
  });

  it("omits the file-level app for a wide layout (Req 21.5)", () => {
    const draft = proposeMappingDraft(wideParsed);
    const mapping = buildConfirmedMapping(draft, "Pre_Aggregated", undefined);
    expect(mapping.fileAppAssignment).toBeUndefined();
  });

  it("records only KPI columns in the unit map (Req 22.4)", () => {
    const draft = proposeMappingDraft(fileLevelParsed);
    const mapping = buildConfirmedMapping(draft, "Pre_Aggregated", "App_A");
    expect(Object.keys(mapping.units)).toEqual(["vst_ms"]);
  });
});

describe("saltedHash", () => {
  it("is a deterministic, salted, non-identity SHA-256 hash (Req 28.13)", async () => {
    // Deterministic under the same salt so a user collapses to one bucket.
    expect(await saltedHash("user-1", "salt")).toBe(await saltedHash("user-1", "salt"));
    // Never the raw identifier.
    expect(await saltedHash("user-1", "salt")).not.toBe("user-1");
    // Distinct identifiers hash differently.
    expect(await saltedHash("user-1", "salt")).not.toBe(await saltedHash("user-2", "salt"));
    // Salt participates: the same identifier under a different salt differs.
    expect(await saltedHash("user-1", "salt-a")).not.toBe(await saltedHash("user-1", "salt-b"));
    // A SHA-256 digest is 32 bytes → 64 hex chars, prefixed with `u_`.
    expect(await saltedHash("user-1", "salt")).toMatch(/^u_[0-9a-f]{64}$/);
  });
});

describe("ingestConfirmedMapping", () => {
  let repo: KPIDataRepository;
  beforeEach(() => {
    repo = new InMemoryKPIRepository();
  });

  it("builds records, persists the mapping, writes, and sets active (Req 7.6, 21.5)", async () => {
    const draft = proposeMappingDraft(fileLevelParsed);
    const mapping = buildConfirmedMapping(draft, "Pre_Aggregated", "App_A");
    const result = await ingestConfirmedMapping(repo, fileLevelParsed, mapping, {
      datasetId: "ds-1",
      datasetName: "March upload",
      appALabel: "App A",
      appBLabel: "App B",
    });

    // Every record was stamped with the file-level app (Req 21.5).
    const records = await repo.getRecords("ds-1");
    expect(records.length).toBe(2);
    expect(records.every((r) => r.app === "App_A")).toBe(true);

    // The mapping was persisted under its header-set hash (Req 7.6).
    const cached = await repo.getColumnMapping(result.headerSetHash);
    expect(cached).toBeDefined();

    // The new dataset is active.
    expect(await repo.getActiveDatasetId()).toBe("ds-1");
    expect(result.dataset.recordCount).toBe(2);
  });

  it("fans out a wide row into one record per app (Req 21.6)", async () => {
    const draft = proposeMappingDraft(wideParsed);
    const mapping = buildConfirmedMapping(draft, "Pre_Aggregated", undefined);
    await ingestConfirmedMapping(repo, wideParsed, mapping, {
      datasetId: "ds-wide",
      datasetName: "Wide",
      appALabel: "A",
      appBLabel: "B",
    });
    const records = await repo.getRecords("ds-wide");
    expect(records.map((r) => r.app).sort()).toEqual(["App_A", "App_B"]);
  });

  it("pseudonymizes mapped user ids when requested (Req 28.13)", async () => {
    const rawParsed: ParsedFile = {
      headers: ["date", "user", "vst"],
      rows: [{ date: "2025-03-14T00:00:00Z", user: "alice", vst: "1.4" }],
      sampleValues: { date: ["2025-03-14T00:00:00Z"], user: ["alice"], vst: ["1.4"] },
    };
    const draft = proposeMappingDraft(rawParsed);
    // Force the user column to userId and timestamp/kpi as needed.
    const columns = draft.columns.map((c) => {
      if (c.header === "user") return { ...c, target: { kind: "userId" as const } };
      if (c.header === "date") return { ...c, target: { kind: "timestamp" as const } };
      return c;
    });
    const mapping = buildConfirmedMapping(
      { ...draft, columns },
      "Raw_Session",
      "App_A",
    );
    await ingestConfirmedMapping(repo, rawParsed, mapping, {
      datasetId: "ds-raw",
      datasetName: "Raw",
      appALabel: "A",
      appBLabel: "B",
      hashUserIds: true,
      userIdSalt: "salt",
    });
    const records = await repo.getRecords("ds-raw");
    expect(records[0].session?.userId).toBe(await saltedHash("alice", "salt"));
    expect(records[0].session?.userId).not.toBe("alice");
    // The per-dataset salt is persisted on the dataset (Req 28.13).
    expect((await repo.getDataset("ds-raw"))?.userIdSalt).toBe("salt");
  });

  it("defaults the per-dataset salt to the dataset id and persists it (Req 28.13)", async () => {
    const rawParsed: ParsedFile = {
      headers: ["date", "user", "vst"],
      rows: [{ date: "2025-03-14T00:00:00Z", user: "bob", vst: "1.4" }],
      sampleValues: { date: ["2025-03-14T00:00:00Z"], user: ["bob"], vst: ["1.4"] },
    };
    const draft = proposeMappingDraft(rawParsed);
    const columns = draft.columns.map((c) => {
      if (c.header === "user") return { ...c, target: { kind: "userId" as const } };
      if (c.header === "date") return { ...c, target: { kind: "timestamp" as const } };
      return c;
    });
    const mapping = buildConfirmedMapping({ ...draft, columns }, "Raw_Session", "App_A");
    await ingestConfirmedMapping(repo, rawParsed, mapping, {
      datasetId: "ds-default-salt",
      datasetName: "Default salt",
      appALabel: "A",
      appBLabel: "B",
      hashUserIds: true,
    });
    const records = await repo.getRecords("ds-default-salt");
    expect(records[0].session?.userId).toBe(await saltedHash("bob", "ds-default-salt"));
    expect((await repo.getDataset("ds-default-salt"))?.userIdSalt).toBe("ds-default-salt");
  });

  it("does not persist a salt when hashing is off (Req 28.13)", async () => {
    const draft = proposeMappingDraft(fileLevelParsed);
    const mapping = buildConfirmedMapping(draft, "Pre_Aggregated", "App_A");
    await ingestConfirmedMapping(repo, fileLevelParsed, mapping, {
      datasetId: "ds-no-hash",
      datasetName: "No hash",
      appALabel: "A",
      appBLabel: "B",
    });
    expect((await repo.getDataset("ds-no-hash"))?.userIdSalt).toBeUndefined();
  });
});
