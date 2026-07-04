/**
 * Tests for ResponsiveModal drag-strip clearance (BACKLOG-1790)
 *
 * Below the sm breakpoint the modal panel is full-screen (fixed inset-0),
 * which geometrically overlaps the global WindowDragStrip (top 36px) and the
 * macOS traffic lights. ResponsiveModal reserves that band by injecting
 * `max-sm:[&>*:first-child]:pt-9` onto the panel div so the first child
 * (the gradient header) gains 36px of top padding — making its background
 * fill the drag-strip band seamlessly. No dedicated spacer div is rendered,
 * so there is no bare white bar above the header.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ResponsiveModal } from "../ResponsiveModal";

describe("ResponsiveModal drag-strip clearance (BACKLOG-1790)", () => {
  // tests/setup.js stubs window.api, so isElectron() is true by default
  const originalApi = (window as unknown as { api: unknown }).api;

  afterEach(() => {
    (window as unknown as { api: unknown }).api = originalApi;
  });

  it("applies drag-strip clearance via CSS on the panel in Electron at narrow width", () => {
    render(
      <ResponsiveModal testId="modal">
        <div>content</div>
      </ResponsiveModal>
    );

    const panel = screen.getByTestId("modal").firstElementChild!;
    // Clearance is injected via CSS, not a dedicated spacer div.
    // max-sm:[&>*:first-child]:pt-9 overrides the first child's top padding to
    // 36px (= WindowDragStrip h-9) at <640px so header content clears the strip.
    // At sm+ the consumer's own sm:pt-* takes effect normally.
    expect(panel.className).toContain("max-sm:[&>*:first-child]:pt-9");
    // No standalone spacer in the DOM — the white-bar regression is gone.
    expect(screen.queryByTestId("modal-drag-strip-spacer")).not.toBeInTheDocument();
  });

  it("first panel child is the modal content with no interposed spacer element", () => {
    render(
      <ResponsiveModal testId="modal">
        <button data-testid="back-button">Back</button>
      </ResponsiveModal>
    );

    const panel = screen.getByTestId("modal").firstElementChild!;
    // Clearance is pure CSS; the button is the very first DOM child of the panel.
    // No spacer div is injected between the panel edge and the modal content.
    expect(panel.firstElementChild).toBe(screen.getByTestId("back-button"));
  });

  it("keeps interactive children clickable (no drag region swallows them)", () => {
    const onBack = jest.fn();
    render(
      <ResponsiveModal testId="modal">
        <button data-testid="back-button" onClick={onBack}>
          Back
        </button>
      </ResponsiveModal>
    );

    fireEvent.click(screen.getByTestId("back-button"));
    expect(onBack).toHaveBeenCalledTimes(1);
    // The modal itself must not declare any drag region of its own — the
    // global WindowDragStrip is the only drag surface.
    expect(
      screen.getByTestId("modal").querySelector(".drag-region")
    ).toBeNull();
  });

  it("does not apply drag-strip clearance outside Electron", () => {
    (window as unknown as { api: unknown }).api = undefined;
    render(
      <ResponsiveModal testId="modal">
        <div>content</div>
      </ResponsiveModal>
    );

    const panel = screen.getByTestId("modal").firstElementChild!;
    expect(panel.className).not.toContain("max-sm:[&>*:first-child]:pt-9");
  });
});
