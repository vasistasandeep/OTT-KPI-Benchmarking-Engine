// Shared Vitest setup, loaded once per test worker via `setupFiles` in vite.config.ts.
//
// Responsibilities:
//   1. Register the jsdom matchers from @testing-library/jest-dom so assertions
//      like `toBeInTheDocument()` / `toHaveAccessibleName()` are available.
//   2. Register jest-axe's `toHaveNoViolations` matcher for accessibility scans.
//   3. Install fake-indexeddb via `fake-indexeddb/auto`, which patches the global
//      `indexedDB` / `IDBKeyRange` so Dexie-backed repository tests run in jsdom.
//   4. Ensure React Testing Library unmounts and clears the DOM between tests.

import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";

import { afterEach, expect } from "vitest";
import { cleanup } from "@testing-library/react";
import { toHaveNoViolations } from "jest-axe";

expect.extend(toHaveNoViolations);

afterEach(() => {
  cleanup();
});
