import * as React from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { LineChartIcon, SearchX } from "lucide-react";

import { cn } from "@/lib/utils";
import type { AggregatedKPIValue } from "@/models/results";
import type { Numeric } from "@/models/sentinels";
import type { AppAssignment } from "@/models/records";
import type { CanonicalKPIId } from "@/models/ids";
import { getKPI, KPI_REGISTRY } from "@/registry";
import { useDatasetStore, useResultStore } from "@/stores";

/**
 * TimeSeriesOverlay — the interactive trend chart overlaying App_A and App_B
 * over the active date range for a selected KPI (Req 13.1–13.5; design
 * "Time-Series Overlay").
 *
 * The module reads the memoized {@link AggregatedKPIValue}s from
 * {@link useResultStore}; each carries an optional per-bucket `series` produced
 * by the aggregation engine for the active slice. The chart plots App_A and
 * App_B as two lines for the KPI chosen in the metric switcher (Req 13.2), and
 * re-renders whenever the store's aggregated result changes — which is exactly
 * when the Global Filter slice changes (Req 13.4).
 *
 * When a second, optional metric is selected and it uses a different canonical
 * unit from the primary metric, the chart adds a second Y-axis so each unit
 * scales independently (Req 13.3). When the selected KPI has no time-series
 * data for the active slice, the chart area shows a no-data state (Req 13.5).
 *
 * ECharts is initialized with the SVG renderer explicitly
 * (`echarts.init(el, undefined, { renderer: "svg" })`) so the chart renders as
 * vector `<svg>` elements rather than a `<canvas>`. This is what keeps the
 * chart visible when the Executive Report / print view is triggered (Req 18.5):
 * a canvas rasterizes to a blank bitmap in the print snapshot, whereas SVG
 * nodes remain in the DOM and print faithfully.
 *
 * All colors resolve against the dark-theme token layer in `index.css` (Req
 * 15.1); the App_A / App_B stroke colors are read from CSS custom properties so
 * a palette change never regresses here.
 */

// Register only the ECharts pieces this chart uses, plus the SVG renderer, so
// the print/report view never rasterizes to a blank canvas (Req 18.5).
echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  SVGRenderer,
]);

/** One plotted point: an ISO date/bucket label and a finite numeric value. */
interface SeriesPoint {
  date: string;
  value: number;
}

export interface TimeSeriesOverlayProps {
  className?: string;
}

/** A KPI is offered in the metric switcher only when the registry knows it. */
const METRIC_OPTIONS: { id: CanonicalKPIId; name: string; unit: string }[] =
  KPI_REGISTRY.map((k) => ({ id: k.id, name: k.name, unit: k.canonicalUnit }));

/** Read a themed color from a CSS custom property, with a safe fallback. */
function themeColor(varName: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return raw ? `hsl(${raw})` : fallback;
}

/** True when a Numeric is a plottable finite number (not a sentinel). */
function isFinitePoint(value: Numeric): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Extract the plottable series for one KPI and one app from the aggregated set.
 * Returns the finite points only; sentinel points (NO_DATA / NOT_AGGREGABLE)
 * are dropped so a gap shows rather than a fabricated zero.
 */
function seriesFor(
  overall: readonly AggregatedKPIValue[] | undefined,
  kpiId: CanonicalKPIId,
  app: AppAssignment,
): SeriesPoint[] {
  const entry = overall?.find((v) => v.kpiId === kpiId && v.app === app);
  if (!entry?.series) return [];
  const points: SeriesPoint[] = [];
  for (const p of entry.series) {
    if (isFinitePoint(p.value)) points.push({ date: p.date, value: p.value });
  }
  return points;
}

/** The union of bucket labels across the supplied series, sorted ascending. */
function unionDates(...series: SeriesPoint[][]): string[] {
  const set = new Set<string>();
  for (const s of series) for (const p of s) set.add(p.date);
  return [...set].sort();
}

/** Map a series to values aligned to the given ordered date axis (null gaps). */
function alignTo(dates: string[], series: SeriesPoint[]): (number | null)[] {
  const byDate = new Map(series.map((p) => [p.date, p.value]));
  return dates.map((d) => (byDate.has(d) ? (byDate.get(d) as number) : null));
}

/**
 * A visually-hidden data table mirroring the plotted lines, so assistive tech
 * can read the trend chart's underlying values (Req 28.4). One row per bucket
 * date; one column per plotted series. Empty gaps render as an em dash.
 */
function TrendDataTable({
  primaryName,
  secondaryName,
  appALabel,
  appBLabel,
  primaryA,
  primaryB,
  secondaryA,
  secondaryB,
}: {
  primaryName: string;
  secondaryName?: string;
  appALabel: string;
  appBLabel: string;
  primaryA: SeriesPoint[];
  primaryB: SeriesPoint[];
  secondaryA: SeriesPoint[];
  secondaryB: SeriesPoint[];
}) {
  const dates = unionDates(primaryA, primaryB, secondaryA, secondaryB);
  const columns: { key: string; label: string; values: (number | null)[] }[] = [
    { key: "pa", label: `${appALabel} · ${primaryName}`, values: alignTo(dates, primaryA) },
    { key: "pb", label: `${appBLabel} · ${primaryName}`, values: alignTo(dates, primaryB) },
  ];
  if (secondaryName) {
    columns.push(
      { key: "sa", label: `${appALabel} · ${secondaryName}`, values: alignTo(dates, secondaryA) },
      { key: "sb", label: `${appBLabel} · ${secondaryName}`, values: alignTo(dates, secondaryB) },
    );
  }

  return (
    <table className="sr-only" data-testid="time-series-data-table">
      <caption>
        Trend data for {primaryName} comparing {appALabel} and {appBLabel}
        {secondaryName ? `, also showing ${secondaryName}` : ""}
      </caption>
      <thead>
        <tr>
          <th scope="col">Date</th>
          {columns.map((c) => (
            <th key={c.key} scope="col">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {dates.map((date, i) => (
          <tr key={date}>
            <th scope="row">{date}</th>
            {columns.map((c) => (
              <td key={c.key}>{c.values[i] == null ? "—" : c.values[i]}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TimeSeriesOverlay({ className }: TimeSeriesOverlayProps) {
  const aggregated = useResultStore((s) => s.aggregated);
  const noData = useResultStore((s) => s.noData);
  const appALabel = useDatasetStore((s) => s.appALabel);
  const appBLabel = useDatasetStore((s) => s.appBLabel);

  const [primaryKpi, setPrimaryKpi] = React.useState<CanonicalKPIId>(
    METRIC_OPTIONS[0]?.id ?? "vst_p50",
  );
  const [secondaryKpi, setSecondaryKpi] = React.useState<CanonicalKPIId | "">(
    "",
  );

  const chartRef = React.useRef<HTMLDivElement | null>(null);
  const instanceRef = React.useRef<echarts.ECharts | null>(null);

  const overall = aggregated?.overall;

  // Resolve the plottable series for the chosen metric(s) and both apps.
  const primaryA = React.useMemo(
    () => seriesFor(overall, primaryKpi, "App_A"),
    [overall, primaryKpi],
  );
  const primaryB = React.useMemo(
    () => seriesFor(overall, primaryKpi, "App_B"),
    [overall, primaryKpi],
  );
  const secondaryA = React.useMemo(
    () => (secondaryKpi ? seriesFor(overall, secondaryKpi, "App_A") : []),
    [overall, secondaryKpi],
  );
  const secondaryB = React.useMemo(
    () => (secondaryKpi ? seriesFor(overall, secondaryKpi, "App_B") : []),
    [overall, secondaryKpi],
  );

  const primaryDef = getKPI(primaryKpi);
  const secondaryDef = secondaryKpi ? getKPI(secondaryKpi) : undefined;

  // Two selected KPIs with disparate canonical units require a second Y-axis so
  // each unit scales independently (Req 13.3).
  const dualAxis = Boolean(
    secondaryDef &&
      primaryDef &&
      secondaryDef.canonicalUnit !== primaryDef.canonicalUnit,
  );

  // The chart has data when at least one app has at least one finite point for
  // the primary metric; otherwise the no-data state renders instead (Req 13.5).
  const hasData =
    primaryA.length > 0 ||
    primaryB.length > 0 ||
    secondaryA.length > 0 ||
    secondaryB.length > 0;

  // Build the ECharts option from the resolved series. Recomputed whenever the
  // metric selection or the aggregated result (i.e. the slice) changes.
  const option = React.useMemo<echarts.EChartsCoreOption>(() => {
    const dates = unionDates(primaryA, primaryB, secondaryA, secondaryB);

    const appAColor = themeColor("--chart-app-a", "#38bdf8");
    const appBColor = themeColor("--chart-app-b", "#f472b6");
    const axisColor = themeColor("--muted-foreground", "#94a3b8");
    const gridLine = themeColor("--border", "#334155");

    const yAxes: Record<string, unknown>[] = [
      {
        type: "value",
        name: primaryDef?.canonicalUnit ?? "",
        nameTextStyle: { color: axisColor },
        axisLabel: { color: axisColor },
        splitLine: { lineStyle: { color: gridLine } },
      },
    ];
    if (dualAxis) {
      yAxes.push({
        type: "value",
        name: secondaryDef?.canonicalUnit ?? "",
        nameTextStyle: { color: axisColor },
        axisLabel: { color: axisColor },
        splitLine: { show: false },
      });
    }

    const primaryName = primaryDef?.name ?? primaryKpi;
    const secondaryName = secondaryDef?.name ?? secondaryKpi;

    const series: Record<string, unknown>[] = [
      {
        name: `${appALabel} · ${primaryName}`,
        type: "line",
        yAxisIndex: 0,
        showSymbol: false,
        connectNulls: false,
        lineStyle: { color: appAColor, width: 2 },
        itemStyle: { color: appAColor },
        data: alignTo(dates, primaryA),
      },
      {
        name: `${appBLabel} · ${primaryName}`,
        type: "line",
        yAxisIndex: 0,
        showSymbol: false,
        connectNulls: false,
        lineStyle: { color: appBColor, width: 2 },
        itemStyle: { color: appBColor },
        data: alignTo(dates, primaryB),
      },
    ];

    if (secondaryKpi) {
      const secondaryAxisIndex = dualAxis ? 1 : 0;
      series.push(
        {
          name: `${appALabel} · ${secondaryName}`,
          type: "line",
          yAxisIndex: secondaryAxisIndex,
          showSymbol: false,
          connectNulls: false,
          lineStyle: { color: appAColor, width: 2, type: "dashed" },
          itemStyle: { color: appAColor },
          data: alignTo(dates, secondaryA),
        },
        {
          name: `${appBLabel} · ${secondaryName}`,
          type: "line",
          yAxisIndex: secondaryAxisIndex,
          showSymbol: false,
          connectNulls: false,
          lineStyle: { color: appBColor, width: 2, type: "dashed" },
          itemStyle: { color: appBColor },
          data: alignTo(dates, secondaryB),
        },
      );
    }

    return {
      // The SVG renderer is set at init time; nothing here rasterizes.
      animation: false,
      tooltip: { trigger: "axis" },
      legend: { textStyle: { color: axisColor }, type: "scroll" },
      grid: { top: 48, right: dualAxis ? 56 : 24, bottom: 32, left: 56 },
      xAxis: {
        type: "category",
        data: dates,
        boundaryGap: false,
        axisLabel: { color: axisColor },
        axisLine: { lineStyle: { color: gridLine } },
      },
      yAxis: yAxes,
      series,
    } as echarts.EChartsCoreOption;
  }, [
    primaryA,
    primaryB,
    secondaryA,
    secondaryB,
    dualAxis,
    primaryDef,
    secondaryDef,
    primaryKpi,
    secondaryKpi,
    appALabel,
    appBLabel,
  ]);

  // Initialize the chart with the SVG renderer once the container mounts, and
  // dispose it on unmount. Using SVG (not canvas) is required so the print /
  // Executive Report view keeps vector nodes in the DOM (Req 18.5).
  React.useEffect(() => {
    const el = chartRef.current;
    if (!el || !hasData) return;

    const instance = echarts.init(el, undefined, { renderer: "svg" });
    instanceRef.current = instance;

    const onResize = () => instance.resize();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      instance.dispose();
      instanceRef.current = null;
    };
  }, [hasData]);

  // Push the latest option whenever it changes (metric switch or slice change).
  React.useEffect(() => {
    if (!hasData) return;
    instanceRef.current?.setOption(option, { notMerge: true });
  }, [option, hasData]);

  return (
    <section
      aria-label="Time-series trend overlay"
      data-testid="time-series-overlay"
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-4",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <LineChartIcon className="size-4 text-primary" aria-hidden="true" />
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            Trend Overlay
          </h2>
        </div>

        {/* Metric switcher(s) (Req 13.2, 13.3). */}
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Metric
            <select
              aria-label="Metric"
              value={primaryKpi}
              onChange={(e) => setPrimaryKpi(e.target.value as CanonicalKPIId)}
              className="rounded-md border border-input bg-background px-2 py-1 text-xs font-normal normal-case text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {METRIC_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Compare
            <select
              aria-label="Compare metric"
              value={secondaryKpi}
              onChange={(e) =>
                setSecondaryKpi(e.target.value as CanonicalKPIId | "")
              }
              className="rounded-md border border-input bg-background px-2 py-1 text-xs font-normal normal-case text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">None</option>
              {METRIC_OPTIONS.filter((m) => m.id !== primaryKpi).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>

          {dualAxis && (
            <span
              data-testid="dual-axis-indicator"
              className="rounded bg-secondary px-1.5 py-0.5 text-2xs font-medium text-secondary-foreground"
            >
              Dual axis
            </span>
          )}
        </div>
      </div>

      {hasData ? (
        <>
          <div
            ref={chartRef}
            data-testid="time-series-chart"
            role="img"
            aria-label={`Trend of ${primaryDef?.name ?? primaryKpi} for ${appALabel} and ${appBLabel}`}
            className="h-72 w-full"
          />
          {/* Visually-hidden tabular alternative so the plotted series/values
              are available to assistive tech (Req 28.4). */}
          <TrendDataTable
            primaryName={primaryDef?.name ?? primaryKpi}
            secondaryName={secondaryKpi ? (secondaryDef?.name ?? secondaryKpi) : undefined}
            appALabel={appALabel}
            appBLabel={appBLabel}
            primaryA={primaryA}
            primaryB={primaryB}
            secondaryA={secondaryA}
            secondaryB={secondaryB}
          />
        </>
      ) : (
        <div
          data-testid="time-series-no-data"
          className="flex h-72 flex-col items-center justify-center rounded-md border border-dashed border-border text-center"
        >
          <SearchX className="size-7 text-muted-foreground" aria-hidden="true" />
          <p className="mt-2 text-sm font-medium text-foreground">
            {noData
              ? "No data for the current filters"
              : `No time-series data for ${primaryDef?.name ?? primaryKpi}`}
          </p>
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">
            Widen the date range or pick a different metric to see a trend.
          </p>
        </div>
      )}
    </section>
  );
}
