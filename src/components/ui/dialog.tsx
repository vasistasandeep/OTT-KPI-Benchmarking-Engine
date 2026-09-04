import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A minimal, dependency-free accessible modal dialog.
 *
 * The ingestion modals (mode prompt, column mapping) and confirmation dialogs
 * all render through this primitive so they share one accessibility contract
 * (design "Modals", Req 28.6, 28.7):
 *
 *   - the dialog traps keyboard focus while open (28.6);
 *   - it is labelled by its heading via `aria-labelledby`;
 *   - `Escape` dismisses it (when `dismissible`);
 *   - closing restores focus to the control that was focused when it opened
 *     (28.7).
 *
 * It is intentionally not built on a headless-UI dependency: the project ships
 * only `class-variance-authority` + Tailwind for UI, so this keeps the modal
 * behavior in-repo, testable, and free of a new runtime dependency.
 */

/** Focusable-element selector used to find the focus-trap boundaries. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export interface DialogProps {
  /** Whether the dialog is mounted and visible. */
  open: boolean;
  /** Called when the user requests dismissal (Escape, overlay click, close button). */
  onClose: () => void;
  /** The id of the element that labels the dialog (its heading). */
  labelledBy: string;
  /** Optional id of the element that describes the dialog. */
  describedBy?: string;
  /** When false, Escape and overlay clicks do not close the dialog (e.g. a required choice). */
  dismissible?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * Render an accessible modal dialog. When `open` transitions to true the first
 * focusable descendant receives focus; when it closes, focus returns to the
 * previously focused element (Req 28.7).
 */
export function Dialog({
  open,
  onClose,
  labelledBy,
  describedBy,
  dismissible = true,
  className,
  children,
}: DialogProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const previouslyFocused = React.useRef<HTMLElement | null>(null);

  // Capture the invoking control, move focus in, and restore it on close (28.7).
  React.useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    if (panel) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? panel).focus();
    }

    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape" && dismissible) {
        event.stopPropagation();
        onClose();
        return;
      }

      // Focus trap: keep Tab / Shift+Tab inside the dialog (Req 28.6).
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [dismissible, onClose],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        // Overlay (not panel) click dismisses, when dismissible.
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn(
          "flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-xl focus:outline-none",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Sticky dialog header row: heading on the left, optional actions on the right. */
export function DialogHeader({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 border-b border-border px-5 py-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Scrollable dialog body. */
export function DialogBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex-1 overflow-y-auto px-5 py-4", className)}>{children}</div>
  );
}

/** Sticky dialog footer for the primary/secondary actions. */
export function DialogFooter({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-2 border-t border-border px-5 py-4",
        className,
      )}
    >
      {children}
    </div>
  );
}
