import * as React from "react";

import { ensurePrintStyles } from "@/lib/export/download";

/**
 * ExecutiveReport — the print-target wrapper for the dashboard (design "Export
 * & Executive Report", Req 18.5, 18.6).
 *
 * It wraps the dashboard content the Executive Report is generated from and
 * registers the print-optimized stylesheet on mount so the styles are present
 * before `Print Executive Report` is invoked (the actual `window.print()` call
 * lives in the export menu). The print CSS hides navigation, the filter bar,
 * and shadows while preserving the SVG vector charts and tabular contrast, so
 * the printed page carries only the analytical content and the charts do not
 * rasterize to blank canvases (Req 18.5).
 *
 * Chrome that should never appear on paper (the filter bar, the export menu,
 * navigation) marks itself with `data-print-hide`; this wrapper marks its
 * report region so downstream print styling can target it, and exposes the
 * region under a stable data attribute for the print-render test (task 18.6).
 */

export interface ExecutiveReportProps {
  children: React.ReactNode;
  className?: string;
}

export function ExecutiveReport({ children, className }: ExecutiveReportProps) {
  React.useEffect(() => {
    ensurePrintStyles();
  }, []);

  return (
    <div data-executive-report className={className}>
      {children}
    </div>
  );
}
