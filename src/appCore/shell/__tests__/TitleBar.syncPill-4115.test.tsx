/**
 * BACKLOG-4115 PR-3: the title-bar device sync pill as rendered.
 * - every shipped state: label text, `title` (tooltip), indicator data-tone
 * - SR B5: the title bar's in-flow children stay [w-8 spacer, h1, w-8 initials
 *   box]; only the pill's wrapper is absolute
 * - no-drag-region; data-tour on the iPhone pill only (N6); click
 */
import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TitleBar } from "../TitleBar";
import { TitleBarSyncPill } from "../TitleBarSyncPill";
import { deriveAndroidPill, deriveCompanionPill, deriveIPhonePill, type SyncPillState } from "../syncPillState";
import { orchestratorStepFor } from "../../../hooks/googleMessagesSyncStatus";
import { NOW, IPHONE_STATES, EXT_BASE, ext, job, LISTENING, UNAVAILABLE } from "./syncPillFixtures";
import type { AppStep, AppUser } from "../../state/types";

const user: AppUser = { id: "u1", email: "avery@example.com", display_name: "Avery Example" };

const iphonePills: Array<[string, SyncPillState]> = Object.entries(IPHONE_STATES).map(([n, f]) => [
  `iphone:${n}`,
  deriveIPhonePill(f.sync, f.enabled, NOW),
]);
const androidPills: Array<[string, SyncPillState]> = [
  ["android:importing", deriveAndroidPill(EXT_BASE, LISTENING, orchestratorStepFor(job({})), "linked", NOW)],
  ["android:failed", deriveAndroidPill(EXT_BASE, LISTENING, orchestratorStepFor(job({ state: "failed" })), "linked", NOW)],
  ["android:cantListen", deriveAndroidPill(EXT_BASE, UNAVAILABLE, null, "linked", NOW)],
  ["android:update", deriveAndroidPill(ext({ extensionUpdateReady: true }), LISTENING, null, "linked", NOW)],
  ["android:notInstalled", deriveAndroidPill(ext({ extensionVersion: null }), LISTENING, null, "notLinked", NOW)],
  ["android:ready", deriveAndroidPill(EXT_BASE, LISTENING, null, "linked", NOW)],
  ["android:companion", deriveCompanionPill()],
];

const renderPill = (pill: SyncPillState, onClick = jest.fn()) => {
  render(<TitleBarSyncPill pill={pill} onClick={onClick} />);
  return { el: screen.getByTestId("title-bar-sync-pill"), onClick };
};

describe("TitleBarSyncPill renders each state", () => {
  it.each([...iphonePills, ...androidPills])("%s: label, title, indicator tone", (_n, pill) => {
    const { el } = renderPill(pill);
    expect(el).toHaveTextContent(pill.label);
    expect(el).toHaveAttribute("title", pill.tooltip);
    expect(within(el).getByTestId("title-bar-sync-pill-indicator")).toHaveAttribute("data-tone", pill.tone);
  });

  it("dot tones map to the status colours (8 px), the arc spins (14 px)", () => {
    const tones: Record<string, string> = { success: "bg-success-600", warning: "bg-warning-600", danger: "bg-danger-600", neutral: "bg-warm-dot" };
    for (const [, pill] of [...iphonePills, ...androidPills]) {
      const { unmount } = render(<TitleBarSyncPill pill={pill} onClick={jest.fn()} />);
      const ind = screen.getByTestId("title-bar-sync-pill-indicator");
      if (pill.tone === "arc") {
        expect(ind).toHaveClass("h-3.5", "w-3.5");
        expect(ind.querySelector("svg")).toHaveClass("animate-spin");
      } else {
        expect(ind).toHaveClass("h-2", "w-2", "rounded-full", tones[pill.tone]);
      }
      unmount();
    }
  });

  it("28 px pill on the warm tokens, no-drag-region, clickable while syncing", () => {
    const syncing = deriveIPhonePill(IPHONE_STATES.syncing.sync, true, NOW);
    const { el, onClick } = renderPill(syncing);
    expect(el).toHaveClass("no-drag-region", "h-7", "rounded-full", "border-warm-line", "bg-white", "text-ink-muted", "text-xs", "font-medium");
    expect(el).toBeEnabled();
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("data-tour sync-phone-card on the iPhone pill only (N6)", () => {
    const a = render(<TitleBarSyncPill pill={iphonePills[0][1]} onClick={jest.fn()} />);
    expect(a.getByTestId("title-bar-sync-pill")).toHaveAttribute("data-tour", "sync-phone-card");
    a.unmount();
    for (const [, pill] of androidPills) {
      const b = render(<TitleBarSyncPill pill={pill} onClick={jest.fn()} />);
      expect(b.getByTestId("title-bar-sync-pill")).not.toHaveAttribute("data-tour");
      b.unmount();
    }
  });
});

const renderBar = (sync?: React.ComponentProps<typeof TitleBar>["sync"], over: Partial<React.ComponentProps<typeof TitleBar>> = {}) =>
  render(
    <TitleBar
      runningInElectron
      currentStep={"dashboard" as AppStep}
      isAuthenticated
      currentUser={user}
      title="Dashboard"
      onOpenAccount={jest.fn()}
      sync={sync}
      {...over}
    />,
  );

describe("TitleBar with the pill (SR B5)", () => {
  const pill = deriveIPhonePill(IPHONE_STATES.connectedIdle.sync, true, NOW);

  it("in-flow children stay exactly [w-8 spacer, h1, w-8 initials box]; the pill wrapper is absolute", () => {
    renderBar({ pill, onClick: jest.fn() });
    const bar = screen.getByTestId("title-bar");
    expect(bar).toHaveClass("relative", "justify-between");
    const inFlow = Array.from(bar.children).filter((c) => !c.classList.contains("absolute"));
    expect(inFlow).toHaveLength(3);
    expect(inFlow[0]).toHaveClass("w-8");
    expect(inFlow[0]).toBeEmptyDOMElement();
    expect(inFlow[1].tagName).toBe("H1");
    expect(inFlow[2]).toBe(screen.getByTestId("title-bar-right"));
    expect(inFlow[2]).toHaveClass("w-8");
    expect(inFlow[2].children).toHaveLength(1);
    expect(inFlow[2]).toContainElement(screen.getByTestId("nav-profile"));
    const slot = screen.getByTestId("title-bar-sync-slot");
    expect(slot.parentElement).toBe(bar);
    expect(slot).toHaveClass("absolute", "right-14", "top-1/2", "-translate-y-1/2");
    expect(slot).toContainElement(screen.getByTestId("title-bar-sync-pill"));
  });

  it("the title gets a max width only while the pill shows", () => {
    renderBar({ pill, onClick: jest.fn() });
    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("max-w-[40%]", "truncate");
  });

  it("no pill: no slot, the bar is exactly as before", () => {
    renderBar({ pill: null, onClick: jest.fn() });
    expect(screen.queryByTestId("title-bar-sync-slot")).toBeNull();
    expect(screen.getByTestId("title-bar").children).toHaveLength(3);
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveClass("max-w-[40%]");
  });

  it("signed out: no pill even when one is passed", () => {
    renderBar({ pill, onClick: jest.fn() }, { isAuthenticated: false });
    expect(screen.queryByTestId("title-bar-sync-pill")).toBeNull();
  });

  it("the web / mobile header never shows it", () => {
    renderBar({ pill, onClick: jest.fn() }, { runningInElectron: false });
    expect(screen.queryByTestId("title-bar-sync-pill")).toBeNull();
  });

  it("clicking the pill calls the sync click, not the account", () => {
    const onClick = jest.fn();
    const onOpenAccount = jest.fn();
    renderBar({ pill, onClick }, { onOpenAccount });
    fireEvent.click(screen.getByTestId("title-bar-sync-pill"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onOpenAccount).not.toHaveBeenCalled();
  });
});
