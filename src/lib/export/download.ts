/**
 * Browser side-effects for the export menu: file download and the print report
 * (Req 18.3, 18.5, 18.6).
 *
 * Kept separate from the pure CSV builders in `csv.ts` so the content logic
 * stays unit-testable without a DOM. These functions own the parts that only
 * make sense against a real document: triggering a download of already-built
 * text (Req 18.3), and applying the print-optimized stylesheet before opening
 * the browser print dialog (Req 18.5, 18.6).
 */

/**
 * Trigger a browser download of `content` as a file named `filename`. Builds an
 * object URL from a Blob and clicks a transient anchor, then revokes the URL so
 * the blob is released. Data never leaves the client device (Req 28.10, 28.11).
 */
export function triggerDownload(
  content: string,
  filename: string,
  mimeType = "text/csv;charset=utf-8",
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** The id of the injected print stylesheet, so it is added exactly once. */
export const PRINT_STYLE_ID = "executive-report-print-css";

/** The class applied to the document while the executive report is printing. */
export const PRINTING_CLASS = "executive-report-printing";

/**
 * Print-optimized CSS applied when the Executive Report is generated (Req 18.5).
 *
 * It hides navigation, the global filter bar, and background shadows so the
 * printed page carries only the analytical content. Crucially it does **not**
 * touch SVG elements: ECharts renders with the SVG renderer (task 17.3) so the
 * charts stay as crisp vector elements on paper rather than rasterizing to a
 * blank canvas, and tables keep full-contrast borders and text so the tabular
 * alternative to each chart remains legible in print.
 */
export const PRINT_CSS = `
@media print {
  /* Hide interactive chrome that has no place in a printed report (Req 18.5). */
  [data-print-hide],
  nav,
  [role="navigation"],
  .global-filter-bar,
  [data-filter-bar] {
    display: none !important;
  }

  /* Flatten shadows; paper has no depth (Req 18.5). */
  * {
    box-shadow: none !important;
    text-shadow: none !important;
  }

  /* Preserve SVG vector charts — never hide or rasterize them (Req 18.5, 17.3). */
  svg {
    display: inline-block !important;
    visibility: visible !important;
  }

  /* Preserve tabular contrast so the data alternative stays legible (Req 18.5). */
  table,
  th,
  td {
    border-color: #000 !important;
    color: #000 !important;
  }

  /* Force color to print rather than being dropped by the browser. */
  html {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
}
`;

/** Ensure the print stylesheet is present in the document head exactly once. */
export function ensurePrintStyles(doc: Document = document): void {
  if (doc.getElementById(PRINT_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = PRINT_STYLE_ID;
  style.media = "print";
  style.textContent = PRINT_CSS;
  doc.head.appendChild(style);
}

/**
 * Render the active dashboard as an Executive Report and open the print dialog
 * (Req 18.5, 18.6): inject the print-optimized styles, mark the document as
 * printing, then call `window.print()`. The printing marker is cleared once the
 * dialog closes so the on-screen dashboard is unaffected.
 */
export function printExecutiveReport(win: Window = window): void {
  const doc = win.document;
  ensurePrintStyles(doc);
  doc.documentElement.classList.add(PRINTING_CLASS);

  const cleanup = () => {
    doc.documentElement.classList.remove(PRINTING_CLASS);
    win.removeEventListener("afterprint", cleanup);
  };
  win.addEventListener("afterprint", cleanup);

  win.print();
}
