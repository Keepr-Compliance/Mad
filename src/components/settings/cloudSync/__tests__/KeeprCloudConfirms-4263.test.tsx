/**
 * BACKLOG-4263 — the five Settings › Keepr Cloud confirms (Turn on, Turn off, Delete these online deals in its two
 * branches, Forget, Delete for good) rendered through the REAL SettingsLayer. Only Settings itself is a stub: it
 * renders the real KeeprCloudSettings section with a fake `cloud`, so the Settings layer's Escape handler and its
 * nested-overlay lookup are the shipped ones.
 *
 * What these tests can see: where the confirm sits in the DOM, its role and name, which element has focus, what
 * Enter and Escape do, which handler a button calls, and whether a button is disabled. What they cannot see: whether
 * the confirm is VISIBLE. jsdom has no layout and no painting, so a dialog drawn underneath an opaque page passes
 * every assertion here.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { SettingsLayer } from "../../../../appCore/shell/SettingsLayer";
import type { AppStateMachine } from "../../../../appCore/state/types";
import { KeeprCloudSettings } from "../KeeprCloudSettings";
import { KEEPR_CLOUD_COPY as C } from "../keeprCloudCopy";
import type { UseKeeprCloudSettings } from "../useKeeprCloudSettings";
import type { CloudSyncView } from "../../../../../electron/types/ipc/window-api-cloud-sync";

jest.mock("@/services/cloudSyncService", () => ({
  __esModule: true,
  default: {
    listRemovedDeals: jest.fn(),
    listRemovedOnline: jest.fn(),
    restoreDeal: jest.fn(),
    deleteDealForGood: jest.fn(),
    restoreOnlineDeal: jest.fn(),
  },
}));
jest.mock("../../../../appCore/hooks/useEmailSettingsCallbacks", () => ({
  useEmailSettingsCallbacks: () => ({
    handleEmailConnectedFromSettings: jest.fn(),
    handleEmailDisconnectedFromSettings: jest.fn(),
  }),
}));

/** The section's `cloud`, read on every render of the stub page. */
const mockHolder: { cloud: UseKeeprCloudSettings | null } = { cloud: null };

/** Stub page: the real Keepr Cloud section, as Settings mounts it. */
jest.mock("../../../Settings", () => {
  const actual = jest.requireActual("../KeeprCloudSettings");
  function StubSettings() {
    return (
      <div data-testid="settings-page">
        {mockHolder.cloud && <actual.KeeprCloudSettings cloud={mockHolder.cloud} />}
      </div>
    );
  }
  return { __esModule: true, default: StubSettings };
});

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

const HERE = {
  transactionId: "deal-1",
  propertyAddress: "12 Oak Street",
  removedAt: "2026-11-12T10:00:00.000Z",
  restorableUntil: "2026-12-12T10:00:00.000Z",
  deleting: false,
};

function fakeCloud(view: CloudSyncView, busy = false): UseKeeprCloudSettings {
  return {
    view,
    busy,
    message: null,
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

function fakeApp(closeSettings: jest.Mock): AppStateMachine {
  return {
    modalState: { showSettings: true, showProfile: false, settingsTarget: null },
    currentUser: { id: "user-1", email: "avery@example.com", display_name: "Avery Example" },
    authProvider: "google",
    closeSettings,
    clearSettingsTarget: jest.fn(),
    openAndroidSync: jest.fn(),
    openIPhoneSync: jest.fn(),
    openLearnSession: jest.fn(),
    openLearnScore: jest.fn(),
    handleLogout: jest.fn(),
  } as unknown as AppStateMachine;
}

type Handler = keyof Pick<
  UseKeeprCloudSettings,
  "turnOn" | "turnOff" | "deleteOnlineNotHere" | "deleteOldInstalls" | "forgetOtherProject"
>;

interface Case {
  name: string;
  view: CloudSyncView;
  /** Opens the confirm the way a user does. */
  open: () => void;
  title: string;
  confirmLabel: string;
  /** The `cloud` handler the confirm calls, and its arguments. Delete for good calls the service instead. */
  handler: Handler | null;
  args: unknown[];
  removedHere?: boolean;
}

const CASES: Case[] = [
  {
    name: "Turn on",
    view: { ...ON, status: "off" },
    open: () => fireEvent.click(screen.getByRole("switch")),
    title: C.title,
    confirmLabel: C.turnOn,
    handler: "turnOn",
    args: [1],
  },
  {
    name: "Turn off",
    view: ON,
    open: () => {
      const toggle = screen.getByRole("switch");
      toggle.focus();
      fireEvent.click(toggle);
    },
    title: C.turnOffConfirmTitle,
    confirmLabel: C.turnOffConfirmButton,
    handler: "turnOff",
    args: [],
  },
  {
    name: "Delete these online deals (saved online, not here)",
    view: { ...ON, onlineNotHereDeals: 3 },
    open: () => fireEvent.click(within(screen.getByTestId("cloud-online-not-here")).getByRole("button", { name: C.deleteThem })),
    title: C.deleteOnlineConfirmTitle,
    confirmLabel: C.deleteButton,
    handler: "deleteOnlineNotHere",
    args: [],
  },
  {
    name: "Delete these online deals (other installs)",
    view: { ...ON, otherInstalls: { deals: 5, lastSavedAt: "2026-09-03T10:00:00.000Z" } },
    open: () => fireEvent.click(within(screen.getByTestId("cloud-other-installs")).getByRole("button", { name: C.deleteThem })),
    title: C.deleteOnlineConfirmTitle,
    confirmLabel: C.deleteButton,
    handler: "deleteOldInstalls",
    args: [],
  },
  {
    name: "Forget",
    view: { ...ON, status: "paused", pausedReason: "other_project" },
    open: () => fireEvent.click(screen.getByRole("button", { name: C.forget })),
    title: C.forget,
    confirmLabel: C.forgetButton,
    handler: "forgetOtherProject",
    args: [],
  },
  {
    name: "Delete for good",
    view: ON,
    open: () => fireEvent.click(within(screen.getByTestId("cloud-removed-deal-1")).getByRole("button", { name: C.deleteForGood })),
    title: C.deleteForGoodTitle,
    confirmLabel: C.deleteForGood,
    handler: null,
    args: ["deal-1"],
    removedHere: true,
  },
];

const ALL_HANDLERS: Handler[] = ["turnOn", "turnOff", "deleteOnlineNotHere", "deleteOldInstalls", "forgetOtherProject"];

async function renderCase(c: Case) {
  svc.listRemovedDeals.mockResolvedValue(c.removedHere ? [HERE] : []);
  const cloud = fakeCloud(c.view);
  mockHolder.cloud = cloud;
  const closeSettings = jest.fn();
  const app = fakeApp(closeSettings);
  const r = render(<SettingsLayer app={app} />);
  if (c.removedHere) await screen.findByTestId("cloud-removed-deal-1");
  await act(async () => undefined);
  c.open();
  const dialog = await screen.findByRole("alertdialog");
  return { ...r, cloud, closeSettings, app, dialog };
}

/** No handler of the section and no delete-for-good call. */
function expectNothingCalled(cloud: UseKeeprCloudSettings) {
  for (const h of ALL_HANDLERS) expect(cloud[h]).not.toHaveBeenCalled();
  expect(svc.deleteDealForGood).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  document.body.style.pointerEvents = "";
  svc.listRemovedDeals.mockResolvedValue([]);
  svc.listRemovedOnline.mockResolvedValue({ success: true, deals: [] });
  svc.deleteDealForGood.mockResolvedValue({ success: true, status: "done" });
});

describe.each(CASES)("Settings › Keepr Cloud confirm: $name", (c) => {
  it("C1: the open confirm is inside the Settings layer", async () => {
    const { dialog } = await renderCase(c);
    expect(screen.getByTestId("settings-layer")).toContainElement(dialog);
  });

  it("C3: the page underneath is not made to ignore the pointer", async () => {
    await renderCase(c);
    expect(document.body.style.pointerEvents).not.toBe("none");
  });

  it("A: it is a dialog named by its title", async () => {
    await renderCase(c);
    expect(screen.getByRole("alertdialog", { name: c.title })).toBeInTheDocument();
  });

  it("C2: confirm calls its handler once with the same arguments, and nothing else", async () => {
    const { cloud, dialog } = await renderCase(c);
    fireEvent.click(within(dialog).getByRole("button", { name: c.confirmLabel }));
    if (c.handler) {
      await waitFor(() => expect(cloud[c.handler as Handler]).toHaveBeenCalledTimes(1));
      expect(cloud[c.handler]).toHaveBeenCalledWith(...c.args);
      for (const h of ALL_HANDLERS) if (h !== c.handler) expect(cloud[h]).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(svc.deleteDealForGood).toHaveBeenCalledTimes(1));
      expect(svc.deleteDealForGood).toHaveBeenCalledWith(...c.args);
      for (const h of ALL_HANDLERS) expect(cloud[h]).not.toHaveBeenCalled();
    }
  });

  it("C2: Cancel calls nothing and closes the confirm", async () => {
    const { cloud, dialog } = await renderCase(c);
    fireEvent.click(within(dialog).getByRole("button", { name: C.cancel }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expectNothingCalled(cloud);
  });

  it("C2: while an action runs, both buttons are disabled", async () => {
    const { dialog, rerender, app } = await renderCase(c);
    if (c.handler) {
      mockHolder.cloud = { ...(mockHolder.cloud as UseKeeprCloudSettings), busy: true };
      rerender(<SettingsLayer app={{ ...app }} />);
    } else {
      svc.restoreDeal.mockReturnValue(new Promise(() => undefined));
      fireEvent.click(within(screen.getByTestId("cloud-removed-deal-1")).getByRole("button", { name: C.restore, hidden: true }));
    }
    await waitFor(() => expect(within(dialog).getByRole("button", { name: C.cancel })).toBeDisabled());
    expect(within(dialog).getByRole("button", { name: c.confirmLabel })).toBeDisabled();
  });

  it("A: Cancel has focus when the confirm opens", async () => {
    const { dialog } = await renderCase(c);
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: C.cancel })));
  });

  it("A: Enter on the opened confirm cancels it and calls nothing", async () => {
    const { cloud, dialog } = await renderCase(c);
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: C.cancel })));
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expectNothingCalled(cloud);
  });

  it("A / C8(c): Escape closes the confirm, calls nothing, and leaves Settings open", async () => {
    const { cloud, closeSettings } = await renderCase(c);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(closeSettings).not.toHaveBeenCalled();
    expect(screen.getByTestId("settings-layer")).toBeInTheDocument();
    expectNothingCalled(cloud);
  });

  it("A: Escape while an action runs does nothing", async () => {
    const { cloud, closeSettings, rerender, app } = await renderCase(c);
    if (c.handler) {
      mockHolder.cloud = { ...(mockHolder.cloud as UseKeeprCloudSettings), busy: true };
      rerender(<SettingsLayer app={{ ...app }} />);
    } else {
      svc.restoreDeal.mockReturnValue(new Promise(() => undefined));
      fireEvent.click(within(screen.getByTestId("cloud-removed-deal-1")).getByRole("button", { name: C.restore, hidden: true }));
    }
    await waitFor(() => expect(within(screen.getByRole("alertdialog")).getByRole("button", { name: C.cancel })).toBeDisabled());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await act(async () => undefined);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(closeSettings).not.toHaveBeenCalled();
    expectNothingCalled(cloud);
  });
});

describe("Settings › Keepr Cloud confirm: focus", () => {
  const turnOff = CASES.find((x) => x.name === "Turn off") as Case;

  it("Tab and Shift+Tab stay on the confirm's two buttons", async () => {
    const { dialog } = await renderCase(turnOff);
    const cancel = within(dialog).getByRole("button", { name: C.cancel });
    const confirm = within(dialog).getByRole("button", { name: turnOff.confirmLabel });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    await userEvent.tab();
    expect(document.activeElement).toBe(confirm);
    await userEvent.tab();
    expect(document.activeElement).toBe(cancel);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(confirm);
  });

  it("closing it puts focus back on the control that opened it", async () => {
    const { dialog } = await renderCase(turnOff);
    const cancel = within(dialog).getByRole("button", { name: C.cancel });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("switch")));
  });
});

describe("Settings › Keepr Cloud confirm outside the Settings layer", () => {
  it("Escape cancels the confirm when the section is rendered alone", async () => {
    const cloud = fakeCloud(ON);
    render(<KeeprCloudSettings cloud={cloud} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("switch"));
    await screen.findByRole("alertdialog");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(cloud.turnOff).not.toHaveBeenCalled();
  });
});
