/**
 * Tests for SettingsTabBar.tsx
 *
 * BACKLOG-2160 / BACKLOG-1450: the Settings tab strip regressed after the
 * responsive-UI sprint — `justify-center` clipped the leftmost tabs ("General")
 * off the left edge and made them unreachable by horizontal scroll, and the
 * active tab was not reliably scrolled into view.
 *
 * BACKLOG-2322: the original fix for the above used
 * `activeRef.current.scrollIntoView({ block: "nearest", inline: "nearest" })`,
 * which scrolls EVERY scrollable ancestor, not just the horizontal tab strip.
 * Because the strip is `sticky top-0` inside the Settings modal's vertical
 * `overflow-y-auto` container — the same container `useScrollSpy` watches to
 * derive `activeTabId` — scrolling down flipped `activeTabId`, which fired
 * `scrollIntoView` on the newly-active tab, which scrolled the VERTICAL
 * container back to the top, trapping the user. The fix confines the
 * auto-scroll to the strip's own `scrollLeft`, computed from bounding rects,
 * so it can never touch a vertical ancestor.
 *
 * These tests lock in:
 *  1. Left-alignment (no `justify-center`) so "General" is the first, visible tab.
 *  2. The active tab is indicated (aria-selected + underline) on the correct tab.
 *  3. `scrollIntoView` is never called, and only the strip's `scrollLeft` (never
 *     any vertical `scrollTop`) is adjusted when the active tab changes.
 *
 * Wrapped in React.StrictMode per repo convention (StrictMode is ON in prod),
 * which also proves the auto-scroll effect is StrictMode-safe (idempotent).
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SettingsTabBar } from "../SettingsTabBar";

// Mirrors the real Settings tab list order (General first). More tabs than would
// fit on a narrow strip, so the overflow/scroll behavior is what matters here.
const TABS = [
  { id: "settings-general", label: "General" },
  { id: "settings-email", label: "Email" },
  { id: "settings-messages", label: "Messages" },
  { id: "settings-iphone-sync", label: "iPhone Sync" },
  { id: "settings-contacts", label: "Contacts" },
  { id: "settings-ai", label: "AI" },
  { id: "settings-security", label: "Security" },
  { id: "settings-data", label: "Data & Privacy" },
  { id: "settings-troubleshooting", label: "Troubleshooting" },
  { id: "settings-about", label: "About" },
];

const renderStrict = (ui: React.ReactElement) =>
  render(<React.StrictMode>{ui}</React.StrictMode>);

// jsdom does not implement scrollIntoView — install a spy so we can assert it
// is NEVER called (BACKLOG-2322: this is the root cause of the scroll trap).
let scrollIntoViewMock: jest.Mock;

// jsdom's layout engine always reports zero-size rects, so we stub
// `getBoundingClientRect` per-element (keyed by data-testid) to simulate the
// active tab being scrolled out of the strip's visible horizontal range.
const rect = (partial: Partial<DOMRect>): DOMRect => ({
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  width: 0,
  height: 0,
  x: 0,
  y: 0,
  toJSON: () => {},
  ...partial,
});

beforeEach(() => {
  scrollIntoViewMock = jest.fn();
  HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;

  jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element
  ) {
    const testId = this.getAttribute("data-testid");
    if (testId === "settings-tab-strip") {
      return rect({ left: 0, right: 400, width: 400 });
    }
    if (testId === "settings-tab-security") {
      // Scrolled off the right edge of the strip (right > strip.right).
      return rect({ left: 450, right: 550, width: 100 });
    }
    // Everything else (e.g. "General") is already fully within the strip's
    // visible range — the no-op case.
    return rect({ left: 0, right: 80, width: 80 });
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("SettingsTabBar", () => {
  it("renders every tab with General first and not centered (BACKLOG-2160/1450)", () => {
    renderStrict(
      <SettingsTabBar tabs={TABS} activeTabId="settings-general" onTabClick={jest.fn()} />
    );

    // All tabs are rendered, including the leftmost "General".
    for (const tab of TABS) {
      expect(screen.getByRole("tab", { name: tab.label })).toBeInTheDocument();
    }

    // General is the FIRST tab in DOM order (left edge, not pushed off-screen).
    const renderedTabs = screen.getAllByRole("tab");
    expect(renderedTabs[0]).toHaveTextContent("General");

    // Regression guard: the strip must be left-aligned, never centered — centering
    // is what clipped/hid the leftmost tabs on open.
    const tablist = screen.getByTestId("settings-tabs");
    expect(tablist.className).not.toMatch(/justify-center/);
  });

  it("indicates the active tab with aria-selected and the underline style", () => {
    renderStrict(
      <SettingsTabBar tabs={TABS} activeTabId="settings-general" onTabClick={jest.fn()} />
    );

    const active = screen.getByRole("tab", { selected: true });
    expect(active).toHaveTextContent("General");
    // Active underline/highlight style.
    expect(active.className).toMatch(/border-blue-600/);
    expect(active.className).toMatch(/text-blue-600/);

    // Non-active tabs are not selected.
    expect(screen.getByRole("tab", { name: "Email" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
  });

  it("does not call scrollIntoView on mount (BACKLOG-2160, BACKLOG-2322)", () => {
    renderStrict(
      <SettingsTabBar tabs={TABS} activeTabId="settings-general" onTabClick={jest.fn()} />
    );

    // General is already within the strip's visible range on open — no-op,
    // and scrollIntoView must never be used (it would scroll the vertical
    // Settings container too — see BACKLOG-2322).
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it("adjusts only the strip's scrollLeft (never scrollIntoView) when the active tab changes (BACKLOG-1450, BACKLOG-2322)", () => {
    const { rerender } = renderStrict(
      <SettingsTabBar tabs={TABS} activeTabId="settings-general" onTabClick={jest.fn()} />
    );

    const strip = screen.getByTestId("settings-tab-strip");
    let scrollLeft = 0;
    Object.defineProperty(strip, "scrollLeft", {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
    });

    // Guarantee: this component has no reference to the vertical Settings
    // scroll container, so it is structurally incapable of writing its
    // scrollTop. Assert no element's scrollTop setter fires at all.
    const scrollTopSetterSpy = jest.spyOn(Element.prototype, "scrollTop", "set");

    // Simulate scroll-spy advancing the active tab as the user scrolls the
    // content — the tab is now scrolled off the right edge of the strip
    // (per the getBoundingClientRect stub for "settings-tab-security").
    rerender(
      <React.StrictMode>
        <SettingsTabBar tabs={TABS} activeTabId="settings-security" onTabClick={jest.fn()} />
      </React.StrictMode>
    );

    const active = screen.getByRole("tab", { selected: true });
    expect(active).toHaveTextContent("Security");

    // scrollIntoView is never used — this is the whole point of the fix.
    expect(scrollIntoViewMock).not.toHaveBeenCalled();

    // Only the strip's horizontal scrollLeft moved, by exactly the overflow
    // amount (activeRect.right 550 - stripRect.right 400 = 150).
    expect(scrollLeft).toBe(150);

    // No vertical scrollTop was ever touched.
    expect(scrollTopSetterSpy).not.toHaveBeenCalled();
  });

  it("is a no-op when the active tab is already fully visible in the strip", () => {
    const { rerender } = renderStrict(
      <SettingsTabBar tabs={TABS} activeTabId="settings-security" onTabClick={jest.fn()} />
    );

    const strip = screen.getByTestId("settings-tab-strip");
    let scrollLeft = 42;
    Object.defineProperty(strip, "scrollLeft", {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
    });

    // Switch back to "General", which the stub reports as fully within the
    // strip's visible range — scrollLeft must be left untouched.
    rerender(
      <React.StrictMode>
        <SettingsTabBar tabs={TABS} activeTabId="settings-general" onTabClick={jest.fn()} />
      </React.StrictMode>
    );

    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    expect(scrollLeft).toBe(42);
  });
});
