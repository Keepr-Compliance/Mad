/**
 * BACKLOG-3785 — the screen NAME sent with the sync heartbeat: step + open modal names.
 */
import { renderHook } from "@testing-library/react";
import { getCurrentScreenName, screenNameFor, useReportCurrentScreenName } from "../currentScreenName";

describe("BACKLOG-3785: current screen name", () => {
  it("joins the step with the names of open modals only, sorted", () => {
    expect(screenNameFor("dashboard", { showSettings: false, showTransactions: true, showIPhoneSync: true, other: true })).toBe(
      "dashboard+IPhoneSync+Transactions",
    );
    expect(screenNameFor("login")).toBe("login");
  });

  it("the hook publishes the name for the heartbeat to read", () => {
    const { rerender } = renderHook(({ step }) => useReportCurrentScreenName(step, { showContacts: true }), {
      initialProps: { step: "dashboard" },
    });
    expect(getCurrentScreenName()).toBe("dashboard+Contacts");
    rerender({ step: "settings" });
    expect(getCurrentScreenName()).toBe("settings+Contacts");
  });
});

describe("BACKLOG-3785: screen name reaches main", () => {
  it("reports each new name over the log bridge (names only)", () => {
    const reportScreen = jest.fn();
    (window as unknown as { api: unknown }).api = { log: { reportScreen } };
    const { rerender } = renderHook(({ step }) => useReportCurrentScreenName(step, { showSettings: true }), {
      initialProps: { step: "dashboard" },
    });
    rerender({ step: "dashboard" });
    rerender({ step: "login" });
    expect(reportScreen.mock.calls).toEqual([["dashboard+Settings"], ["login+Settings"]]);
    delete (window as unknown as { api?: unknown }).api;
  });
});
