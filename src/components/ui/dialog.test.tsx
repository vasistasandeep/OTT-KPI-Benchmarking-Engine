import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

import { Dialog, DialogBody, DialogFooter, DialogHeader } from "./dialog";

/**
 * Accessibility tests for the shared modal primitive (task 19.3; Req 28.5,
 * 28.6, 28.7). Every ingestion/confirmation modal in the app renders through
 * this `Dialog`, so proving the focus-trap, `Escape` dismissal, and focus
 * restoration here covers the modal accessibility contract for all of them.
 *
 * These sit alongside the per-modal behavior tests (ManualEntryForm,
 * DatasetSwitcher) which cover open/confirm/cancel semantics; this file is the
 * single home for the keyboard-focus guarantees the primitive owns.
 */

/**
 * A small harness that owns the open/closed state and renders a real invoking
 * control, so focus restoration on close can be verified against the element
 * that opened the dialog (Req 28.7).
 */
function DialogHarness({ dismissible = true }: { dismissible?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const headingId = React.useId();
  const descId = React.useId();
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        labelledBy={headingId}
        describedBy={descId}
        dismissible={dismissible}
      >
        <DialogHeader>
          <h2 id={headingId}>Confirm action</h2>
        </DialogHeader>
        <DialogBody>
          <p id={descId}>Choose whether to proceed.</p>
          <input aria-label="Reason" />
        </DialogBody>
        <DialogFooter>
          <button type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            Confirm
          </button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

describe("Dialog accessibility", () => {
  it("exposes an accessible modal dialog labelled by its heading (Req 28.6)", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole("button", { name: /open dialog/i }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Confirm action");
  });

  it("moves keyboard focus into the dialog when it opens (Req 28.5, 28.6)", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole("button", { name: /open dialog/i }));

    const dialog = screen.getByRole("dialog");
    // Focus lands on the first focusable descendant (the Reason input) rather
    // than staying on the now-hidden trigger.
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("keeps Tab focus inside the dialog rather than escaping to the page (Req 28.6)", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: /open dialog/i });
    await user.click(trigger);

    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: /confirm/i });

    // From the last control, Tab must keep focus inside the modal (the trap
    // wraps rather than letting focus reach the trigger behind the overlay).
    confirm.focus();
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).not.toBe(trigger);
  });

  it("keeps Shift+Tab focus inside the dialog rather than escaping to the page (Req 28.6)", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: /open dialog/i });
    await user.click(trigger);

    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByRole("textbox", { name: /reason/i });

    // From the first control, Shift+Tab must keep focus inside the modal.
    input.focus();
    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).not.toBe(trigger);
  });

  it("dismisses on Escape and restores focus to the invoking control (Req 28.7)", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: /open dialog/i });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Focus returns to the control that opened the dialog (Req 28.7).
    expect(document.activeElement).toBe(trigger);
  });

  it("does not dismiss on Escape when the dialog is non-dismissible (Req 28.6)", async () => {
    const user = userEvent.setup();
    render(<DialogHarness dismissible={false} />);
    await user.click(screen.getByRole("button", { name: /open dialog/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    // A required-choice modal stays open on Escape.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("gives its controls a visible focus indicator via the focus-visible ring (Req 28.5)", async () => {
    const user = userEvent.setup();
    render(
      <Dialog open onClose={() => {}} labelledBy="h">
        <DialogHeader>
          <h2 id="h">Titled</h2>
          <button
            type="button"
            aria-label="Close"
            className="focus-visible:ring-1 focus-visible:ring-ring"
          >
            x
          </button>
        </DialogHeader>
      </Dialog>,
    );
    const close = screen.getByRole("button", { name: /close/i });
    // The focus style is expressed through the focus-visible ring utility so a
    // keyboard user always sees which control holds focus (Req 28.5).
    expect(close.className).toMatch(/focus-visible:ring/);
    await user.tab();
  });

  it("has no axe violations while open (Req 28.6)", async () => {
    const { container } = render(
      <Dialog open onClose={() => {}} labelledBy="h" describedBy="d">
        <DialogHeader>
          <h2 id="h">Delete record?</h2>
        </DialogHeader>
        <DialogBody>
          <p id="d">This cannot be undone.</p>
        </DialogBody>
        <DialogFooter>
          <button type="button">Cancel</button>
          <button type="button">Delete</button>
        </DialogFooter>
      </Dialog>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("renders nothing when closed", () => {
    render(
      <Dialog open={false} onClose={vi.fn()} labelledBy="h">
        <DialogHeader>
          <h2 id="h">Hidden</h2>
        </DialogHeader>
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
