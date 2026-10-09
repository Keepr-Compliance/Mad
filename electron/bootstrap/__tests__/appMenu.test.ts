/** BACKLOG-3830: DevTools and reload are unreachable in packaged builds. */
const setApplicationMenu = jest.fn();
const buildFromTemplate = jest.fn((t: unknown) => ({ template: t }));
jest.mock("electron", () => ({
  app: { isPackaged: true },
  Menu: { setApplicationMenu, buildFromTemplate },
}));

import * as fs from "fs";
import * as path from "path";
import {
  buildPackagedMenuTemplate,
  devToolsPreference,
  installApplicationMenu,
  isDevToolsAllowed,
} from "../appMenu";

type Item = { role?: string; submenu?: Item[]; label?: string; accelerator?: string };
function roles(items: Item[]): string[] {
  return items.flatMap((i) => [
    ...(i.role ? [i.role] : []),
    ...(Array.isArray(i.submenu) ? roles(i.submenu) : []),
  ]);
}

describe("packaged menu template", () => {
  const FORBIDDEN = ["toggleDevTools", "reload", "forceReload", "viewMenu"];
  it.each(["darwin", "win32", "linux"] as const)("%s: no devtools/reload roles, no accelerators", (p) => {
    const t = buildPackagedMenuTemplate(p) as Item[];
    const r = roles(t);
    expect(r.length).toBeGreaterThan(0);
    for (const f of FORBIDDEN) expect(r).not.toContain(f);
    expect(JSON.stringify(t)).not.toMatch(/DevTools|CmdOrCtrl\+R|Alt\+Cmd\+I/i);
  });
  it.each(["darwin", "win32", "linux"] as const)("%s: Edit roles exist", (p) => {
    const r = roles(buildPackagedMenuTemplate(p) as Item[]);
    for (const e of ["undo", "redo", "cut", "copy", "paste", "selectAll"]) expect(r).toContain(e);
  });
  it("darwin has app menu with about/hide/quit and a window menu", () => {
    const t = buildPackagedMenuTemplate("darwin") as Item[];
    const r = roles(t);
    for (const e of ["about", "hide", "quit", "windowMenu"]) expect(r).toContain(e);
  });
});

describe("policy", () => {
  beforeEach(() => jest.clearAllMocks());
  it("packaged: devTools false, menu installed", () => {
    expect(devToolsPreference(true)).toBe(false);
    expect(isDevToolsAllowed(true)).toBe(false);
    expect(installApplicationMenu(true)).toBe(true);
    expect(setApplicationMenu).toHaveBeenCalledTimes(1);
  });
  it("unpackaged: devTools true, default menu left alone", () => {
    expect(devToolsPreference(false)).toBe(true);
    expect(installApplicationMenu(false)).toBe(false);
    expect(setApplicationMenu).not.toHaveBeenCalled();
  });
  it("defaults to app.isPackaged", () => {
    expect(devToolsPreference()).toBe(false);
  });
});

describe("every BrowserWindow sets devTools from the policy", () => {
  const files = [
    "electron/main.ts",
    "electron/handlers/googleAuthHandlers.ts",
    "electron/handlers/microsoftAuthHandlers.ts",
    "electron/handlers/systemHandlers.ts",
    "electron/services/folderExport/folderExportService.ts",
    "electron/services/pdfExportService.ts",
  ];
  it("each `new BrowserWindow(` has a devTools preference", () => {
    let windows = 0;
    for (const f of files) {
      const src = fs.readFileSync(path.join(__dirname, "../../..", f), "utf8");
      const n = (src.match(/new BrowserWindow\(/g) || []).length;
      const d = (src.match(/devTools: devToolsPreference\(\)/g) || []).length;
      expect({ f, d }).toEqual({ f, d: n });
      windows += n;
    }
    expect(windows).toBe(9);
  });
  it("main.ts installs the menu before the first createWindow()", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../main.ts"), "utf8");
    const m = src.indexOf("  installApplicationMenu();");
    expect(m).toBeGreaterThan(0);
    expect(m).toBeLessThan(src.indexOf("\n  createWindow();"));
  });
});
