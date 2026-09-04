/**
 * Network-guard and identifier-omission tests for the data-residency hardening
 * (task 20.2; Req 28.11, 28.12, 28.13).
 *
 * These drive the real ingestion → aggregate → export path end to end against
 * the in-memory repository and assert the privacy posture the design promises:
 *
 *   - Req 28.11 — a full ingest → aggregate → export flow transmits ingested
 *     content to no external endpoint. We replace `fetch`, `XMLHttpRequest`,
 *     and `WebSocket` with tripwires and assert none is ever invoked while
 *     ingesting (`ingestConfirmedMapping`), aggregating/comparing
 *     (`aggregate` / `compare`), and exporting (`buildDeltaCSV` /
 *     `buildAggregatedSummaryCSV` + `triggerDownload`).
 *   - Req 28.12 — no export carries a user-identifier column. We build both
 *     CSVs from a dataset whose raw records carry `session.userId` and assert
 *     the CSV text contains no user / device / userId column or value.
 *   - Req 28.13 — the userId hashing toggle preserves distinct counts. We
 *     ingest the same raw sessions (with repeated userIds) once with hashing
 *     off and once on, and assert the DAU distinct-count KPI is identical
 *     because the salted SHA-256 hash is deterministic per dataset.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryKPIRepository } from "@/repository/InMemoryKPIRepository";
import type { KPIDataRepository } from "@/repository/KPIDataRepository";
import type { ParsedFile } from "@/ingestion/file-parser";
import {
  buildConfirmedMapping,
  ingestConfirmedMapping,
  proposeMappingDraft,
} from "@/ingestion/ingestion-flow";
import type { ColumnDraft } from "@/ingestion/ingestion-flow";
import { aggregate, compare } from "@/engine/aggregation-engine";
import { KPI_REGISTRY, KPI_BY_ID } from "@/registry/kpi-registry";
import type { KPIDefinition } from "@/registry/kpi-types";
import type { CanonicalKPIId } from "@/models/ids";
import type { AppAssignment } from "@/models/records";
import type { SLAConfig } from "@/models/config";
import {
  buildDeltaCSV,
  buildAggregatedSummaryCSV,
} from "@/lib/export/csv";
import { triggerDownload } from "@/lib/export/download";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SLA: SLAConfig = { varianceBand: 1.5, thresholds: {}, minSampleSize: 0 };

/** Only the KPIs a test needs, keeping aggregate/compare focused. */
function only(...ids: CanonicalKPIId[]): KPIDefinition[] {
  return ids.map((id) => KPI_BY_ID[id]);
}

/**
 * A raw-session file whose rows carry a user identifier column, one app column,
 * and a KPI column, so the full pipeline (ingest → aggregate → export) is
 * exercised over records that actually hold a `session.userId`.
 */
function rawParsedFile(): ParsedFile {
  return {
    headers: ["date", "app", "user_id", "vsf", "playback_attempt"],
    rows: [
      { date: "2025-03-14T00:00:00Z", app: "App_A", user_id: "alice", vsf: "1", playback_attempt: "1" },
      { date: "2025-03-14T00:00:00Z", app: "App_A", user_id: "alice", vsf: "0", playback_attempt: "1" },
      { date: "2025-03-14T00:00:00Z", app: "App_A", user_id: "bob", vsf: "0", playback_attempt: "1" },
      { date: "2025-03-14T00:00:00Z", app: "App_B", user_id: "carol", vsf: "0", playback_attempt: "1" },
      { date: "2025-03-14T00:00:00Z", app: "App_B", user_id: "carol", vsf: "0", playback_attempt: "1" },
    ],
    sampleValues: {
      date: ["2025-03-14T00:00:00Z"],
      app: ["App_A", "App_B"],
      user_id: ["alice", "bob", "carol"],
      vsf: ["1", "0"],
      playback_attempt: ["1"],
    },
  };
}

/**
 * Force the mapping so `date` → timestamp, `app` → app column, `user_id` →
 * userId, and the two metric columns → their raw-session KPIs, regardless of
 * what the fuzzy matcher proposed. Keeps the fixture independent of matcher
 * tuning.
 */
function forceRawColumns(columns: ColumnDraft[]): ColumnDraft[] {
  return columns.map((c) => {
    switch (c.header) {
      case "date":
        return { ...c, target: { kind: "timestamp" as const } };
      case "app":
        return { ...c, target: { kind: "app" as const } };
      case "user_id":
        return { ...c, target: { kind: "userId" as const } };
      default:
        return c;
    }
  });
}

/** Ingest the raw file, optionally hashing userIds, and return the records. */
async function ingestRaw(
  repo: KPIDataRepository,
  parsed: ParsedFile,
  datasetId: string,
  opts: { hashUserIds?: boolean; userIdSalt?: string } = {},
) {
  const draft = proposeMappingDraft(parsed);
  const columns = forceRawColumns(draft.columns);
  const mapping = buildConfirmedMapping({ ...draft, columns }, "Raw_Session", "App_A");
  return ingestConfirmedMapping(repo, parsed, mapping, {
    datasetId,
    datasetName: datasetId,
    appALabel: "App A",
    appBLabel: "App B",
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Req 28.11 — no external egress across the full flow
// ---------------------------------------------------------------------------

describe("network guard — the ingest → aggregate → export flow issues no network call (Req 28.11)", () => {
  // Saved globals so each is restored after the suite regardless of whether it
  // existed before (jsdom provides XMLHttpRequest; fetch/WebSocket may be
  // absent under the runner, in which case a tripwire stub stands in).
  const originals: Record<string, unknown> = {};
  const NET_GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket"] as const;

  /** Spies that must never be invoked during the flow. */
  const tripwires: Record<string, ReturnType<typeof vi.fn>> = {};

  // jsdom does not implement the object-URL API `triggerDownload` relies on, so
  // stub it (locally, not over the network) to let the download path run.
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;

  beforeEach(() => {
    createObjectURL = vi.fn(() => "blob:mock");
    revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;

    for (const name of NET_GLOBALS) {
      originals[name] = (globalThis as Record<string, unknown>)[name];
      const trip = vi.fn(() => {
        throw new Error(`Unexpected ${name} call — data must stay client-resident (Req 28.11)`);
      });
      tripwires[name] = trip;
      // A stand-in constructor/function: calling or `new`-ing it trips the wire.
      (globalThis as Record<string, unknown>)[name] = trip;
    }
  });

  afterEach(() => {
    for (const name of NET_GLOBALS) {
      (globalThis as Record<string, unknown>)[name] = originals[name];
    }
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    vi.restoreAllMocks();
  });

  it("makes no fetch / XMLHttpRequest / WebSocket call during ingest, aggregate, and export", async () => {
    const repo = new InMemoryKPIRepository();
    const parsed = rawParsedFile();

    // 1) Ingest — build records, pseudonymize (hashing on), persist, set active.
    const { dataset } = await ingestRaw(repo, parsed, "flow-ds", {
      hashUserIds: true,
      userIdSalt: "salt",
    });
    const records = await repo.getRecords(dataset.id);

    // 2) Aggregate + compare.
    const kpis = only("vsf", "dau");
    const agg = aggregate(records, "Raw_Session", kpis);
    const comparison = compare(agg, SLA, kpis);

    // 3) Export — build both CSVs and trigger the browser download.
    const deltaCsv = buildDeltaCSV(comparison);
    const summaryCsv = buildAggregatedSummaryCSV(
      agg,
      comparison.slice,
      comparison.results,
    );
    triggerDownload(deltaCsv, "delta.csv");
    triggerDownload(summaryCsv, "summary.csv");

    // The whole flow must have touched none of the network primitives.
    for (const name of NET_GLOBALS) {
      expect(tripwires[name]).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// Req 28.12 — no export carries a user-identifier column or value
// ---------------------------------------------------------------------------

describe("identifier omission — no export contains a user identifier (Req 28.12)", () => {
  let repo: KPIDataRepository;

  beforeEach(() => {
    repo = new InMemoryKPIRepository();
  });

  it("omits any user / device / userId column and every raw identifier value from both CSVs", async () => {
    const parsed = rawParsedFile();
    // Ingest without hashing so the raw identifiers (alice/bob/carol) are the
    // ones present on the records — the strongest test that they never leak.
    const { dataset } = await ingestRaw(repo, parsed, "id-ds");
    const records = await repo.getRecords(dataset.id);

    // Sanity: the records really do carry a userId, so the export omission is
    // meaningful rather than vacuous.
    expect(records.some((r) => typeof r.session?.userId === "string")).toBe(true);

    const kpis = only("vsf", "dau");
    const agg = aggregate(records, "Raw_Session", kpis);
    const comparison = compare(agg, SLA, kpis);

    const deltaCsv = buildDeltaCSV(comparison);
    const summaryCsv = buildAggregatedSummaryCSV(agg, comparison.slice, comparison.results);

    // Identifier-column header tokens. Note "Daily Active Users" is a legitimate
    // KPI *name* that contains the substring "user", so the ban is on identifier
    // *column headers* (a mapped userId column), not on the substring appearing
    // anywhere — we assert on the header row's cells and on the raw values.
    const ID_COLUMN_HEADERS = ["user id", "userid", "user_id", "device id", "device_id", "deviceid", "viewer id", "subscriber id"];

    for (const csv of [deltaCsv, summaryCsv]) {
      const lines = csv.split("\r\n");
      // The header row is the first non-metadata line (metadata lines start "#").
      const headerRow = lines.find((l) => !l.startsWith("#"))!.toLowerCase();
      const headerCells = headerRow.split(",");

      // No column is a user/device identifier column.
      for (const banned of ID_COLUMN_HEADERS) {
        expect(headerRow).not.toContain(banned);
      }
      expect(headerCells.some((cell) => /\buser\s*id\b|\bdevice\b|\bviewer\s*id\b/.test(cell))).toBe(false);

      // No raw identifier value from the source rows appears anywhere in the file.
      const lower = csv.toLowerCase();
      expect(lower).not.toContain("alice");
      expect(lower).not.toContain("bob");
      expect(lower).not.toContain("carol");
    }
  });
});

// ---------------------------------------------------------------------------
// Req 28.13 — the hashing toggle preserves distinct counts
// ---------------------------------------------------------------------------

describe("hashing toggle — distinct counts are preserved with hashing on vs off (Req 28.13)", () => {
  let repo: KPIDataRepository;

  beforeEach(() => {
    repo = new InMemoryKPIRepository();
  });

  /** The DAU distinct count per app for a freshly-aggregated raw dataset. */
  function dauByApp(records: Awaited<ReturnType<KPIDataRepository["getRecords"]>>) {
    const agg = aggregate(records, "Raw_Session", only("dau"));
    const read = (app: AppAssignment) =>
      agg.overall.find((v) => v.kpiId === "dau" && v.app === app)?.value;
    return { App_A: read("App_A"), App_B: read("App_B") };
  }

  it("yields the same DAU distinct count whether userIds are hashed or not", async () => {
    const parsed = rawParsedFile();

    // Off: raw identifiers on the records.
    await ingestRaw(repo, parsed, "plain-ds", { hashUserIds: false });
    const plainRecords = await repo.getRecords("plain-ds");

    // On: salted SHA-256 hashed identifiers on the records.
    await ingestRaw(repo, parsed, "hashed-ds", { hashUserIds: true, userIdSalt: "salt" });
    const hashedRecords = await repo.getRecords("hashed-ds");

    // The hashed records must not carry any raw identifier.
    expect(hashedRecords.every((r) => r.session?.userId !== "alice")).toBe(true);
    expect(hashedRecords.some((r) => r.session?.userId?.startsWith("u_"))).toBe(true);

    const plain = dauByApp(plainRecords);
    const hashed = dauByApp(hashedRecords);

    // App_A has two distinct users (alice, bob); App_B has one (carol). The
    // deterministic per-dataset hash preserves the identity collapsing, so the
    // distinct counts are identical either way.
    expect(plain).toEqual({ App_A: 2, App_B: 1 });
    expect(hashed).toEqual(plain);
  });

  it("collapses repeated userIds to one distinct unit under hashing (deterministic per dataset)", async () => {
    // A single app whose sessions repeat one user many times: the distinct
    // count is 1 with hashing on, exactly as with the raw identifier.
    const parsed: ParsedFile = {
      headers: ["date", "app", "user_id", "vsf", "playback_attempt"],
      rows: Array.from({ length: 6 }, () => ({
        date: "2025-03-14T00:00:00Z",
        app: "App_A",
        user_id: "repeat-user",
        vsf: "0",
        playback_attempt: "1",
      })),
      sampleValues: {
        date: ["2025-03-14T00:00:00Z"],
        app: ["App_A"],
        user_id: ["repeat-user"],
        vsf: ["0"],
        playback_attempt: ["1"],
      },
    };

    await ingestRaw(repo, parsed, "repeat-ds", { hashUserIds: true, userIdSalt: "salt" });
    const records = await repo.getRecords("repeat-ds");

    expect(dauByApp(records).App_A).toBe(1);
  });
});

// Keep an explicit reference so the registry import is unmistakably used even
// if a future refactor drops the `only(...)` helper.
void KPI_REGISTRY;
