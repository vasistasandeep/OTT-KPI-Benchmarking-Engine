/**
 * A tiny trailing-edge debounce used by the recompute pipeline so a burst of
 * filter changes (dragging a date slider, toggling several dimension chips)
 * collapses into a single recompute after the caller stops changing things.
 *
 * The debounced function tracks the *latest* arguments and invokes the wrapped
 * function once, `waitMs` after the last call. A `cancel` handle lets callers
 * (and tests) drop a pending invocation, and `flush` runs it immediately.
 *
 * Pure with respect to the DOM: it only uses `setTimeout`/`clearTimeout`, so it
 * runs identically under jsdom and the browser.
 */

/** A debounced wrapper exposing `cancel` and `flush` alongside the call. */
export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** Drop any pending trailing invocation. */
  cancel(): void;
  /** Run any pending trailing invocation immediately (no-op when none pending). */
  flush(): void;
}

/**
 * Wrap `fn` so calls are coalesced to a single trailing invocation `waitMs`
 * after the last call. The most recent arguments win.
 *
 * @param fn     the function to debounce.
 * @param waitMs the quiet period, in milliseconds, before `fn` runs.
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: A | null = null;

  const run = (): void => {
    timer = null;
    if (pendingArgs) {
      const args = pendingArgs;
      pendingArgs = null;
      fn(...args);
    }
  };

  const debounced = ((...args: A) => {
    pendingArgs = args;
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(run, waitMs);
  }) as Debounced<A>;

  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pendingArgs = null;
  };

  debounced.flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      run();
    }
  };

  return debounced;
}
