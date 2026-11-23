/**
 * BACKLOG-4263 PR-6 — Settings › Keepr Cloud: "save this computer's deals again", waiting changes, Online only,
 * the Removed list (restore here, Delete for good, removed online, Rejected), the turn-off and new-computer lines.
 * The renderer service is mocked at its module boundary; main's answers are the shapes of
 * electron/types/ipc/window-api-cloud-sync.ts and window-api-cloud-todos.ts.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { KeeprCloudSettings } from "../KeeprCloudSettings";
import { KEEPR_CLOUD_COPY as C } from "../keeprCloudCopy";
import { useKeeprCloudSettings, type UseKeeprCloudSettings } from "../useKeeprCloudSettings";
import type { CloudSyncView } from "../../../../../electron/types/ipc/window-api-cloud-sync";

jest.mock("@/services/cloudSyncService", () => ({
  __esModule: true,
  default: {
    listRemovedDeals: jest.fn(),
    listRemovedOnline: jest.fn(),
    restoreDeal: jest.fn(),
    deleteDealForGood: jest.fn(),
    restoreOnlineDeal: jest.fn(),
    getView: jest.fn(),
    retry: jest.fn(),
  },
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const svc = require("@/services/cloudSyncService").default as Record<string, jest.Mock>;

const ON: CloudSyncView = {
  engineInstalled: true,
  status: "on",
  pausedReason: null,
  noticeVersion: 1,
  pendingDeals: 0,
  notSavedDeals: 0,
  onlineNotHereDeals: 0,
  otherInstalls: null,
  lastSavedAt: null,
  aiAppsAvailable: true,
};

function fakeCloud(view: CloudSyncView | null, message: UseKeeprCloudSettings["message"] = null): UseKeeprCloudSettings {
  return {
    view,
    viewRead: true,
    busy: false,
    message,
    refresh: jest.fn(),
    turnOn: jest.fn().mockResolvedValue(true),
    confirmComputer: jest.fn().mockResolvedValue(true),
    turnOff: jest.fn().mockResolvedValue(true),
    forgetOtherProject: jest.fn().mockResolvedValue(true),
    retry: jest.fn().mockResolvedValue(true),
    openAiApps: jest.fn().mockResolvedValue(true),
    deleteOnlineNotHere: jest.fn().mockResolvedValue(true),
    deleteOldInstalls: jest.fn().mockResolvedValue(true),
    reclaimInstall: jest.fn().mockResolvedValue(true),
  };
}

const HERE = { transactionId: "deal-1", propertyAddress: "12 Oak Street", removedAt: "2026-11-12T10:00:00.000Z", restorableUntil: "2026-12-12T10:00:00.000Z", deleting: false };

beforeEach(() => {
  jest.clearAllMocks();
  svc.listRemovedDeals.mockResolvedValue([]);
  svc.listRemovedOnline.mockResolvedValue({ success: true, deals: [] });
});

async function renderOn(view: CloudSyncView = ON, cloud = fakeCloud(view)) {
  const r = render(<KeeprCloudSettings cloud={cloud} />);
  await waitFor(() => expect(svc.listRemovedDeals).toHaveBeenCalled());
  return { ...r, cloud };
}

describe("Settings › Keepr Cloud — a view read that fails after an action (fix 7)", () => {
  function RealSection() {
    const cloud = useKeeprCloudSettings();
    return <KeeprCloudSettings cloud={cloud} listed />;
  }

  it("Try again, then the re-read gets no view: no Loading line, the section shows nothing", async () => {
    svc.getView.mockResolvedValueOnce({ ...ON, status: "error" }).mockResolvedValue(null);
    svc.retry.mockResolvedValue({ success: true });
    render(<RealSection />);
    const retry = await screen.findByRole("button", { name: C.tryAgain });
    await act(async () => {
      fireEvent.click(retry);
    });
    await waitFor(() => expect(svc.getView).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    expect(svc.retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("cloud-loading")).toBeNull();
    expect(document.getElementById("settings-cloud")).toBeNull();
  });
});

describe("Settings › Keepr Cloud — PR-6", () => {
  it("never turned on: no Removed list, no reclaim line, no waiting lines, and the removed lists are never asked for", async () => {
    render(<KeeprCloudSettings cloud={fakeCloud({ ...ON, status: "off", installRemoved: true, parked: { locked: 2, other: 1 } })} />);
    await act(async () => undefined);
    expect(screen.queryByTestId("cloud-removed")).toBeNull();
    expect(screen.queryByTestId("cloud-install-removed")).toBeNull();
    expect(screen.queryByText(C.reclaim)).toBeNull();
    expect(svc.listRemovedDeals).not.toHaveBeenCalled();
    expect(svc.listRemovedOnline).not.toHaveBeenCalled();
  });

  it("this computer's copy removed elsewhere: the explanation and a solid Save again button, then the done line", async () => {
    const { cloud, rerender } = await renderOn({ ...ON, installRemoved: true });
    const row = screen.getByTestId("cloud-install-removed");
    expect(row).toHaveTextContent(C.installRemoved);
    const button = within(row).getByRole("button", { name: C.reclaim });
    expect(button.className).toContain("bg-sky-700");
    fireEvent.click(button);
    expect(cloud.reclaimInstall).toHaveBeenCalledTimes(1);
    rerender(<KeeprCloudSettings cloud={fakeCloud(ON, "reclaim_done")} />);
    expect(C.reclaimDone).toBe("Saving this computer's deals again. If Keepr closes first, it finishes the next time Keepr opens.");
    expect(screen.getByTestId("cloud-message")).toHaveTextContent(C.reclaimDone);
  });

  it("waiting changes: locked and other counts each get their line; none when zero", async () => {
    const { rerender } = await renderOn({ ...ON, parked: { locked: 2, other: 1 } });
    expect(screen.getByTestId("cloud-parked-locked")).toHaveTextContent(C.parkedLocked(2));
    expect(screen.getByTestId("cloud-parked-other")).toHaveTextContent(
      "1 todo change from other devices or AI apps could not be applied on this computer. Keepr tries again on its own.",
    );
    rerender(<KeeprCloudSettings cloud={fakeCloud(ON)} />);
    expect(screen.queryByTestId("cloud-parked-locked")).toBeNull();
  });

  it("Online only: its own line, with no Delete button", async () => {
    await renderOn({ ...ON, restoredOnlineOnly: 2, onlineNotHereDeals: 1 });
    expect(screen.getByTestId("cloud-online-only")).toHaveTextContent(
      "Online only: 2 deals you restored. AI apps can read them; they are not on this computer.",
    );
    expect(within(screen.getByTestId("cloud-online-only")).queryByRole("button")).toBeNull();
  });

  it("a new or re-linked computer: says the online version of a todo is kept", async () => {
    render(<KeeprCloudSettings cloud={fakeCloud({ ...ON, status: "needs_confirmation" })} />);
    await act(async () => undefined);
    expect(screen.getByTestId("cloud-confirm")).toHaveTextContent(`${C.thisComputer} ${C.thisComputerTodos}`);
  });

  describe("Removed: deals deleted here", () => {
    it("lists the deal with its date, a solid Restore and a solid red Delete for good, the count and the two-fact footnote", async () => {
      svc.listRemovedDeals.mockResolvedValue([HERE]);
      await renderOn();
      const row = await screen.findByTestId("cloud-removed-deal-1");
      expect(screen.getByTestId("cloud-removed")).toHaveTextContent(C.removedTitle);
      expect(screen.getByTestId("cloud-removed")).not.toHaveTextContent("Removed online in the last 30 days:");
      expect(row).toHaveTextContent("12 Oak Street · deleted");
      expect(within(row).getByRole("button", { name: C.restore }).className).toContain("bg-sky-700");
      expect(within(row).getByRole("button", { name: C.deleteForGood }).className).toContain("bg-red-600");
      expect(screen.getByText(C.removedFootnote)).toBeInTheDocument();
    });

    it.each([
      [{ success: true }, C.restored],
      [{ success: true, skippedLinks: 3 }, "Restored. 3 links to emails or texts that no longer exist could not come back."],
      [{ success: true, otherDealAtAddress: true }, "Restored. There is another deal at this address."],
      [{ success: false, error: "not_found" }, "Already restored."],
      [{ success: false, error: "not_owner" }, "This deal can't be restored from this account."],
      [{ success: false, error: "purge_owed" }, "This deal is being deleted for good."],
      [{ success: false, error: "deal_exists" }, "This deal is already back on this computer."],
      [{ success: false, error: "cloud_off" }, "Turn on Keepr Cloud to restore deals."],
      [{ success: false, error: "restore_failed" }, "This deal could not be restored on this computer. Try again."],
      [{ success: false, error: "signed_out" }, "Sign in to restore this deal."],
      [{ success: false, error: "archive_not_understood" }, "Update Keepr to restore this deal."],
      [{ success: false, error: "something_new" }, C.actionFailed],
    ])("Restore answer %j shows its line, also when the deal leaves the list (as main does on success)", async (answer, text) => {
      svc.listRemovedDeals.mockResolvedValueOnce([HERE]).mockResolvedValue(answer.success ? [] : [HERE]);
      svc.restoreDeal.mockResolvedValue(answer);
      await renderOn();
      fireEvent.click(within(await screen.findByTestId("cloud-removed-deal-1")).getByRole("button", { name: C.restore }));
      await waitFor(() => expect(svc.restoreDeal).toHaveBeenCalledWith("deal-1"));
      expect(await screen.findByTestId("cloud-removed-message")).toHaveTextContent(text);
      if (answer.success) expect(screen.queryByTestId("cloud-removed-deal-1")).toBeNull();
    });

    it("a deal being deleted: Deleting… alone while online; no Restore and no second Delete for good", async () => {
      svc.listRemovedDeals.mockResolvedValue([{ ...HERE, deleting: true }]);
      await renderOn();
      const row = await screen.findByTestId("cloud-removed-deal-1");
      expect(screen.getByTestId("cloud-removed-deleting-deal-1").textContent).toBe("Deleting…");
      expect(within(row).queryByRole("button")).toBeNull();
    });

    it("a deal being deleted while offline: Deleting… Will finish deleting when Keepr is online.", async () => {
      svc.listRemovedDeals.mockResolvedValue([{ ...HERE, deleting: true }]);
      await renderOn({ ...ON, status: "paused", pausedReason: "offline" });
      await screen.findByTestId("cloud-removed-deal-1");
      expect(screen.getByTestId("cloud-removed-deleting-deal-1").textContent).toBe("Deleting… Will finish deleting when Keepr is online.");
    });

    it.each([
      [{ success: true, status: "done" }, "Deleted for good."],
      [{ success: true, status: "pending" }, "Will finish deleting when Keepr is online."],
      [{ success: true, status: "restored_elsewhere" }, "This deal was restored elsewhere; it was not deleted."],
      [{ success: false, error: "not_found" }, "This deal is no longer in this list."],
    ])("Delete for good asks first, says what it does and does not reach, then %j", async (answer, text) => {
      svc.listRemovedDeals.mockResolvedValueOnce([HERE]).mockResolvedValue(answer.success && (answer as { status?: string }).status === "done" ? [] : [HERE]);
      svc.deleteDealForGood.mockResolvedValue(answer);
      await renderOn();
      fireEvent.click(within(await screen.findByTestId("cloud-removed-deal-1")).getByRole("button", { name: C.deleteForGood }));
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent(C.deleteForGoodTitle);
      expect(dialog).toHaveTextContent(
        "It is erased now from Keepr Cloud and from this computer, with its todos and their history. This cannot be undone. A copy saved online before this computer was set up again is not erased.",
      );
      expect(svc.deleteDealForGood).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("button", { name: C.deleteForGood }));
      await waitFor(() => expect(svc.deleteDealForGood).toHaveBeenCalledWith("deal-1"));
      expect(await screen.findByTestId("cloud-removed-message")).toHaveTextContent(text);
    });
  });

  describe("Removed: deals removed online", () => {
    it("an online-only deal has a solid Restore; a rejected one says what to do and has no button", async () => {
      svc.listRemovedOnline.mockResolvedValue({
        success: true,
        deals: [
          { cloudId: "c-1", propertyAddress: "9 Elsewhere Road", removedAt: "2026-11-10T00:00:00Z", restorableUntil: null, kind: "online" },
          { cloudId: "c-2", propertyAddress: "3 Rejected Lane", removedAt: "2026-11-10T00:00:00Z", restorableUntil: null, kind: "rejected" },
        ],
      });
      svc.restoreOnlineDeal.mockResolvedValue({ success: true });
      await renderOn();
      const row = await screen.findByTestId("cloud-removed-online-c-1");
      expect(row).toHaveTextContent("9 Elsewhere Road · removed online");
      expect(screen.getByTestId("cloud-removed-rejected-c-2")).toHaveTextContent(
        "3 Rejected Lane is marked Rejected on this computer. Choose Restore to Active on the deal to save it online again.",
      );
      expect(within(screen.getByTestId("cloud-removed-rejected-c-2")).queryByRole("button")).toBeNull();
      fireEvent.click(within(row).getByRole("button", { name: C.restore }));
      await waitFor(() => expect(svc.restoreOnlineDeal).toHaveBeenCalledWith("c-1"));
    });

    it("an online Restore refused with a code this screen does not know shows the safe line, never the code", async () => {
      svc.listRemovedOnline.mockResolvedValue({
        success: true,
        deals: [{ cloudId: "c-1", propertyAddress: "9 Elsewhere Road", removedAt: null, restorableUntil: null, kind: "online" }],
      });
      svc.restoreOnlineDeal.mockResolvedValue({ success: false, error: "something_new" });
      await renderOn();
      fireEvent.click(within(await screen.findByTestId("cloud-removed-online-c-1")).getByRole("button", { name: C.restore }));
      const line = await screen.findByTestId("cloud-removed-message");
      expect(line).toHaveTextContent(C.actionFailed);
      expect(line).not.toHaveTextContent("something_new");
    });

    it("offline (paused): the deals deleted here still show; the online list says it needs Keepr online and is not asked for", async () => {
      svc.listRemovedDeals.mockResolvedValue([HERE]);
      await renderOn({ ...ON, status: "paused", pausedReason: "offline" });
      expect(await screen.findByTestId("cloud-removed-deal-1")).toBeInTheDocument();
      expect(screen.getByTestId("cloud-removed-online-unavailable")).toHaveTextContent(C.removedOnlineUnavailable);
      expect(svc.listRemovedOnline).not.toHaveBeenCalled();
    });
  });

  describe("turn-off", () => {
    it("adds the lost-changes line; the removed-todos line always, last; the archive line only when deals deleted here could still be restored", async () => {
      const { unmount } = await renderOn();
      fireEvent.click(screen.getByRole("switch"));
      let dialog = await screen.findByRole("alertdialog");
      expect(C.turnOffTodos).toBe("Todos removed in the last 30 days can no longer be restored.");
      expect(dialog.textContent).toContain(`${C.turnOffConfirm} ${C.turnOffLost} ${C.turnOffTodos}`);
      expect(dialog.textContent).toMatch(/restored\.Cancel/);
      expect(dialog.textContent?.split(C.turnOffTodos).length).toBe(2);
      expect(dialog).not.toHaveTextContent(C.turnOffArchive);
      unmount();
      svc.listRemovedDeals.mockResolvedValue([HERE]);
      await renderOn();
      await screen.findByTestId("cloud-removed-deal-1");
      fireEvent.click(screen.getByRole("switch"));
      dialog = await screen.findByRole("alertdialog");
      expect(dialog.textContent).toContain(`${C.turnOffConfirm} ${C.turnOffLost} ${C.turnOffArchive} ${C.turnOffTodos}`);
      expect(dialog.textContent).toMatch(/restored\.Cancel/);
      expect(dialog.textContent?.split(C.turnOffTodos).length).toBe(2);
    });

    it("opened from the Turn off and delete online copy button while not on: the removed-todos line shows, once, last", async () => {
      const view: CloudSyncView = { ...ON, status: "needs_confirmation" };
      render(<KeeprCloudSettings cloud={fakeCloud(view)} />);
      fireEvent.click(screen.getByRole("button", { name: C.turnOff }));
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog.textContent).toContain(`${C.turnOffConfirm} ${C.turnOffLost} ${C.turnOffTodos}`);
      expect(dialog.textContent).toMatch(/restored\.Cancel/);
      expect(dialog.textContent?.split(C.turnOffTodos).length).toBe(2);
    });
  });
});
