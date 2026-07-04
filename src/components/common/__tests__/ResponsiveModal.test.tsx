/**
 * Tests for ResponsiveModal drag-strip clearance (BACKLOG-1790)
 *
 * Below the sm breakpoint the modal panel is full-screen (fixed inset-0),
 * which geometrically overlaps the global WindowDragStrip (top 36px) and the
 * macOS traffic lights. ResponsiveModal reserves that band with a spacer so
 * modal headers/back buttons never sit under the drag rect — this replaces
 * the old index.html media query that disabled dragging app-wide below 640px.
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

  it("renders a top spacer in Electron so headers clear the global drag strip", () => {
    render(
      <ResponsiveModal testId="modal">
        <div>content</div>
      </ResponsiveModal>
    );

    const spacer = screen.getByTestId("modal-drag-strip-spacer");
    expect(spacer).toBeInTheDocument();
    // Matches the WindowDragStrip height (h-9 = 36px); hidden at sm+ where
    // the panel is a centered card and never touches the window top edge.
    expect(spacer).toHaveClass("h-9", "flex-shrink-0", "sm:hidden");
    expect(spacer).toHaveAttribute("aria-hidden", "true");
  });

  it("places the spacer before the modal content (header sits below the strip)", () => {
    render(
      <ResponsiveModal testId="modal">
        <button data-testid="back-button">Back</button>
      </ResponsiveModal>
    );

    const spacer = screen.getByTestId("modal-drag-strip-spacer");
    const backButton = screen.getByTestId("back-button");
    expect(
      spacer.compareDocumentPosition(backButton) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
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

  it("does not render the spacer outside Electron", () => {
    (window as unknown as { api: unknown }).api = undefined;
    render(
      <ResponsiveModal testId="modal">
        <div>content</div>
      </ResponsiveModal>
    );
    expect(
      screen.queryByTestId("modal-drag-strip-spacer")
    ).not.toBeInTheDocument();
  });
});
