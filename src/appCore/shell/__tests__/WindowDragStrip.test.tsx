/**
 * Tests for WindowDragStrip (BACKLOG-1790)
 *
 * The single global window-drag surface. The window previously became
 * undraggable below 640px because index.html converted every .drag-region
 * to no-drag via a media query while the window runs with
 * titleBarStyle: "hiddenInset" (no native title bar).
 *
 * These tests assert:
 * 1. The drag strip renders at a narrow (375px) viewport in Electron.
 * 2. The strip never intercepts clicks (pointer-events-none).
 * 3. Nothing renders outside Electron (web/mobile browsers).
 * 4. Regression guard: index.html no longer contains a breakpoint-scoped
 *    drag kill switch, and defines exactly one .drag-region rule.
 */
import React from "react";
import fs from "fs";
import path from "path";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { WindowDragStrip } from "../WindowDragStrip";

// Simulate a viewport width (jsdom does not evaluate CSS media queries, but
// this documents that the strip is rendered regardless of viewport width —
// the fix is precisely that no breakpoint can remove it).
function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: width,
  });
  window.dispatchEvent(new Event("resize"));
}

describe("WindowDragStrip", () => {
  // tests/setup.js stubs window.api, so isElectron() is true by default
  const originalApi = (window as unknown as { api: unknown }).api;

  afterEach(() => {
    (window as unknown as { api: unknown }).api = originalApi;
  });

  it("renders the global drag strip at a narrow (375px) viewport", () => {
    setViewportWidth(375);
    render(<WindowDragStrip />);

    const strip = screen.getByTestId("window-drag-strip");
    expect(strip).toBeInTheDocument();
    expect(strip).toHaveClass("drag-region");
    // Fixed full-width strip pinned to the top of the window
    expect(strip).toHaveClass("fixed", "top-0", "left-0", "right-0");
  });

  it("renders the same strip at a wide viewport (exists at every breakpoint)", () => {
    setViewportWidth(1200);
    render(<WindowDragStrip />);
    expect(screen.getByTestId("window-drag-strip")).toHaveClass("drag-region");
  });

  it("never intercepts clicks: strip is pointer-events-none and aria-hidden", () => {
    setViewportWidth(375);
    render(<WindowDragStrip />);

    const strip = screen.getByTestId("window-drag-strip");
    // Dragging is computed geometrically by Electron from -webkit-app-region;
    // pointer-events-none guarantees the strip never swallows DOM clicks.
    expect(strip).toHaveClass("pointer-events-none");
    expect(strip).toHaveAttribute("aria-hidden", "true");
  });

  it("renders nothing outside Electron (web/mobile browsers)", () => {
    (window as unknown as { api: unknown }).api = undefined;
    setViewportWidth(375);
    const { container } = render(<WindowDragStrip />);
    expect(container).toBeEmptyDOMElement();
  });

  describe("index.html regression guard", () => {
    const indexHtml = fs.readFileSync(
      path.resolve(__dirname, "../../../../index.html"),
      "utf8"
    );

    it("does not reintroduce a breakpoint-scoped drag kill switch", () => {
      // The old bug: @media (max-width: 639px) { .drag-region { ... no-drag } }
      // which removed ALL draggable pixels below 640px on every screen.
      const mediaBlocks = indexHtml.match(/@media[^{]*\{[\s\S]*?\}\s*\}/g) ?? [];
      for (const block of mediaBlocks) {
        expect(block).not.toContain("drag-region");
        expect(block).not.toContain("app-region");
      }
    });

    it("defines .drag-region as drag unconditionally", () => {
      const dragRules =
        indexHtml.match(/\.drag-region\s*\{[^}]*\}/g)?.filter(
          (r) => !r.startsWith(".no-drag-region")
        ) ?? [];
      expect(dragRules).toHaveLength(1);
      expect(dragRules[0]).toContain("-webkit-app-region: drag");
      expect(dragRules[0]).not.toContain("no-drag");
    });
  });
});
