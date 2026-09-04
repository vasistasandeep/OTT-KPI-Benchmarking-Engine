import * as React from "react";
import * as echarts from "echarts";
import { AlertTriangle, BarChart3, Layers, SearchX } from "lucide-react";

import { cn } from "@/lib/utils";
import { useDatasetStore, useResultStore } from "@/stores";
import {
  PERCENTILE_RANKS,
  derivePercentileDistribution,
  hasNotAggregableCell,
  type PercentileCellState,
  type PercentileDistributionData,
  type PercentileMetricSeries,
} from "./percentile-data";

/**
 * PercentileDistribution — side-by-side P50/P90/P95 latency bars comparing
 * App_A and App_B for Video Start Time, Manifest Fetch Latency, and Time To
 * First Byte, each in its canonical unit (task 17.4; design "Percentile
 * Distribution"; Req 13.6, 22.2, 23.4–23.8).
 *
 * The module is a pure *reader*. It never computes or averages percentiles
 * (Req 23.6); it renders whatever the engine already aggregated into
 * `useResultStore.aggregated` for the active slice:
 * - In `Raw_Session_Mode` the engine recomputes each percentile from the raw
 *   values of the active slice on every slice change (Req 23.7), so the bars
 *   here re-render from those recomputed values whenever the store updates
 *   (Req 13.4-style reactivity via the Zustand subscription).
 * - In `Pre_Aggregated_Mode` the engine surfaces an ingested percentile only
 *   when the slice matches the granularity it was ingested at (Req 23.5), and
 *   resolves it to `NOT_AGGREGABLE` otherwise (Req 23.4). This module renders
 *   the not-aggregable state — a glyph plus a text label, never color alone
 *   (Req 28.1/28.2) — with a reason, and draws no bar, because there is no
 *   valid value to draw (Req 23.8). It never falls back to averaging.
 *
 * The chart uses ECharts with the SVG renderer so it stays a crisp vector
 * element in the print/Executive Report view rather than rasterizing to a blank
 * canvas (design note on `renderer: 'svg'`, consistent with the TimeSeriesOverlay).
 * All colors resolve against the dark-theme token layer in `index.css`
 * (Req 15.1); the component reads the computed CSS variables at render time and
 * feeds concrete color strings to ECharts, which cannot resolve CSS variables.
 */

export interface PercentileDistributionProps {
  className?: string;
}

/** The label for each cell state used in tooltips and the empty legend. */
function cellStateLabel(state: PercentileCellState): string {
  switch (state.kind) {
    case "value":
      return "";
    case "not_aggregable":
      return "Not aggregable";
    case "no_data":
      return "No data";
    case "unavailable":
      return "Not reported";
  }
}

/**
 * Read a hsl() color from a CSS custom property on the document root, so
 * ECharts (which cannot resolve CSS variables) gets a concrete color that still
 * tracks the dark-theme token layer. Falls back to a neutral grey when the
 * variable is absent (e.g. in a bare jsdom test without the stylesheet).
 */
function themeColor(variable: string, fallback: string): string {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") {
    return fallback;
  }
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(variable)
    .trim();
  return raw ? `hsl(${raw})` : fallback;
}

/** The concrete colors the chart needs, resolved from the theme tokens. */
interface ChartTheme {
  appA: string;
  appB: string;
  axis: string;
  text: string;
}

function readChartTheme(): ChartTheme {
  return {
    appA: themeColor("--primary", "hsl(199 89% 55%)"),
    appB: themeColor("--rag-amber", "hsl(38 92% 55%)"),
    axis: themeColor("--border", "hsl(217 33% 20%)"),
    text: themeColor("--muted-foreground", "hsl(215 20% 65%)"),
  };
}

/**
 * Build the ECharts option for one metric's grouped bars. Ranks run along the
 * category axis; App_A and App_B are two bar series. Only cells with a numeric
 * value contribute a bar; not-aggregable / no-data / unavailable ranks leave a
 * gap (they are explained by the per-metric state list beside the chart).
 */
function buildMetricOption(
  series: PercentileMetricSeries,
  labels: { appA: string; appB: string },
  theme: ChartTheme,
): echarts.EChartsOption {
  const categories = series.rows.map((r) => `P${r.rank}`);
  const appAData = series.rows.map((r) =>
    r.appA.state.kind === "value" ? r.appA.state.value : null,
  );
  const appBData = series.rows.map((r) =>
    r.appB.state.kind === "value" ? r.appB.state.value : null,
  );

  return {
    animation: false,
    grid: { left: 8, right: 12, top: 28, bottom: 8, containLabel: true },
    legend: {
      top: 0,
      textStyle: { color: theme.text, fontSize: 11 },
      data: [labels.appA, labels.appB],
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      valueFormatter: (value) =>
        typeof value === "number" ? `${value} ${series.metric.unit}` : "—",
    },
    xAxis: {
      type: "value",
      name: series.metric.unit,
      nameTextStyle: { color: theme.text, fontSize: 10 },
      axisLine: { lineStyle: { color: theme.axis } },
      axisLabel: { color: theme.text, fontSize: 10 },
      splitLine: { lineStyle: { color: theme.axis, opacity: 0.4 } },
    },
    yAxis: {
      type: "category",
      data: categories,
      axisLine: { lineStyle: { color: theme.axis } },
      axisLabel: { color: theme.text, fontSize: 11 },
    },
    series: [
      {
        name: labels.appA,
        type: "bar",
        data: appAData,
        itemStyle: { color: theme.appA },
        barMaxWidth: 14,
      },
      {
        name: labels.appB,
        type: "bar",
        data: appBData,
        itemStyle: { color: theme.appB },
        barMaxWidth: 14,
      },
    ],
  };
}

/** A single ECharts (SVG) bar chart for one metric, kept in sync with props. */
function MetricChart({
  series,
  labels,
}: {
  series: PercentileMetricSeries;
  labels: { appA: string; appB: string };
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const chartRef = React.useRef<echarts.ECharts | null>(null);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // SVG renderer so the chart prints as vector rather than a blank canvas.
    const chart = echarts.init(el, undefined, { renderer: "svg" });
    chartRef.current = chart;

    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  // Re-apply the option whenever the derived series or labels change, so a
  // slice change (which produces new aggregated values) re-renders the bars.
  React.useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setOption(buildMetricOption(series, labels, readChartTheme()), {
      notMerge: true,
    });
  }, [series, labels]);

  return (
    <>
      <div
        ref={containerRef}
        data-testid={`percentile-chart-${series.metric.key}`}
        className="h-40 w-full"
        role="img"
        aria-label={`${series.metric.name} percentile bars, ${labels.appA} versus ${labels.appB}, in ${series.metric.unit}`}
      />
      <PercentileDataTable series={series} labels={labels} />
    </>
  );
}

/** Render a percentile cell as a plain string for the tabular alternative. */
function cellText(state: PercentileCellState, unit: string): string {
  return state.kind === "value"
    ? `${state.value} ${unit}`
    : cellStateLabel(state);
}

/**
 * A visually-hidden data table mirroring one metric's grouped bars, so assistive
 * tech can read the plotted percentile values (Req 28.4). One row per rank; the
 * App_A / App_B columns carry either the numeric value with its unit or the
 * cell's state label (not aggregable / no data / not reported).
 */
function PercentileDataTable({
  series,
  labels,
}: {
  series: PercentileMetricSeries;
  labels: { appA: string; appB: string };
}) {
  return (
    <table
      className="sr-only"
      data-testid={`percentile-data-table-${series.metric.key}`}
    >
      <caption>
        {series.metric.name} percentiles in {series.metric.unit}, {labels.appA}{" "}
        versus {labels.appB}
      </caption>
      <thead>
        <tr>
          <th scope="col">Percentile</th>
          <th scope="col">{labels.appA}</th>
          <th scope="col">{labels.appB}</th>
        </tr>
      </thead>
      <tbody>
        {series.rows.map((row) => (
          <tr key={row.rank}>
            <th scope="row">P{row.rank}</th>
            <td>{cellText(row.appA.state, series.metric.unit)}</td>
            <td>{cellText(row.appB.state, series.metric.unit)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The per-rank state list beside each metric's chart: it names every rank that
 * has no drawable bar and why (not-aggregable, no-data, or not reported), so
 * the reason is available without relying on the chart's color (Req 23.8, 28.1).
 */
function RankStateList({ series }: { series: PercentileMetricSeries }) {
  const nonValueRows = series.rows.filter(
    (r) => r.appA.state.kind !== "value" || r.appB.state.kind !== "value",
  );
  if (nonValueRows.length === 0) return null;

  return (
    <ul className="mt-2 space-y-1 text-2xs text-muted-foreground">
      {nonValueRows.map((row) => {
        const notAggregable =
          row.appA.state.kind === "not_aggregable" ||
          row.appB.state.kind === "not_aggregable";
        return (
          <li
            key={row.rank}
            data-testid={`percentile-state-${series.metric.key}-p${row.rank}`}
            className="flex items-center gap-1.5"
          >
            {notAggregable ? (
              <Layers
                className="size-3 shrink-0 text-rag-amber"
                aria-hidden="true"
              />
            ) : (
              <SearchX className="size-3 shrink-0" aria-hidden="true" />
            )}
            <span className="font-medium text-foreground">P{row.rank}</span>
            <span>
              {notAggregable
                ? "not aggregable — narrow the slice to the ingested granularity"
                : row.appA.state.kind === "unavailable" &&
                    row.appB.state.kind === "unavailable"
                  ? "not reported for this metric"
                  : cellStateLabel(row.appA.state) ||
                    cellStateLabel(row.appB.state)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** One metric panel: chart (when drawable) plus its per-rank state list. */
function MetricPanel({
  series,
  labels,
}: {
  series: PercentileMetricSeries;
  labels: { appA: string; appB: string };
}) {
  return (
    <section
      aria-label={`${series.metric.name} percentile distribution`}
      data-testid={`percentile-metric-${series.metric.key}`}
      className="rounded-lg border border-border bg-card/40 p-3"
    >
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-semibold tracking-tight text-foreground">
          {series.metric.name}
        </h3>
        <span className="text-2xs text-muted-foreground">{series.metric.unit}</span>
      </div>

      {series.hasAnyValue ? (
        <MetricChart series={series} labels={labels} />
      ) : (
        <div
          data-testid={`percentile-empty-${series.metric.key}`}
          className="flex h-40 flex-col items-center justify-center text-center"
        >
          <SearchX
            className="size-6 text-muted-foreground"
            aria-hidden="true"
          />
          <p className="mt-2 text-xs text-foreground">No percentile values</p>
          <p className="mt-0.5 max-w-[16rem] text-2xs text-muted-foreground">
            No drawable P50/P90/P95 values for the active slice.
          </p>
        </div>
      )}

      <RankStateList series={series} />
    </section>
  );
}

export function PercentileDistribution({
  className,
}: PercentileDistributionProps) {
  const aggregated = useResultStore((s) => s.aggregated);
  const appALabel = useDatasetStore((s) => s.appALabel);
  const appBLabel = useDatasetStore((s) => s.appBLabel);

  const data: PercentileDistributionData = React.useMemo(
    () => derivePercentileDistribution(aggregated),
    [aggregated],
  );

  const labels = React.useMemo(
    () => ({ appA: appALabel, appB: appBLabel }),
    [appALabel, appBLabel],
  );

  const notAggregable = hasNotAggregableCell(data);

  return (
    <section
      aria-label="Percentile Distribution"
      data-testid="percentile-distribution"
      className={cn("rounded-lg border border-border bg-card/40 p-4", className)}
    >
      <div className="flex items-center gap-2">
        <BarChart3 className="size-4 text-primary" aria-hidden="true" />
        <h2 className="text-sm font-semibold tracking-tight text-foreground">
          Percentile Distribution
        </h2>
        <span className="ml-auto text-2xs text-muted-foreground">
          P{PERCENTILE_RANKS.join(" / P")} · {labels.appA} vs {labels.appB}
        </span>
      </div>

      {/* Module-level not-aggregable advisory: glyph + text, not color alone. */}
      {notAggregable && (
        <div
          role="status"
          data-testid="percentile-not-aggregable-advisory"
          className="mt-3 flex items-start gap-2 rounded-md border border-rag-amber/40 bg-rag-amber/10 px-3 py-2 text-2xs text-foreground"
        >
          <AlertTriangle
            className="mt-0.5 size-3.5 shrink-0 text-rag-amber"
            aria-hidden="true"
          />
          <span>
            Some percentiles are <strong>not aggregable</strong> for this slice.
            Pre-aggregated percentiles are only valid at the granularity they
            were ingested at — narrow the slice to that granularity to see them.
          </span>
        </div>
      )}

      {data.empty && !notAggregable ? (
        <div
          data-testid="percentile-distribution-no-data"
          className="mt-3 flex flex-col items-center justify-center rounded-md border border-border py-10 text-center"
        >
          <SearchX className="size-6 text-muted-foreground" aria-hidden="true" />
          <p className="mt-2 text-xs font-medium text-foreground">
            No percentile data for the current filters
          </p>
          <p className="mt-0.5 max-w-sm text-2xs text-muted-foreground">
            No latency percentiles were produced for the active slice. Widen the
            date range or enable both apps.
          </p>
        </div>
      ) : (
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          {data.metrics.map((series) => (
            <MetricPanel
              key={series.metric.key}
              series={series}
              labels={labels}
            />
          ))}
        </div>
      )}
    </section>
  );
}
