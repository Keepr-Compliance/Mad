/**
 * BACKLOG-4263 P2 — Settings › Keepr Cloud on a computer that is not the account's active one: the refusal line,
 * "Use this computer instead", the lost-computer line, the dropped turn-off line, and what the section does NOT
 * offer there (turn off, Delete them). The renderer service is mocked at its module boundary; main's answers are
 * the shapes of electron/types/ipc/window-api-cloud-sync.ts. Wording is a placeholder (keeprCloudCopy.ts).
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { KeeprCloudSettings } from "../KeeprCloudSettings";
import { KEEPR_CLOUD_COPY as C } from "../keeprCloudCopy";
import { useKeeprCloudSettings } from "../useKeeprCloudSettings";
import type { CloudSyncView } from "../../../../../electron/types/ipc/window-api-cloud-sync";

jest.mock("@/services/cloudSyncService", () => ({
  __esModule: true,
  default: {
    listRemovedDeals: jest.fn(),
    listRemovedOnline: jest.fn(),
    getView: jest.fn(),
    useThisComputer: jest.fn(),
  },
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const svc = require("@/services/cloudSyncService").default as Record<string, jest.Mock>;

const REFUSED: CloudSyncView = {
  engineInstalled: true,
  status: "other_computer",
  pausedReason: null,
  noticeVersion: 1,
  pendingDeals: 2,
  notSavedDeals: 0,
  onlineNotHereDeals: 0,
  otherInstalls: null,
  lastSavedAt: "2026-11-14T10:00:00.000Z",
  aiAppsAvailable: true,
};

function RealSection() {
  const cloud = useKeeprCloudSettings();
  return <KeeprCloudSettings cloud={cloud} />;
}

beforeEach(() => {
  jest.clearAllMocks();
  svc.listRemovedDeals.mockResolvedValue([]);
  svc.listRemovedOnline.mockResolvedValue({ success: true, deals: [] });
});

describe("Settings › Keepr Cloud — a computer that is not the account's active one", () => {
  it("shows the refusal line, the lost-computer line and a solid Use this computer instead button; no turn off, no Removed list", async () => {
    svc.getView.mockResolvedValue(REFUSED);
    render(<RealSection />);
    expect(await screen.findByTestId("cloud-status")).toHaveTextContent(C.otherComputer);
    const row = screen.getByTestId("cloud-other-computer");
    expect(row).toHaveTextContent(C.otherComputerHelp);
    const button = within(row).getByRole("button", { name: C.useThisComputer });
    expect(button.className).toContain("bg-sky-700");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("button", { name: C.turnOff })).toBeNull();
    expect(screen.queryByRole("button", { name: C.deleteThem })).toBeNull();
    expect(screen.queryByText(C.removedTitle)).toBeNull();
    expect(svc.listRemovedDeals).not.toHaveBeenCalled();
  });

  it("the confirm says the other computer's emails, texts and files are removed online and its deals stay and stop updating; confirming moves Keepr Cloud here", async () => {
    svc.getView.mockResolvedValueOnce(REFUSED).mockResolvedValue({ ...REFUSED, status: "on" });
    svc.useThisComputer.mockResolvedValue({ success: true });
    render(<RealSection />);
    fireEvent.click(await screen.findByRole("button", { name: C.useThisComputer }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(C.moveConfirmTitle);
    expect(dialog).toHaveTextContent(/emails, texts and files saved from your other computer are removed from Keepr Cloud/);
    expect(dialog).toHaveTextContent(/AI apps can no longer read them/);
    expect(dialog).toHaveTextContent(/hourly cleanup erases them/);
    expect(dialog).toHaveTextContent(/Deals saved from your other computer stay online and stop updating/);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: C.moveConfirmButton }));
    });
    expect(svc.useThisComputer).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(screen.queryByTestId("cloud-other-computer")).toBeNull());
    expect(screen.queryByTestId("cloud-message")).toBeNull();
  });

  it("a move made a minute ago answers busy: its own line, not the generic failure", async () => {
    svc.getView.mockResolvedValue(REFUSED);
    svc.useThisComputer.mockResolvedValue({ success: false, error: "busy" });
    render(<RealSection />);
    fireEvent.click(await screen.findByRole("button", { name: C.useThisComputer }));
    const dialog = await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: C.moveConfirmButton }));
    });
    expect(await screen.findByTestId("cloud-message")).toHaveTextContent(C.moveBusy);
  });

  it("turn on refused because another computer is active: no failure line; the refreshed view offers the move", async () => {
    svc.getView.mockResolvedValueOnce({ ...REFUSED, status: "off", otherComputerActive: true }).mockResolvedValue(REFUSED);
    const turnOn = jest.fn().mockResolvedValue({ success: false, error: "computer_not_active" });
    svc.turnOn = turnOn;
    render(<RealSection />);
    expect(await screen.findByTestId("cloud-other-computer-off")).toHaveTextContent(C.otherComputer);
    fireEvent.click(screen.getByRole("switch"));
    const dialog = await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: C.turnOn }));
    });
    expect(turnOn).toHaveBeenCalledWith(1);
    expect(await screen.findByTestId("cloud-other-computer")).toBeInTheDocument();
    expect(screen.queryByTestId("cloud-message")).toBeNull();
  });

  it("a turn-off dropped because another computer became active: its line", async () => {
    svc.getView.mockResolvedValue({ ...REFUSED, turnOffDropped: true });
    render(<RealSection />);
    expect(await screen.findByTestId("cloud-turn-off-dropped")).toHaveTextContent(C.turnOffDropped);
  });
});
