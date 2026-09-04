import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import { TimeSeriesOverlay } from "@/components/dashboard/TimeSeriesOverlay";
import { PercentileDistribution } from "@/components/dashboard/PercentileDistribution";
import { ExecutiveReport } from "./ExecutiveReport";
import {
  PRINT_CSS,
  PRINT_STYLE_ID,
  PRINTING_CLASS,
  printExecutiveReport,
} from "@/lib/export/download";

import type { CanonicalKPIId } from "@/models/ids";
import type { AppAssignment } from "@/models/records";
import type { AggregatedKPIValue, AggregatedResultSet } from "@/models/results";
import { useDatasetStore, useResultStore } from "@/stores";

/**
 * Print-render test (task 18.6, Req 18.5).
 *
 * Unlike the other chart suites — which mock `echarts` because they only care
 * about the option that is fed to the chart — this suite deliberately uses the
 * **real** ECharts render. The whole point is to prove that when the chart
 * components initialize ECharts with `renderer: 'svg'` (tasks 17.3 / 17.4) the
 * chart materializes as `<svg>` vector nodes in the DOM, and that triggering
 * the Executive Report print flow (print CSS + `window.print()`) leaves those
 * SVG nodes in place rather than replacing them with a rasterized `<canvas>`
 * that would print as a blank box.
 *
 * jsdom has no real layout engine or canvas, so two shims are needed for a
 * real ECharts render:
 *   1. Chart container elements report a non-zero size (ECharts refuses to
 *      draw into a zero-sized box), and
 *   2. `HTMLCanvasElement.getContext` is stubbed so ECharts' text-measurement
 *      path does not throw. ECharts still emits SVG — the SVG renderer does not
 *      paint to a canvas; the canvas is only touched to measure text.
 */

/** Give every element a non-zero measured size so ECharts will draw. */
function stubLayout(width = 480, height = 320) {
  const size = (value: number) => ({
    configurable: true,
    get() {
      return value;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", size(width));
  Object.defineProperty(HTMLElement.prototype, "clientHeight", size(height));
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", size(width));
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", size(height));
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect;
}

/** Minimal fake 2D context so ECharts' text measurement does not throw. */
function stubCanvasContext() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        measureText: () => ({ width: 8 }) as TextMetrics,
        fillText: () => {},
        save: () => {},
        restore: () => {},
        beginPath: () => {},
        setTransform: () => {},
        clearRect: () => {},
      }) as unknown as CanvasRenderingContext2D,
  );
}

function value(
  overrides: Partial<AggregatedKPIValue> &
    Pick<AggregatedKPIValue, "kpiId" | "app">,
): AggregatedKPIValue {
  return {
    value: 0,
    unit: "ms",
    aggregability: "aggregable",
    weighted: true,
    contributingRecords: 10,
    rejectedRecords: [],
    advisories: [],
    ...overrides,
  } as AggregatedKPIValue;
}

function pct(
  kpiId: CanonicalKPIId,
  app: AppAssignment,
  v: number,
): AggregatedKPIValue {
  return value({
    kpiId,
    app,
    value: v,
    unit: kpiId === "vst_p50" || kpiId === "vst_p95" ? "s" : "ms",
  });
}

/** Publish an aggregated result set into the result store. */
function setAggregated(overall: AggregatedKPIValue[]) {
  const aggregated: AggregatedResultSet = {
    bySegment: new Map(),
    overall,
    unweightedAdvisory: false,
  };
  useResultStore.setState({ aggregated, noData: false, status: "ready" });
}

beforeEach(() => {
  stubLayout();
  stubCanvasContext();
  useResultStore.setState({ aggregated: null, noData: false, status: "idle" });
  useDatasetStore.setState({ appALabel: "App A", appBLabel: "App B" });
  document.documentElement.classList.remove(PRINTING_CLASS);
  document.getElementById(PRINT_STYLE_ID)?.remove();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Executive Report print render (Req 18.5)", () => {
  it("keeps every ECharts instance as SVG vector nodes — never a canvas", () => {
    setAggregated([
      pct("vst_p50", "App_A", 1.2),
      pct("vst_p50", "App_B", 1.5),
      pct("manifest_fetch_latency", "App_A", 42),
      pct("manifest_fetch_latency", "App_B", 55),
      pct("ttfb", "App_A", 120),
      pct("ttfb", "App_B", 140),
    ]);

    const { container } = render(
      <ExecutiveReport>
        <TimeSeriesOverlay />
        <PercentileDistribution />
      </ExecutiveReport>,
    );

    // Both chart families rendered vector SVG output...
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThan(0);

    // ...and no chart fell back to canvas rasterization.
    const echartsCanvases = container.querySelectorAll(
      "[data-testid='time-series-chart'] canvas, " +
        "[data-testid^='percentile-chart-'] canvas",
    );
    expect(echartsCanvases.length).toBe(0);
  });

  it("retains the SVG nodes after the print styling / print flow is triggered", () => {
    setAggregated([
      pct("vst_p50", "App_A", 1.2),
      pct("vst_p50", "App_B", 1.5),
      pct("manifest_fetch_latency", "App_A", 42),
      pct("manifest_fetch_latency", "App_B", 55),
    ]);

    const { container } = render(
      <ExecutiveReport>
        <TimeSeriesOverlay />
        <PercentileDistribution />
      </ExecutiveReport>,
    );

    const before = container.querySelectorAll("svg").length;
    expect(before).toBeGreaterThan(0);

    // Trigger the print flow: inject print CSS, mark the doc printing, call print().
    const printSpy = vi
      .spyOn(window, "print")
      .mockImplementation(() => undefined);
    printExecutiveReport();

    expect(printSpy).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains(PRINTING_CLASS)).toBe(
      true,
    );

    // The SVG vector nodes survive the print flow unchanged — none were
    // removed or swapped for a rasterized canvas.
    const after = container.querySelectorAll("svg").length;
    expect(after).toBe(before);
    const echartsCanvases = container.querySelectorAll(
      "[data-testid='time-series-chart'] canvas, " +
        "[data-testid^='percentile-chart-'] canvas",
    );
    expect(echartsCanvases.length).toBe(0);
  });

  it("prints CSS that preserves — never hides or rasterizes — SVG charts", () => {
    // The print stylesheet keeps svg visible and does not set display:none on it.
    expect(PRINT_CSS).toMatch(/svg\s*\{[^}]*visibility:\s*visible/);
    expect(PRINT_CSS).toMatch(/svg\s*\{[^}]*display:\s*inline-block/);
    // The only display:none rules target chrome (nav / filters), not svg.
    const svgBlock = PRINT_CSS.slice(PRINT_CSS.indexOf("svg {"));
    expect(svgBlock).not.toMatch(/svg\s*\{[^}]*display:\s*none/);
  });
});
