/**
 * Tests for SettingsTabBar.tsx
 *
 * BACKLOG-2160 / BACKLOG-1450: the Settings tab strip regressed after the
 * responsive-UI sprint — `justify-center` clipped the leftmost tabs ("General")
 * off the left edge and made them unreachable by horizontal scroll, and the
 * active tab was not reliably scrolled into view.
 *
 * These tests lock in:
 *  1. Left-alignment (no `justify-center`) so "General" is the first, visible tab.
 *  2. The active tab is indicated (aria-selected + underline) on the correct tab.
 *  3. The active tab is scrolled into view on mount AND when the active tab changes.
 *
 * Wrapped in React.StrictMode per repo convention (StrictMode is ON in prod),
 * which also proves the scrollIntoView effect is StrictMode-safe (idempotent).
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

// jsdom does not implement scrollIntoView — install a spy so we can assert on it.
let scrollIntoViewMock: jest.Mock;
beforeEach(() => {
  scrollIntoViewMock = jest.fn();
  HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;
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

  it("scrolls the active tab into view on mount (BACKLOG-2160)", () => {
    renderStrict(
      <SettingsTabBar tabs={TABS} activeTabId="settings-general" onTabClick={jest.fn()} />
    );

    expect(scrollIntoViewMock).toHaveBeenCalled();
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    });

    // The element that was scrolled is the ACTIVE tab, never a clipped neighbor.
    const active = screen.getByRole("tab", { selected: true });
    expect(scrollIntoViewMock.mock.instances).toContain(active);
  });

  it("scrolls the newly-active tab into view when the active tab changes (BACKLOG-1450)", () => {
    const { rerender } = renderStrict(
      <SettingsTabBar tabs={TABS} activeTabId="settings-general" onTabClick={jest.fn()} />
    );

    scrollIntoViewMock.mockClear();

    // Simulate scroll-spy advancing the active tab as the user scrolls the content.
    rerender(
      <React.StrictMode>
        <SettingsTabBar tabs={TABS} activeTabId="settings-security" onTabClick={jest.fn()} />
      </React.StrictMode>
    );

    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    });
    const active = screen.getByRole("tab", { selected: true });
    expect(active).toHaveTextContent("Security");
    expect(scrollIntoViewMock.mock.instances).toContain(active);
  });
});
