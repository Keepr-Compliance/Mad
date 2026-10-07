/**
 * BACKLOG-3674 — "Don't show this again" on the dashboard tour.
 *
 * Real Dashboard, real useTour, real Joyride and the real TourTooltip. Only the
 * bridge (window.api.user.getTourState / dismissTour) and the dashboard's
 * unrelated children are replaced. The tour steps are two centred steps so the
 * tour runs in jsdom.
 *
 * Joyride's callback sequences are not hand-written: they come from driving the
 * real component (react-joyride 2.9.3) in this file's setup, recorded by a
 * scratch run on 2026-10-07:
 *   Skip      step:after|skipped|skip   then tour:end|skipped|skip
 *   Done      step:after|finished|next  then tour:end|finished|next
 *   Esc       step:after|running|close  (no tour:end)
 *   overlay   step:after|running|close  (no tour:end)
 * So a finish or skip calls back twice for one tour end (SR C-1).
 *
 * "This computer" is localStorage; "another computer" is a fresh localStorage
 * with the same server record.
 */

import React from "react";
import { render, act, fireEvent, screen } from "@testing-library/react";
import Dashboard from "../Dashboard";
import AuthContext from "../../contexts/AuthContext";
import confetti from "canvas-confetti";

jest.mock("canvas-confetti", () => jest.fn());
jest.mock("../../hooks/usePendingTransactionCount", () => ({
  usePendingTransactionCount: () => ({ pendingCount: 0 }),
}));
jest.mock("../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ isRunning: false }),
}));
jest.mock("../../hooks/useReconnectionSummary", () => ({
  useReconnectionSummary: () => {},
}));
jest.mock("../dashboard/index", () => ({ SyncStatusIndicator: () => null }));
jest.mock("../StartNewAuditModal", () => ({ __esModule: true, default: () => null }));
jest.mock("../common/FeatureGate", () => ({
  FeatureGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("../common/AlertBanner", () => ({
  AlertBanner: () => null,
  AlertIcons: { email: null, warning: null },
}));
jest.mock("../common/TransactionLimitModal", () => ({ TransactionLimitModal: () => null }));
jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({ canCreateTransaction: true, transactionCount: 0, transactionLimit: 100 }),
}));
jest.mock("../../hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({ isAllowed: () => true }),
}));
// Number of tour steps; the 3-step block below raises it (name must start with "mock").
let mockStepCount = 2;
jest.mock("../../config/tourSteps", () => ({
  getDashboardTourSteps: () =>
    ["one", "two", "three"].slice(0, mockStepCount).map((n) => ({
      target: "body",
      content: `Step ${n}`,
      placement: "center",
      disableBeacon: true,
    })),
  JOYRIDE_STYLES: {},
  JOYRIDE_LOCALE: { last: "Done" },
}));

const KEY = "hasSeenDashboardTour";
type TourState = "dismissed" | "not-dismissed" | "unknown";

const userApi = () =>
  (window.api as unknown as {
    user: { getTourState?: jest.Mock; dismissTour?: jest.Mock };
  }).user;

function setServer(tour: TourState) {
  userApi().getTourState = jest.fn().mockResolvedValue({ success: tour !== "unknown", tour });
}

function tree(needsTermsAcceptance = false) {
  const auth = { needsTermsAcceptance } as unknown as React.ContextType<typeof AuthContext>;
  return (
    <AuthContext.Provider value={auth}>
      <Dashboard onAuditNew={jest.fn()} onViewTransactions={jest.fn()} onManageContacts={jest.fn()} />
    </AuthContext.Provider>
  );
}

async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(250);
    });
  }
}

const tooltip = () => document.querySelector(".react-joyride__tooltip");
const checkbox = () => screen.queryByLabelText("Don't show this again") as HTMLInputElement | null;
const button = (action: string) => document.querySelector(`[data-action="${action}"]`) as HTMLElement;

/** Mount on "a computer", wait for the tour, return the unmount. */
async function mountWithTour() {
  const view = render(tree());
  await settle();
  expect(tooltip()).not.toBeNull();
  return view;
}

/** "Another computer": fresh localStorage, same server record. */
async function otherComputer(serverAfter: TourState) {
  localStorage.clear();
  setServer(serverAfter);
  const view = render(tree());
  await settle();
  return view;
}

describe("BACKLOG-3674 — Don't show this again", () => {
  let dismissTour: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    localStorage.clear();
    (confetti as unknown as jest.Mock).mockClear();
    setServer("not-dismissed");
    dismissTour = jest.fn().mockResolvedValue({ success: true });
    userApi().dismissTour = dismissTour;
  });
  afterEach(() => {
    jest.useRealTimers();
    mockStepCount = 2;
  });

  describe("T1 / C-6 — ticked, then closed: written once, not shown on another computer", () => {
    const closers: Array<[string, () => void]> = [
      ["Skip", () => fireEvent.click(button("skip"))],
      ["Esc", () => fireEvent.keyDown(document.body, { code: "Escape", key: "Escape" })],
      ["overlay click", () => fireEvent.click(document.querySelector(".react-joyride__overlay")!)],
    ];
    it.each(closers)("ticked + %s", async (_name, close) => {
      const view = await mountWithTour();
      fireEvent.click(checkbox()!);
      expect(checkbox()!.checked).toBe(true);
      close();
      await settle();

      expect(tooltip()).toBeNull();
      expect(dismissTour).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(KEY)).toBe("true");
      view.unmount();

      // PC B: the server now says dismissed -> no tour.
      const b = await otherComputer("dismissed");
      expect(tooltip()).toBeNull();
      b.unmount();
    });
  });

  describe("T2 — unticked close keeps today's behaviour", () => {
    const closers: Array<[string, () => void]> = [
      ["Skip", () => fireEvent.click(button("skip"))],
      ["Esc", () => fireEvent.keyDown(document.body, { code: "Escape", key: "Escape" })],
    ];
    it.each(closers)("unticked + %s: server not written, this computer hides it", async (_name, close) => {
      const view = await mountWithTour();
      close();
      await settle();

      expect(tooltip()).toBeNull();
      expect(dismissTour).not.toHaveBeenCalled();
      expect(localStorage.getItem(KEY)).toBe("true");
      view.unmount();

      // Same computer: no tour, and no server read at all.
      userApi().getTourState!.mockClear();
      const again = render(tree());
      await settle();
      expect(tooltip()).toBeNull();
      expect(userApi().getTourState).not.toHaveBeenCalled();
      again.unmount();

      // Another computer, server still not dismissed: the tour shows once there.
      const b = await otherComputer("not-dismissed");
      expect(tooltip()).not.toBeNull();
      b.unmount();
    });
  });

  it("T3 — finished (box never ticked): written once, confetti once, not shown on another computer", async () => {
    const view = await mountWithTour();
    fireEvent.click(button("primary"));
    await settle();
    // Last step: Done dismisses, so the box is not offered there.
    expect(checkbox()).toBeNull();
    fireEvent.click(button("primary"));
    await settle();

    expect(tooltip()).toBeNull();
    expect(dismissTour).toHaveBeenCalledTimes(1);
    expect(confetti).toHaveBeenCalledTimes(1);
    view.unmount();

    const b = await otherComputer("dismissed");
    expect(tooltip()).toBeNull();
    b.unmount();
  });

  describe("T8 — the box belongs to the whole tour, not to one step (3-step tour)", () => {
    const closers: Array<[string, () => void]> = [
      ["Skip", () => fireEvent.click(button("skip"))],
      ["Esc", () => fireEvent.keyDown(document.body, { code: "Escape", key: "Escape" })],
    ];
    it.each(closers)("ticked on step 1, still ticked on step 2, %s from step 2: one write", async (_name, close) => {
      mockStepCount = 3;
      const view = await mountWithTour();
      expect(document.querySelector('[role="alertdialog"]')?.getAttribute("aria-label")).toBe("Step one");
      fireEvent.click(checkbox()!);
      expect(checkbox()!.checked).toBe(true);

      fireEvent.click(button("primary"));
      await settle();
      expect(document.querySelector('[role="alertdialog"]')?.getAttribute("aria-label")).toBe("Step two");
      expect(checkbox()).not.toBeNull();
      expect(checkbox()!.checked).toBe(true);
      expect(dismissTour).not.toHaveBeenCalled();

      close();
      await settle();

      expect(tooltip()).toBeNull();
      expect(dismissTour).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(KEY)).toBe("true");
      view.unmount();
    });
  });

  it("T4 — the server answer is never copied into this computer's key", async () => {
    setServer("dismissed");
    const run1 = render(tree());
    await settle();
    expect(tooltip()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    run1.unmount();

    // Same computer, the server record was cleared (support reset): tour runs.
    setServer("not-dismissed");
    const run2 = render(tree());
    await settle();
    expect(tooltip()).not.toBeNull();
    run2.unmount();
  });

  describe("T7 — server cannot answer: no tour, nothing written", () => {
    const failures: Array<[string, () => void]> = [
      ["unknown", () => setServer("unknown")],
      ["rejects", () => {
        userApi().getTourState = jest.fn().mockRejectedValue(new Error("ipc down"));
      }],
      ["bridge absent", () => {
        userApi().getTourState = undefined;
      }],
    ];
    it.each(failures)("%s", async (_name, arrange) => {
      arrange();
      const view = render(tree());
      await settle();
      expect(tooltip()).toBeNull();
      expect(localStorage.getItem(KEY)).toBeNull();
      expect(dismissTour).not.toHaveBeenCalled();
      view.unmount();
    });
  });

  it("T5 — terms screen up: no server read and no tour", async () => {
    const view = render(tree(true));
    await settle();
    expect(userApi().getTourState).not.toHaveBeenCalled();
    expect(tooltip()).toBeNull();
    view.unmount();
  });

  it("W5 — the custom tooltip keeps Joyride's data-action attributes and labels", async () => {
    const view = await mountWithTour();
    expect(button("skip")).not.toBeNull();
    expect(button("skip").textContent).toBe("Skip");
    expect(button("primary").textContent).toMatch(/Next/);
    expect(document.querySelector('[role="alertdialog"]')?.getAttribute("aria-label")).toBe("Step one");
    view.unmount();
  });
});
