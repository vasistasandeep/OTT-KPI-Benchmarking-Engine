import { describe, expect, it } from "vitest";
import fc from "fast-check";

// Smoke test that verifies the Vitest + fast-check + jsdom + fake-indexeddb
// harness is wired up correctly. Replaced/expanded by real suites in later tasks.
describe("test harness", () => {
  it("runs a trivial vitest assertion", () => {
    expect(1 + 1).toBe(2);
  });

  it("has jsdom globals available", () => {
    const el = document.createElement("div");
    el.textContent = "ok";
    expect(el.textContent).toBe("ok");
  });

  it("exposes a global indexedDB via fake-indexeddb", () => {
    expect(typeof indexedDB).not.toBe("undefined");
    expect(typeof IDBKeyRange).not.toBe("undefined");
  });

  it("can run a fast-check property", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a;
      }),
      { numRuns: 100 },
    );
  });
});
