import { describe, expect, it } from "vitest";

import type {
  AggregatedKPIValue,
  AggregatedResultSet,
} from "@/models/results";
import type { AppAssignment } from "@/models";
import { NO_DATA, NOT_AGGREGABLE, type Numeric } from "@/models/sentinels";
import { KPI_BY_ID } from "@/registry/kpi-registry";

import {
  buildHeatmapMatrix,
  parseSegmentKey,
} from "./winner-heatmap-model";

/** Build one aggregated value with only the fields the heatmap model reads. */
function value(
  kpiId: AggregatedKPIValue["kpiId"],
  app: AppAssignment,
  v: Numeric,
  contributingRecords = 1000,
): AggregatedKPIValue {
  const def = KPI_BY_ID[kpiId];
  return {
    kpiId,
    app,
    value: v,
    unit: def.canonicalUnit,
    aggregability: v === NOT_AGGREGABLE ? "not_aggregable" : "aggregable",
    weighted: true,
    contributingRecords,
    rejectedRecords: [],
    advisories: [],
  };
}

/** Assemble a bySegment map from `[key, values[]]` tuples into a result set. */
function resultSet(
  entries: [string, AggregatedKPIValue[]][],
): AggregatedResultSet {
  return {
    bySegment: new Map(entries),
    overall: [],
    unweightedAdvisory: false,
  };
}

const NO_GATE = { minSampleSize: 0 };

describe("parseSegmentKey", () => {
  it("parses a single-dimension key into one assignment", () => {
    expect(parseSegmentKey("platform=iOS")).toEqual({ platform: "iOS" });
  });

  it("parses a composite key into every dimension assignment", () => {
    expect(parseSegmentKey("platform=iOS|network=Wi-Fi")).toEqual({
      platform: "iOS",
      network: "Wi-Fi",
    });
  });

  it("treats the overall sentinel key as an empty assignment", () => {
    expect(parseSegmentKey("__overall__")).toEqual({});
  });
});

describe("buildHeatmapMatrix", () => {
  it("builds one column per selected-dimension member present in the slice (Req 12.1, 12.4)", () => {
    const agg = resultSet([
      ["platform=iOS", [value("avg_rendered_bitrate", "App_A", 5), value("avg_rendered_bitrate", "App_B", 4)]],
      ["platform=Android", [value("avg_rendered_bitrate", "App_A", 3), value("avg_rendered_bitrate", "App_B", 6)]],
    ]);

    const matrix = buildHeatmapMatrix(
      agg,
      "platform",
      [KPI_BY_ID.avg_rendered_bitrate],
      NO_GATE,
    );

    expect(matrix.dimension).toBe("platform");
    expect(matrix.segmentMembers).toEqual(["iOS", "Android"]);
    expect(matrix.rows).toHaveLength(1);
    expect(matrix.rows[0].cells).toHaveLength(2);
  });

  it("declares the directionality-aware winner per cell (Req 12.2)", () => {
    const agg = resultSet([
      // higher_is_better: App_A(5) beats App_B(4) on iOS; App_B(6) beats App_A(3) on Android.
      ["platform=iOS", [value("avg_rendered_bitrate", "App_A", 5), value("avg_rendered_bitrate", "App_B", 4)]],
      ["platform=Android", [value("avg_rendered_bitrate", "App_A", 3), value("avg_rendered_bitrate", "App_B", 6)]],
    ]);

    const matrix = buildHeatmapMatrix(
      agg,
      "platform",
      [KPI_BY_ID.avg_rendered_bitrate],
      NO_GATE,
    );

    const [ios, android] = matrix.rows[0].cells;
    expect(ios.winner.outcome).toBe("App_A");
    expect(android.winner.outcome).toBe("App_B");
  });

  it("respects lower_is_better directionality (Req 12.2)", () => {
    const agg = resultSet([
      // lower_is_better: App_B(1.0) beats App_A(2.0).
      ["platform=iOS", [value("vst_p95", "App_A", 2.0), value("vst_p95", "App_B", 1.0)]],
    ]);

    const matrix = buildHeatmapMatrix(agg, "platform", [KPI_BY_ID.vst_p95], NO_GATE);
    expect(matrix.rows[0].cells[0].winner.outcome).toBe("App_B");
  });

  it("marks a cell no-data when either app's value is NO_DATA (Req 12.5)", () => {
    const agg = resultSet([
      ["platform=iOS", [value("avg_rendered_bitrate", "App_A", 5), value("avg_rendered_bitrate", "App_B", NO_DATA)]],
    ]);

    const matrix = buildHeatmapMatrix(
      agg,
      "platform",
      [KPI_BY_ID.avg_rendered_bitrate],
      NO_GATE,
    );
    expect(matrix.rows[0].cells[0].winner.outcome).toBe("no_data");
  });

  it("marks a cell no-data when a KPI is absent for one app (Req 12.5)", () => {
    const agg = resultSet([
      // App_B has no entry for this KPI at all.
      ["platform=iOS", [value("avg_rendered_bitrate", "App_A", 5)]],
    ]);

    const matrix = buildHeatmapMatrix(
      agg,
      "platform",
      [KPI_BY_ID.avg_rendered_bitrate],
      NO_GATE,
    );
    expect(matrix.rows[0].cells[0].winner.outcome).toBe("no_data");
  });

  it("marks a cell not-aggregable when either value is NOT_AGGREGABLE (Req 23.4)", () => {
    const agg = resultSet([
      ["platform=iOS", [value("avg_rendered_bitrate", "App_A", NOT_AGGREGABLE), value("avg_rendered_bitrate", "App_B", 4)]],
    ]);

    const matrix = buildHeatmapMatrix(
      agg,
      "platform",
      [KPI_BY_ID.avg_rendered_bitrate],
      NO_GATE,
    );
    expect(matrix.rows[0].cells[0].winner.outcome).toBe("not_aggregable");
  });

  it("marks a cell not-aggregable when composite segments collapse onto one member (Req 23.4)", () => {
    // Two composite segments (iOS/Wi-Fi and iOS/Cellular) both project onto the
    // platform member iOS. Merging them would be an invalid combine.
    const agg = resultSet([
      ["platform=iOS|network=Wi-Fi", [value("avg_rendered_bitrate", "App_A", 5), value("avg_rendered_bitrate", "App_B", 4)]],
      ["platform=iOS|network=Cellular 5G", [value("avg_rendered_bitrate", "App_A", 6), value("avg_rendered_bitrate", "App_B", 3)]],
    ]);

    const matrix = buildHeatmapMatrix(
      agg,
      "platform",
      [KPI_BY_ID.avg_rendered_bitrate],
      NO_GATE,
    );

    expect(matrix.segmentMembers).toEqual(["iOS"]);
    expect(matrix.rows[0].cells[0].winner.outcome).toBe("not_aggregable");
  });

  it("projects a composite segment cleanly onto its selected-dimension member", () => {
    // A single composite segment per member: iOS and Android each map to one.
    const agg = resultSet([
      ["platform=iOS|network=Wi-Fi", [value("avg_rendered_bitrate", "App_A", 5), value("avg_rendered_bitrate", "App_B", 4)]],
      ["platform=Android|network=Wi-Fi", [value("avg_rendered_bitrate", "App_A", 3), value("avg_rendered_bitrate", "App_B", 6)]],
    ]);

    const matrix = buildHeatmapMatrix(
      agg,
      "platform",
      [KPI_BY_ID.avg_rendered_bitrate],
      NO_GATE,
    );

    expect(matrix.segmentMembers).toEqual(["iOS", "Android"]);
    expect(matrix.rows[0].cells[0].winner.outcome).toBe("App_A");
    expect(matrix.rows[0].cells[1].winner.outcome).toBe("App_B");
  });

  it("marks a cell low-confidence when an app is below minSampleSize (Req 25.8, 25.9)", () => {
    const agg = resultSet([
      [
        "platform=iOS",
        [
          value("avg_rendered_bitrate", "App_A", 5, 10), // below floor
          value("avg_rendered_bitrate", "App_B", 4, 1000),
        ],
      ],
    ]);

    const matrix = buildHeatmapMatrix(
      agg,
      "platform",
      [KPI_BY_ID.avg_rendered_bitrate],
      { minSampleSize: 100 },
    );
    expect(matrix.rows[0].cells[0].winner.outcome).toBe("low_confidence");
  });

  it("reports a tie as neutral when values are equal (Req 12.2)", () => {
    const agg = resultSet([
      ["platform=iOS", [value("avg_rendered_bitrate", "App_A", 5), value("avg_rendered_bitrate", "App_B", 5)]],
    ]);

    const matrix = buildHeatmapMatrix(
      agg,
      "platform",
      [KPI_BY_ID.avg_rendered_bitrate],
      NO_GATE,
    );
    expect(matrix.rows[0].cells[0].winner.outcome).toBe("neutral");
  });

  it("excludes segments that do not carry the selected dimension (Req 12.4)", () => {
    const agg = resultSet([
      ["network=Wi-Fi", [value("avg_rendered_bitrate", "App_A", 5), value("avg_rendered_bitrate", "App_B", 4)]],
    ]);

    // Selecting platform when only network segments exist yields no columns.
    const matrix = buildHeatmapMatrix(
      agg,
      "platform",
      [KPI_BY_ID.avg_rendered_bitrate],
      NO_GATE,
    );
    expect(matrix.segmentMembers).toEqual([]);
    expect(matrix.rows[0].cells).toEqual([]);
  });
});
