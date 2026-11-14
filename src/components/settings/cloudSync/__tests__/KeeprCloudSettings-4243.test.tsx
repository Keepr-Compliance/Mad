/**
 * BACKLOG-4243 PR-1 — Settings › Keepr Cloud (C1.2 UI half, C1.6, C1.7, tab
 * gating) and the R10 gate that no code reads cloud_* tables directly.
 */
import React from "react";
import fs from "fs";
import path from "path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KeeprCloudSettings } from "../KeeprCloudSettings";
import { KEEPR_CLOUD_COPY as C, NOTICE_TEXTS } from "../keeprCloudCopy";
import type { UseKeeprCloudSettings } from "../useKeeprCloudSettings";
import { visibleSettingsTabs } from "../../settingsTabs";
import type { CloudSyncView } from "../../../../../electron/types/ipc/window-api-cloud-sync";

const VIEW: CloudSyncView = {
  engineInstalled: true,
  status: "off",
  pausedReason: null,
  noticeVersion: 1,
  pendingDeals: 0,
  lastSavedAt: null,
  aiAppsAvailable: true,
};

function fakeCloud(view: CloudSyncView | null): UseKeeprCloudSettings {
  return {
    view,
    busy: false,
    message: null,
    refresh: jest.fn(),
    turnOn: jest.fn().mockResolvedValue(true),
    confirmComputer: jest.fn().mockResolvedValue(true),
    turnOff: jest.fn().mockResolvedValue(true),
    forgetOtherProject: jest.fn().mockResolvedValue(true),
    retry: jest.fn().mockResolvedValue(true),
    openAiApps: jest.fn().mockResolvedValue(true),
  };
}

describe("KeeprCloudSettings", () => {
  it("renders nothing when hidden or unreachable", () => {
    const { container, rerender } = render(<KeeprCloudSettings cloud={fakeCloud({ ...VIEW, status: "hidden" })} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<KeeprCloudSettings cloud={fakeCloud(null)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("C1.7: no switch when the engine is not installed; positive: installed → switch", () => {
    const { rerender } = render(<KeeprCloudSettings cloud={fakeCloud({ ...VIEW, engineInstalled: false })} />);
    expect(screen.queryByRole("switch")).toBeNull();
    rerender(<KeeprCloudSettings cloud={fakeCloud(VIEW)} />);
    expect(screen.getByRole("switch", { name: C.switchLabel })).toBeInTheDocument();
  });

  it("C1.2: the switch shows the notice; Cancel sends nothing; Turn on sends the shown version", async () => {
    const cloud = fakeCloud(VIEW);
    render(<KeeprCloudSettings cloud={cloud} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(await screen.findByText(NOTICE_TEXTS[1])).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: C.cancel }));
    expect(cloud.turnOn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(await screen.findByRole("button", { name: C.turnOn }));
    await waitFor(() => expect(cloud.turnOn).toHaveBeenCalledWith(1));
  });

  it("the notice names the contact list (coordinator wording, v1)", () => {
    expect(NOTICE_TEXTS[1]).toContain("your contact list (names, companies, email addresses and phone numbers of the people you saved)");
  });

  it("on: the switch asks to turn off; confirming calls turnOff", async () => {
    const cloud = fakeCloud({ ...VIEW, status: "on" });
    render(<KeeprCloudSettings cloud={cloud} />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(await screen.findByRole("button", { name: C.turnOffConfirmButton }));
    await waitFor(() => expect(cloud.turnOff).toHaveBeenCalled());
  });

  it("update needed: the switch cannot turn on", () => {
    render(<KeeprCloudSettings cloud={fakeCloud({ ...VIEW, status: "update_needed", noticeVersion: null })} />);
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getByText(C.updateNeeded)).toBeInTheDocument();
  });

  it("needs confirmation: one solid button saves this computer's deals", () => {
    const cloud = fakeCloud({ ...VIEW, status: "needs_confirmation" });
    render(<KeeprCloudSettings cloud={cloud} />);
    fireEvent.click(screen.getByRole("button", { name: C.saveThisComputer }));
    expect(cloud.confirmComputer).toHaveBeenCalled();
  });

  it("AI apps row opens through the service", () => {
    const cloud = fakeCloud(VIEW);
    render(<KeeprCloudSettings cloud={cloud} />);
    fireEvent.click(screen.getByRole("button", { name: C.manageAiApps }));
    expect(cloud.openAiApps).toHaveBeenCalled();
  });

  it("the tab shows only when main reports the section visible", () => {
    expect(visibleSettingsTabs(false, false, false).some((t) => t.id === "settings-cloud")).toBe(false);
    expect(visibleSettingsTabs(false, false, true).some((t) => t.id === "settings-cloud")).toBe(true);
  });
});

// ---------------------------------------------------------------- source gates
const ROOT = path.join(__dirname, "..", "..", "..", "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "__tests__") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("source gates", () => {
  const WINDOW_API = /window\.api/;
  const DIRECT_CLOUD_TABLE = /from\(\s*['"`]cloud_/;

  it("C1.6: no window.api in the Keepr Cloud components; positive: the renderer service has it", () => {
    const files = walk(path.join(ROOT, "src", "components", "settings", "cloudSync"));
    expect(files.length).toBeGreaterThan(2);
    expect(files.filter((f) => WINDOW_API.test(fs.readFileSync(f, "utf8")))).toEqual([]);
    expect(WINDOW_API.test(fs.readFileSync(path.join(ROOT, "src", "services", "cloudSyncService.ts"), "utf8"))).toBe(true);
  });

  it("R10: no code in electron/ or src/ reads a cloud_* table directly; positive: the pattern hits a planted line", () => {
    const files = [...walk(path.join(ROOT, "electron")), ...walk(path.join(ROOT, "src"))];
    expect(files.length).toBeGreaterThan(500);
    expect(files.filter((f) => DIRECT_CLOUD_TABLE.test(fs.readFileSync(f, "utf8")))).toEqual([]);
    expect(DIRECT_CLOUD_TABLE.test(`supabase.from('cloud_deals').select('id')`)).toBe(true);
    expect(DIRECT_CLOUD_TABLE.test(`client.from("cloud_deal_parties")`)).toBe(true);
  });
});
