/**
 * BACKLOG-3951 PR-B2 — the removed-member notice (plan v2 control C8, notice half).
 *
 * Real MembershipNotice, real useMembershipNoticeDismissal, real
 * settingsService and real AlertBanner. Only `useLicense` (the PR-B1 standing)
 * and the `window.api.preferences` bridge are replaced. The bridge is a small
 * per-user store whose answers follow the shapes of electron/handlers/
 * preferenceHandlers.ts: get → { success: true, preferences } or
 * { success: false, error }; update deep-merges and answers { success: true, preferences }.
 *
 * BACKLOG-4171: the dismissal is keyed by the brokerage's organization id (the
 * `organization_id` the standing payload now carries), not its name.
 */
import React from "react";
import fs from "fs";
import path from "path";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { MembershipNotice } from "../MembershipNotice";

type Standing = "licensed" | "unlicensed" | "left_brokerage" | "unknown" | "none" | undefined;
let mockLicense: { membershipStanding?: Standing; membershipOrgName?: string; membershipOrgId?: string } =
  {};
jest.mock("../../../contexts/LicenseContext", () => ({
  useLicense: () => mockLicense,
}));

const USER_A = "test-user-a";
const USER_B = "test-user-b";
const BROKERAGE = "Fixture Brokerage";
const OTHER_BROKERAGE = "Other Fixture Brokerage";
const ORG_ID = "fixture-org-a";
const OTHER_ORG_ID = "fixture-org-b";
const FOUNDER_TEXT =
  "You're no longer part of Fixture Brokerage. You can keep using Keepr on your own and unlock transactions with a monthly subscription or credits.";

/** Per-user preference store standing in for the main process. */
let store: Record<string, Record<string, unknown>>;
const prefs = () =>
  (window as unknown as {
    api: { preferences: { get: jest.Mock; update: jest.Mock } };
  }).api.preferences;

function installStore() {
  store = {};
  prefs().get.mockImplementation(async (uid: string) => ({
    success: true,
    preferences: store[uid] ?? {},
  }));
  prefs().update.mockImplementation(async (uid: string, partial: Record<string, unknown>) => {
    const existing = store[uid] ?? {};
    const merged: Record<string, unknown> = { ...existing };
    for (const [k, v] of Object.entries(partial)) {
      merged[k] =
        v && typeof v === "object" && existing[k] && typeof existing[k] === "object"
          ? { ...(existing[k] as object), ...(v as object) }
          : v;
    }
    store[uid] = merged;
    return { success: true, preferences: merged };
  });
}

async function renderNotice(userId: string | undefined = USER_A) {
  let utils: ReturnType<typeof render> | undefined;
  await act(async () => {
    utils = render(<MembershipNotice userId={userId} />);
  });
  return utils!;
}

beforeEach(() => {
  jest.clearAllMocks();
  installStore();
  mockLicense = { membershipStanding: "left_brokerage", membershipOrgName: BROKERAGE, membershipOrgId: ORG_ID };
});

describe("BACKLOG-3951 MembershipNotice", () => {
  it("removed member: shows the founder's text verbatim with the brokerage name", async () => {
    await renderNotice();
    const notice = screen.getByTestId("membership-notice");
    expect(screen.getByText("You're no longer part of Fixture Brokerage.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "You can keep using Keepr on your own and unlock transactions with a monthly subscription or credits.",
      ),
    ).toBeInTheDocument();
    const title = notice.querySelector("h3")?.textContent;
    const body = notice.querySelector("p")?.textContent;
    expect(`${title} ${body}`).toBe(FOUNDER_TEXT);
    // No action button: only the dismiss control.
    expect(notice.querySelectorAll("button")).toHaveLength(1);
    expect(screen.getByTitle("Dismiss")).toBeInTheDocument();
  });

  it("interpolates whichever brokerage name the standing carries", async () => {
    mockLicense = {
      membershipStanding: "left_brokerage",
      membershipOrgName: OTHER_BROKERAGE,
      membershipOrgId: OTHER_ORG_ID,
    };
    await renderNotice();
    expect(screen.getByText("You're no longer part of Other Fixture Brokerage.")).toBeInTheDocument();
  });

  it.each([
    ["unlicensed (unassigned, still a member)", "unlicensed"],
    ["licensed (active member)", "licensed"],
    ["none (solo)", "none"],
    ["unknown (pending or unrecognised status)", "unknown"],
    ["undefined (loading, read failed, signed out)", undefined],
  ] as const)("%s: renders nothing", async (_label, standing) => {
    mockLicense = { membershipStanding: standing, membershipOrgName: BROKERAGE, membershipOrgId: ORG_ID };
    await renderNotice();
    expect(screen.queryByTestId("membership-notice")).toBeNull();
  });

  it("removed but no brokerage name: renders nothing", async () => {
    mockLicense = { membershipStanding: "left_brokerage", membershipOrgName: undefined, membershipOrgId: ORG_ID };
    await renderNotice();
    expect(screen.queryByTestId("membership-notice")).toBeNull();
  });

  it("removed but no organization id: renders nothing (nothing to key a dismissal by)", async () => {
    mockLicense = { membershipStanding: "left_brokerage", membershipOrgName: BROKERAGE, membershipOrgId: undefined };
    await renderNotice();
    expect(prefs().get).not.toHaveBeenCalled();
    expect(screen.queryByTestId("membership-notice")).toBeNull();
  });

  it("no user id: renders nothing", async () => {
    await act(async () => {
      render(<MembershipNotice />);
    });
    expect(prefs().get).not.toHaveBeenCalled();
    expect(screen.queryByTestId("membership-notice")).toBeNull();
  });

  it("dismissal read still pending: renders nothing", async () => {
    prefs().get.mockImplementation(() => new Promise(() => {}));
    await renderNotice();
    expect(screen.queryByTestId("membership-notice")).toBeNull();
  });

  it("dismissal read failed: renders nothing (unknown is not known)", async () => {
    prefs().get.mockResolvedValue({ success: false, error: "offline" });
    await renderNotice();
    expect(screen.queryByTestId("membership-notice")).toBeNull();
  });

  it("dismissal read throws: renders nothing", async () => {
    prefs().get.mockRejectedValue(new Error("ipc down"));
    await renderNotice();
    expect(screen.queryByTestId("membership-notice")).toBeNull();
  });

  it("dismiss hides it and saves the brokerage's organization id for this user", async () => {
    await renderNotice();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Dismiss"));
    });
    expect(screen.queryByTestId("membership-notice")).toBeNull();
    expect(prefs().update).toHaveBeenCalledTimes(1);
    expect(prefs().update).toHaveBeenCalledWith(USER_A, {
      notices: { membershipNoticeDismissedFor: ORG_ID },
    });
  });

  it("dismissed stays dismissed after a restart (new mount reads the saved preference)", async () => {
    const first = await renderNotice();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Dismiss"));
    });
    first.unmount();
    await renderNotice();
    expect(prefs().get).toHaveBeenLastCalledWith(USER_A);
    expect(screen.queryByTestId("membership-notice")).toBeNull();
  });

  it("a removal from a different brokerage shows it again", async () => {
    store[USER_A] = { notices: { membershipNoticeDismissedFor: ORG_ID } };
    mockLicense = {
      membershipStanding: "left_brokerage",
      membershipOrgName: OTHER_BROKERAGE,
      membershipOrgId: OTHER_ORG_ID,
    };
    await renderNotice();
    expect(screen.getByTestId("membership-notice")).toBeInTheDocument();
  });

  // BACKLOG-4171 controls.
  it("two brokerages with the same name keep separate dismissals", async () => {
    const first = await renderNotice();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Dismiss"));
    });
    expect(screen.queryByTestId("membership-notice")).toBeNull();
    first.unmount();
    // Removed from a second brokerage that happens to share the name.
    mockLicense = { membershipStanding: "left_brokerage", membershipOrgName: BROKERAGE, membershipOrgId: OTHER_ORG_ID };
    await renderNotice();
    expect(screen.getByText("You're no longer part of Fixture Brokerage.")).toBeInTheDocument();
  });

  it("two unnamed brokerages (same fallback name) keep separate dismissals", async () => {
    mockLicense = { membershipStanding: "left_brokerage", membershipOrgName: "your brokerage", membershipOrgId: ORG_ID };
    const first = await renderNotice();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Dismiss"));
    });
    first.unmount();
    mockLicense = {
      membershipStanding: "left_brokerage",
      membershipOrgName: "your brokerage",
      membershipOrgId: OTHER_ORG_ID,
    };
    await renderNotice();
    expect(screen.getByTestId("membership-notice")).toBeInTheDocument();
  });

  it("a renamed brokerage keeps the dismissal", async () => {
    const first = await renderNotice();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Dismiss"));
    });
    first.unmount();
    mockLicense = { membershipStanding: "left_brokerage", membershipOrgName: "Renamed Fixture Brokerage", membershipOrgId: ORG_ID };
    await renderNotice();
    expect(prefs().get).toHaveBeenLastCalledWith(USER_A);
    expect(screen.queryByTestId("membership-notice")).toBeNull();
  });

  it("a dismissal saved before 4171 (a brokerage name) shows the notice once more; the next dismiss stores the id", async () => {
    store[USER_A] = { notices: { membershipNoticeDismissedFor: BROKERAGE } };
    await renderNotice();
    expect(screen.getByTestId("membership-notice")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Dismiss"));
    });
    expect(screen.queryByTestId("membership-notice")).toBeNull();
    expect(store[USER_A]).toEqual({ notices: { membershipNoticeDismissedFor: ORG_ID } });
  });

  it("one user's dismissal does not hide it for another user", async () => {
    const first = await renderNotice(USER_A);
    await act(async () => {
      fireEvent.click(screen.getByTitle("Dismiss"));
    });
    expect(screen.queryByTestId("membership-notice")).toBeNull();
    first.unmount();
    await renderNotice(USER_B);
    expect(prefs().get).toHaveBeenLastCalledWith(USER_B);
    expect(screen.getByTestId("membership-notice")).toBeInTheDocument();
    expect(store[USER_B]).toBeUndefined();
  });

  it("switching user in place: the previous user's answer is not used while the new read is pending", async () => {
    const { rerender } = await renderNotice(USER_A);
    expect(screen.getByTestId("membership-notice")).toBeInTheDocument();
    prefs().get.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      rerender(<MembershipNotice userId={USER_B} />);
    });
    expect(screen.queryByTestId("membership-notice")).toBeNull();
  });

  it("the component and its hook never call window.api directly", () => {
    const files = [
      path.join(__dirname, "..", "MembershipNotice.tsx"),
      path.join(__dirname, "..", "..", "..", "hooks", "useMembershipNoticeDismissal.ts"),
    ];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      expect(source.length).toBeGreaterThan(200);
      expect(source).not.toMatch(/window\.api/);
    }
    // Positive control: the pattern does match a file that does use the bridge.
    const service = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "services", "settingsService.ts"),
      "utf8",
    );
    expect(service).toMatch(/window\.api/);
  });
});
