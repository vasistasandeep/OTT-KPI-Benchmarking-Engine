import { describe, expect, it } from "vitest";

import { PRINT_CSS } from "./download";

/**
 * Print-CSS hiding-rules test (task 21.2, Req 18.5).
 *
 * The companion suite `components/export/print-render.test.tsx` already proves
 * the *SVG-retention* half of the print contract (charts stay as vector `<svg>`
 * nodes and are never hidden). This suite covers the other half that suite
 * deliberately leaves alone: that the Executive Report print stylesheet
 * **hides the interactive chrome** — anything tagged `data-print-hide`, the
 * `<nav>` / `role="navigation"` region, and the global filter bar — and
 * **flattens shadows**, so a printed report carries only analytical content
 * (Req 18.5). A frozen snapshot of the stylesheet guards the whole rule set
 * against silent regressions.
 *
 * These are pure string assertions over `PRINT_CSS`: the print stylesheet is
 * the single source of truth for what the browser applies inside `@media
 * print`, and asserting the rules directly is deterministic in jsdom (which has
 * no print media query or layout engine to exercise the CSS live).
 */

/**
 * Extract the body of the CSS rule whose selector list ends just before
 * `declarations`. Returns the text between the matching `{` and `}` so a test
 * can assert what a specific selector group declares without depending on
 * unrelated whitespace elsewhere in the sheet.
 */
function ruleBodyContaining(css: string, selectorNeedle: string): string {
  const selectorIndex = css.indexOf(selectorNeedle);
  expect(selectorIndex).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", selectorIndex);
  const close = css.indexOf("}", open);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return css.slice(open + 1, close);
}

describe("Executive Report print CSS (Req 18.5)", () => {
  it("scopes every print rule inside an @media print block", () => {
    expect(PRINT_CSS).toMatch(/@media\s+print\s*\{/);
  });

  it("hides content explicitly opted out of print via data-print-hide", () => {
    const body = ruleBodyContaining(PRINT_CSS, "[data-print-hide]");
    expect(body).toMatch(/display:\s*none\s*!important/);
  });

  it("hides the navigation chrome (nav / role=navigation)", () => {
    // Both nav selectors share the hiding rule group with data-print-hide.
    expect(PRINT_CSS).toMatch(/nav\s*,/);
    expect(PRINT_CSS).toMatch(/\[role="navigation"\]/);
    const body = ruleBodyContaining(PRINT_CSS, "[data-print-hide]");
    expect(body).toMatch(/display:\s*none\s*!important/);
  });

  it("hides the global filter bar by class and by data attribute", () => {
    expect(PRINT_CSS).toMatch(/\.global-filter-bar/);
    expect(PRINT_CSS).toMatch(/\[data-filter-bar\]/);
    // They belong to the same display:none rule that hides the other chrome.
    const hidingBlock = PRINT_CSS.slice(
      PRINT_CSS.indexOf("[data-print-hide]"),
      PRINT_CSS.indexOf("[data-print-hide]") + 200,
    );
    expect(hidingBlock).toContain(".global-filter-bar");
    expect(hidingBlock).toContain("[data-filter-bar]");
  });

  it("flattens box and text shadows — paper has no depth", () => {
    const body = ruleBodyContaining(PRINT_CSS, "* {");
    expect(body).toMatch(/box-shadow:\s*none\s*!important/);
    expect(body).toMatch(/text-shadow:\s*none\s*!important/);
  });

  it("keeps SVG charts visible even while hiding the chrome (does not over-hide)", () => {
    // The chrome-hiding rule must not name svg; svg has its own preserve rule.
    const hidingBlock = PRINT_CSS.slice(
      PRINT_CSS.indexOf("[data-print-hide]"),
      PRINT_CSS.indexOf("}", PRINT_CSS.indexOf("[data-print-hide]")),
    );
    expect(hidingBlock).not.toContain("svg");
    const svgBody = ruleBodyContaining(PRINT_CSS, "svg {");
    expect(svgBody).toMatch(/visibility:\s*visible/);
    expect(svgBody).not.toMatch(/display:\s*none/);
  });

  it("matches the approved print stylesheet snapshot", () => {
    // A frozen snapshot of the whole sheet guards the hiding rules, the shadow
    // flattening, and the SVG/table preservation against accidental edits.
    expect(PRINT_CSS).toMatchInlineSnapshot(`
      "
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
      "
    `);
  });
});
