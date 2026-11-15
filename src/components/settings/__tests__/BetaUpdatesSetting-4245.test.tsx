/**
 * BACKLOG-4245: Settings > General "Get beta versions".
 *
 * V1  hidden until the main process says visible; Store build has no switch
 * V3  checked = the STORED value; the note line per state
 * V4  a failed change shows a message and returns to what main reports
 * V6  Settings does not wait for the state call (the rest renders first)
 * V5  the renderer reads no feature key for this switch (text)
 */
import React from "react";
import * as fs from "fs";
import * as path from "path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

jest.mock("@/hooks/useNotification", () => ({ useNotification: () => ({ notify: jest.fn() }) }));
jest.mock("../../../contexts/NetworkContext", () => ({ useNetwork: () => ({ isOnline: true }) }));

import { GeneralSettings } from "../GeneralSettings";
import { settingsService } from "../../../services";
import type { BetaUpdatesState } from "../../../../electron/types/ipc/window-api-services";
import {
  BETA_UPDATES_NOT_AVAILABLE,
  BETA_UPDATES_SAVE_FAILED,
  BETA_UPDATES_TITLE,
  BETA_UPDATES_UNREACHABLE,
} from "../betaUpdatesCopy";

const hidden: BetaUpdatesState = { visible: false, stored: false, applied: false, eligibility: "unknown", note: null };

function setStoreFlag(value: boolean | undefined) {
  const system = (window.api as unknown as { system: Record<string, unknown> }).system;
  if (value === undefined) delete system.isStoreBuild;
  else system.isStoreBuild = value;
}

let getState: jest.SpyInstance;
let setBeta: jest.SpyInstance;

beforeEach(() => {
  getState = jest.spyOn(settingsService, "getBetaUpdatesState").mockResolvedValue(hidden);
  setBeta = jest.spyOn(settingsService, "setBetaUpdates").mockResolvedValue({ success: true });
});
afterEach(() => {
  jest.restoreAllMocks();
  setStoreFlag(undefined);
});

const switchEl = () => screen.queryByRole("switch", { name: BETA_UPDATES_TITLE });

describe("visibility", () => {
  it("V1 hidden when main says not visible", async () => {
    render(<GeneralSettings userId="u1" initialPreferences={{}} />);
    await waitFor(() => expect(getState).toHaveBeenCalled());
    expect(switchEl()).not.toBeInTheDocument();
  });

  it("V1 Store build: no switch, and the state is never asked", async () => {
    setStoreFlag(true);
    getState.mockResolvedValue({ ...hidden, visible: true });
    render(<GeneralSettings userId="u1" initialPreferences={{}} />);
    await act(async () => undefined);
    expect(switchEl()).not.toBeInTheDocument();
    expect(getState).not.toHaveBeenCalled();
  });

  it("V6 Settings renders while the state call is still pending", () => {
    getState.mockImplementation(() => new Promise(() => { /* never */ }));
    render(<GeneralSettings userId="u1" initialPreferences={{}} />);
    expect(screen.getByRole("switch", { name: "Auto-download updates" })).toBeInTheDocument();
    expect(switchEl()).not.toBeInTheDocument();
  });
});

describe("V3 the switch shows the stored value and a note", () => {
  it.each<[string, BetaUpdatesState, boolean, string | null]>([
    ["eligible, off", { visible: true, stored: false, applied: false, eligibility: "allowed", note: null }, false, null],
    ["on and active", { visible: true, stored: true, applied: true, eligibility: "allowed", note: null }, true, null],
    ["on, not eligible", { visible: true, stored: true, applied: false, eligibility: "blocked", note: "not_available" }, true, BETA_UPDATES_NOT_AVAILABLE],
    ["on, server unreachable", { visible: true, stored: true, applied: false, eligibility: "unknown", note: "unreachable" }, true, BETA_UPDATES_UNREACHABLE],
  ])("%s", async (_l, state, checked, note) => {
    getState.mockResolvedValue(state);
    render(<GeneralSettings userId="u1" initialPreferences={{}} />);
    const sw = await screen.findByRole("switch", { name: BETA_UPDATES_TITLE });
    expect(sw).toHaveAttribute("aria-checked", String(checked));
    if (note) expect(screen.getByTestId("settings-beta-updates-note")).toHaveTextContent(note);
    else expect(screen.queryByTestId("settings-beta-updates-note")).not.toBeInTheDocument();
  });

  it("a paused user can turn it off", async () => {
    getState
      .mockResolvedValueOnce({ visible: true, stored: true, applied: false, eligibility: "unknown", note: "unreachable" })
      .mockResolvedValueOnce({ visible: true, stored: false, applied: false, eligibility: "unknown", note: null });
    render(<GeneralSettings userId="u1" initialPreferences={{}} />);
    fireEvent.click(await screen.findByRole("switch", { name: BETA_UPDATES_TITLE }));
    await waitFor(() => expect(setBeta).toHaveBeenCalledWith("u1", false));
    await waitFor(() => expect(switchEl()).toHaveAttribute("aria-checked", "false"));
  });
});

describe("V4 failure", () => {
  it.each<[string, boolean]>([
    ["turning on", true],
    ["turning off", false],
  ])("%s fails: message shown, switch returns to main's state", async (_l, next) => {
    const before: BetaUpdatesState = { visible: true, stored: !next, applied: !next, eligibility: "allowed", note: null };
    getState.mockResolvedValue(before);
    setBeta.mockResolvedValue({ success: false, error: "offline" });
    render(<GeneralSettings userId="u1" initialPreferences={{}} />);
    fireEvent.click(await screen.findByRole("switch", { name: BETA_UPDATES_TITLE }));
    expect(await screen.findByRole("alert")).toHaveTextContent(BETA_UPDATES_SAVE_FAILED);
    await waitFor(() => expect(switchEl()).toHaveAttribute("aria-checked", String(!next)));
  });
});

describe("V5 no feature logic in the renderer", () => {
  it("beta_updates appears in src/ only in the strict-key record", () => {
    const root = path.resolve(__dirname, "../../../");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "__tests__" || e.name === "node_modules") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name) && fs.readFileSync(full, "utf8").includes("beta_updates")) hits.push(path.relative(root, full));
      }
    };
    walk(root);
    expect(hits).toEqual(["hooks/featureAccess.ts"]);
  });
});
