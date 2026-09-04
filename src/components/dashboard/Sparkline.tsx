import { cn } from "@/lib/utils";
import { NO_DATA, NOT_AGGREGABLE, type Numeric } from "@/models/sentinels";
import type { SeriesPoint } from "./scorecard-series";

/**
 * Sparkline — a compact 7-day trend line for a single KPI/app on a scorecard
 * (task 17.1, Req 11.7, 11.8).
 *
 * Rendered as inline SVG so it is a true vector element: it prints cleanly in
 * the Executive Report (Req 18.5) and is fully assertable in jsdom without a
 * canvas. Colors resolve against the dark-theme tokens via `currentColor` and
 * Tailwind text classes; nothing hard-codes a hex value (Req 15.1).
 *
 * Sentinel points (NO_DATA / NOT_AGGREGABLE) break the line so a gap is visible
 * rather than a misleading interpolation across missing days. With fewer than
 * the full window of days the caller sets `partial`, which the card badges
 * separately (Req 11.8); this component just draws whatever points it is given.
 */

export interface SparklineProps {
  points: readonly SeriesPoint[];
  /** Accessible description, e.g. "App A 7-day trend for Rebuffer Ratio". */
  label: string;
  width?: number;
  height?: number;
  className?: string;
}

/** Whether a point's value is a finite, plottable number. */
function isFinitePoint(value: Numeric): value is number {
  return value !== NO_DATA && value !== NOT_AGGREGABLE && Number.isFinite(value);
}

export function Sparkline({
  points,
  label,
  width = 96,
  height = 28,
  className,
}: SparklineProps) {
  const pad = 2;

  const finite = points
    .map((p, index) => ({ index, value: p.value }))
    .filter((p): p is { index: number; value: number } => isFinitePoint(p.value));

  // With no plottable points there is no line to draw — render an empty,
  // labelled frame so the card layout is stable and the state is announced.
  if (finite.length === 0) {
    return (
      <svg
        role="img"
        aria-label={`${label}: no trend data`}
        width={width}
        height={height}
        className={cn("text-muted-foreground/50", className)}
        data-testid="sparkline-empty"
      />
    );
  }

  const values = finite.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const n = points.length;
  const stepX = n > 1 ? (width - pad * 2) / (n - 1) : 0;

  const x = (index: number) => pad + index * stepX;
  const y = (value: number) =>
    height - pad - ((value - min) / span) * (height - pad * 2);

  // Build the polyline path, breaking it at any non-finite (sentinel) gap so a
  // missing day is a visible break, not an interpolated segment.
  let path = "";
  let penDown = false;
  for (const p of points.map((pt, index) => ({ index, value: pt.value }))) {
    if (isFinitePoint(p.value)) {
      const cmd = penDown ? "L" : "M";
      path += `${cmd}${x(p.index).toFixed(2)},${y(p.value).toFixed(2)} `;
      penDown = true;
    } else {
      penDown = false;
    }
  }

  const last = finite[finite.length - 1];

  return (
    <svg
      role="img"
      aria-label={label}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("text-primary", className)}
      data-testid="sparkline"
    >
      <path
        d={path.trim()}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Endpoint marker so a single-day series is still visible. */}
      <circle
        cx={x(last.index)}
        cy={y(last.value)}
        r={1.8}
        fill="currentColor"
      />
    </svg>
  );
}
