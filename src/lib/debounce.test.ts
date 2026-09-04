/**
 * Unit tests for the trailing-edge debounce used by the recompute pipeline.
 *
 * Verify a burst collapses to one invocation with the latest arguments after
 * the quiet period, and that `cancel` and `flush` behave. Uses fake timers so
 * the 150 ms window is exercised without real waits.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { debounce } from "./debounce";

describe("debounce", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("collapses a burst into a single trailing call with the latest args", () => {
    const fn = vi.fn();
    const d = debounce(fn, 150);

    d(1);
    d(2);
    d(3);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3);
  });

  it("runs again after the window elapses between calls", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d("a");
    vi.advanceTimersByTime(100);
    d("b");
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("cancel drops a pending invocation", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d("x");
    d.cancel();
    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
  });

  it("flush runs a pending invocation immediately", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d("y");
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("y");
    // No double-run when the (cleared) timer would have fired.
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
