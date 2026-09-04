/**
 * Property-based round-trip test for the persistence layer.
 *
 * Runs against `fake-indexeddb` (installed globally by src/test/setup.ts) so
 * `DexieKPIRepository.open` exercises the real IndexedDB code path. Each run
 * uses a fresh, uniquely named database that is closed and deleted afterwards
 * so no state leaks between generated cases.
 *
 * Requirements: 3.1, 3.2, 3.3.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import type {
  AppAssignment,
  ColumnMapping,
  Dataset,
  DimensionId,
  IngestionMode,
  KPIRecord,
  MappingTarget,
  SLAConfig,
  SourceLayout,
  SourceType,
  TimeBucket,
} from "@/models";

import { DexieKPIRepository } from "./DexieKPIRepository";

// --- local arbitraries -------------------------------------------------------
// Defined locally per the task; they intentionally do not import a shared
// arbitraries module.

const KPI_IDS = [
  "vst_p50",
  "vst_p95",
  "rebuffer_ratio",
  "vsf",
  "dau",
  "mau",
  "arpu",
  "cdn_cache_hit_ratio",
] as const;

const DIMENSION_IDS: readonly DimensionId[] = [
  "platform",
  "network",
  "cdn",
  "geography",
  "streamType",
];

const appArb: fc.Arbitrary<AppAssignment> = fc.constantFrom("App_A", "App_B");
const ingestionModeArb: fc.Arbitrary<IngestionMode> = fc.constantFrom(
  "Pre_Aggregated",
  "Raw_Session",
);
const sourceTypeArb: fc.Arbitrary<SourceType> = fc.constantFrom("Raw", "Aggregated", "Mock");
const layoutArb: fc.Arbitrary<SourceLayout> = fc.constantFrom("long", "wide");

/** Finite numbers only — IndexedDB structured-clones NaN/Infinity, but they
 * would break deep-equality comparison, so we keep values ordinary. */
const finiteNumberArb = fc.double({
  min: -1e6,
  max: 1e6,
  noNaN: true,
  noDefaultInfinity: true,
});

const timeBucketArb: fc.Arbitrary<TimeBucket> = fc.constantFrom<TimeBucket[]>(
  { hourUtc: "2025-03-14T09:00:00Z", dayUtc: "2025-03-14" },
  { hourUtc: "2025-03-14T10:00:00Z", dayUtc: "2025-03-14" },
  { hourUtc: "2025-03-15T00:00:00Z", dayUtc: "2025-03-15" },
);

const dimensionsArb: fc.Arbitrary<Record<DimensionId, string>> = fc.record(
  Object.fromEntries(
    DIMENSION_IDS.map((id) => [id, fc.string({ maxLength: 12 })]),
  ) as Record<DimensionId, fc.Arbitrary<string>>,
) as fc.Arbitrary<Record<DimensionId, string>>;

const metricsArb = fc.dictionary(
  fc.constantFrom(...KPI_IDS),
  finiteNumberArb,
  { maxKeys: KPI_IDS.length },
) as fc.Arbitrary<Partial<Record<(typeof KPI_IDS)[number], number>>>;

/**
 * A KPIRecord for a given dataset id and unique record id. Optional fields are
 * only emitted when present so a round-trip comparison is exact (an absent key
 * must not reappear as `undefined`).
 */
function recordArb(datasetId: string, id: string): fc.Arbitrary<KPIRecord> {
  return fc
    .record({
      app: appArb,
      timestampUtc: fc.constantFrom(
        "2025-03-14T09:00:00Z",
        "2025-03-14T10:30:00Z",
        "2025-03-15T00:00:00Z",
      ),
      sourceUtcOffsetMinutes: fc.option(fc.integer({ min: -720, max: 840 }), { nil: null }),
      bucket: timeBucketArb,
      origin: fc.constantFrom("file", "manual", "mock") as fc.Arbitrary<KPIRecord["origin"]>,
      dimensions: dimensionsArb,
      metrics: fc.option(metricsArb, { nil: undefined }),
      volumeWeight: fc.option(fc.nat({ max: 100000 }), { nil: undefined }),
    })
    .map((r) => {
      const base: KPIRecord = {
        id,
        datasetId,
        app: r.app,
        timestampUtc: r.timestampUtc,
        sourceUtcOffsetMinutes: r.sourceUtcOffsetMinutes,
        bucket: r.bucket,
        origin: r.origin,
        dimensions: r.dimensions,
      };
      if (r.metrics !== undefined) base.metrics = r.metrics;
      if (r.volumeWeight !== undefined) base.volumeWeight = r.volumeWeight;
      return base;
    });
}

/**
 * A full Dataset with a unique id, unique record ids, and a `recordCount` that
 * matches its records — mirroring what a real caller persists. The repository
 * recomputes `recordCount` from the records, so keeping them consistent lets us
 * assert deep equality of the whole loaded object.
 */
const datasetArb: fc.Arbitrary<Dataset> = fc
  .record({
    id: fc.uuid(),
    name: fc.string({ minLength: 1, maxLength: 24 }),
    createdAt: fc.constantFrom(
      "2025-01-01T00:00:00.000Z",
      "2025-02-15T12:00:00.000Z",
      "2025-03-31T23:59:59.000Z",
    ),
    appALabel: fc.string({ maxLength: 16 }),
    appBLabel: fc.string({ maxLength: 16 }),
    sourceType: sourceTypeArb,
    ingestionMode: ingestionModeArb,
    recordCount: fc.nat({ max: 12 }),
  })
  .chain((meta) =>
    fc
      .tuple(
        ...Array.from({ length: meta.recordCount }, (_, i) =>
          recordArb(meta.id, `${meta.id}-r${i}`),
        ),
      )
      .map((records) => ({
        ...meta,
        recordCount: records.length,
        records: records as KPIRecord[],
      })),
  );

const slaConfigArb: fc.Arbitrary<SLAConfig> = fc.record({
  varianceBand: finiteNumberArb,
  thresholds: fc.dictionary(fc.constantFrom(...KPI_IDS), finiteNumberArb, {
    maxKeys: KPI_IDS.length,
  }) as fc.Arbitrary<SLAConfig["thresholds"]>,
  minSampleSize: fc.nat({ max: 100000 }),
});

const sourceHeaderArb = fc.string({ minLength: 1, maxLength: 16 });

function mappingTargetArb(): fc.Arbitrary<MappingTarget> {
  return fc.oneof(
    fc.record({
      kind: fc.constant("kpi" as const),
      kpiId: fc.constantFrom(...KPI_IDS),
      app: fc.option(appArb, { nil: undefined }),
    }).map((t) => {
      const out: MappingTarget = { kind: "kpi", kpiId: t.kpiId };
      if (t.app !== undefined) (out as { app?: AppAssignment }).app = t.app;
      return out;
    }),
    fc.record({ kind: fc.constant("dimension" as const), dimensionId: fc.constantFrom(...DIMENSION_IDS) }),
    fc.constant({ kind: "app" } as MappingTarget),
    fc.constant({ kind: "timestamp" } as MappingTarget),
    fc.constant({ kind: "volumeWeight" } as MappingTarget),
    fc.constant({ kind: "userId" } as MappingTarget),
    fc.constant({ kind: "unmapped" } as MappingTarget),
  );
}

const columnMappingArb: fc.Arbitrary<ColumnMapping> = fc
  .record({
    headerSetHash: fc.hexaString({ minLength: 4, maxLength: 16 }),
    headers: fc.uniqueArray(sourceHeaderArb, { minLength: 1, maxLength: 6 }),
    layout: layoutArb,
    ingestionMode: ingestionModeArb,
    fileAppAssignment: fc.option(appArb, { nil: undefined }),
  })
  .chain((base) => {
    const assignmentsArb = fc
      .tuple(...base.headers.map(() => mappingTargetArb()))
      .map((targets) =>
        Object.fromEntries(base.headers.map((h, i) => [h, targets[i]])),
      );
    const unitsArb = fc
      .tuple(...base.headers.map(() => fc.constantFrom("ms", "s", "Mbps", "%", "USD")))
      .map((units) => Object.fromEntries(base.headers.map((h, i) => [h, units[i]])));
    return fc.record({ assignments: assignmentsArb, units: unitsArb }).map(({ assignments, units }) => {
      const mapping: ColumnMapping = {
        headerSetHash: base.headerSetHash,
        headers: base.headers,
        assignments,
        units,
        layout: base.layout,
        ingestionMode: base.ingestionMode,
      };
      if (base.fileAppAssignment !== undefined) mapping.fileAppAssignment = base.fileAppAssignment;
      return mapping;
    });
  });

// --- harness -----------------------------------------------------------------

/** Open a repository backed by a unique fake-indexeddb database, run the body,
 * then close and delete the database so no state leaks between runs. */
async function withRepo<T>(fn: (repo: DexieKPIRepository) => Promise<T>): Promise<T> {
  const repo = await DexieKPIRepository.open({
    databaseName: `prop-${Math.random().toString(36).slice(2)}-${Date.now()}`,
  });
  try {
    return await fn(repo);
  } finally {
    repo.database.close();
    await repo.database.delete();
  }
}

/** Records come back ordered by id (keyset pagination); sort both sides so the
 * comparison is order-independent. */
function sortById(records: KPIRecord[]): KPIRecord[] {
  return [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// --- Property 16 -------------------------------------------------------------

describe("Persistence round-trip (Property 16)", () => {
  // Feature: ott-kpi-benchmarking-engine, Property 16: For any dataset, SLA configuration, or column mapping, saving it through the repository and then loading it back yields a deeply equal object.

  it("round-trips an arbitrary dataset with its records", async () => {
    await fc.assert(
      fc.asyncProperty(datasetArb, async (dataset) => {
        await withRepo(async (repo) => {
          await repo.saveDataset(dataset);
          const loaded = await repo.getDataset(dataset.id);
          expect(loaded).toBeDefined();
          // Compare records order-independently, everything else exactly.
          const { records: loadedRecords, ...loadedMeta } = loaded!;
          const { records: savedRecords, ...savedMeta } = dataset;
          expect(loadedMeta).toEqual(savedMeta);
          expect(sortById(loadedRecords)).toEqual(sortById(savedRecords));
        });
      }),
      { numRuns: 100 },
    );
  });

  it("round-trips an arbitrary SLA configuration", async () => {
    await fc.assert(
      fc.asyncProperty(slaConfigArb, async (config) => {
        await withRepo(async (repo) => {
          await repo.saveSLAConfig(config);
          expect(await repo.getSLAConfig()).toEqual(config);
        });
      }),
      { numRuns: 100 },
    );
  });

  it("round-trips an arbitrary column mapping keyed by its header-set hash", async () => {
    await fc.assert(
      fc.asyncProperty(columnMappingArb, async (mapping) => {
        await withRepo(async (repo) => {
          await repo.saveColumnMapping(mapping);
          expect(await repo.getColumnMapping(mapping.headerSetHash)).toEqual(mapping);
        });
      }),
      { numRuns: 100 },
    );
  });
});
