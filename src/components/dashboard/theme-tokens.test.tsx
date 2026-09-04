import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { GlobalFilterBar } from "./GlobalFilterBar";

/**
 * Dark-theme / RAG-token and sticky-filter-bar snapshot test (task 21.2,
 * Req 10.1, 15.1).
 *
 * `GlobalFilterBar.test.tsx` already asserts the bar's *behaviour* and its
 * sticky class in isolation. This suite pins the two theming contracts that the
 * behavioural suite does not cover:
 *
 *  1. **Dark-theme + RAG token definitions (Req 15.1).** The dark surface
 *     palette and the four high-contrast RAG accents (`--rag-green/amber/red/
 *     neutral`) plus the App_A / App_B chart stroke colors are defined once in
 *     `index.css` under `:root` (the default dark theme). If a token is renamed
 *     or dropped, every scorecard badge and chart line silently loses its color
 *     source, so the token names are the real contract to guard.
 *  2. **Sticky filter-bar positioning (Req 10.1).** The bar pins to the top of
 *     the scroll container so it stays on screen while the dashboard scrolls.
 *
 * jsdom applies no stylesheet cascade and computes no colors, so the token
 * *values* are asserted by reading `index.css` as text (its literal source is
 * the single source of truth for the theme), while the sticky positioning is
 * asserted against the rendered component's utility classes.
 */

/**
 * The raw text of the app's global stylesheet, read from disk. Vitest runs with
 * the project root as the working directory, so `src/index.css` resolves the
 * single source of truth for the theme tokens.
 */
const INDEX_CSS = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");

describe("Dark-theme and RAG design tokens (Req 15.1)", () => {
  it("defines the dark surface palette on :root (dark by default)", () => {
    const root = INDEX_CSS.slice(INDEX_CSS.indexOf(":root"));
    for (const token of [
      "--background",
      "--foreground",
      "--card",
      "--border",
      "--ring",
      "--primary",
      "--muted-foreground",
    ]) {
      expect(root).toContain(token);
    }
  });

  it("defines all four high-contrast RAG accent tokens", () => {
    for (const token of [
      "--rag-green",
      "--rag-amber",
      "--rag-red",
      "--rag-neutral",
    ]) {
      expect(INDEX_CSS).toContain(token);
    }
  });

  it("defines distinct App_A / App_B chart stroke tokens for contrast", () => {
    expect(INDEX_CSS).toContain("--chart-app-a");
    expect(INDEX_CSS).toContain("--chart-app-b");

    // Extract the two hue/sat/lightness triples and confirm they are not the
    // same color, so the two series stay visually distinguishable (Req 15.1).
    const appA = /--chart-app-a:\s*([^;]+);/.exec(INDEX_CSS)?.[1]?.trim();
    const appB = /--chart-app-b:\s*([^;]+);/.exec(INDEX_CSS)?.[1]?.trim();
    expect(appA).toBeTruthy();
    expect(appB).toBeTruthy();
    expect(appA).not.toEqual(appB);
  });

  it("provides tabular numerals so KPI columns align (Req 15.2)", () => {
    expect(INDEX_CSS).toMatch(/font-feature-settings:\s*"tnum"/);
  });
});

describe("GlobalFilterBar sticky positioning (Req 10.1)", () => {
  it("pins the filter bar to the top of the scroll container", () => {
    render(<GlobalFilterBar />);
    const bar = screen.getByTestId("global-filter-bar");
    // Sticky + top-0 keep the bar visible while the dashboard scrolls; a raised
    // z-index keeps it above scrolled content.
    expect(bar.className).toContain("sticky");
    expect(bar.className).toContain("top-0");
    expect(bar.className).toContain("z-40");
  });
});
