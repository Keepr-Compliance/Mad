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
  const flat = (t: Item[]): Item[] => t.flatMap((i) => [i, ...(i.submenu ? flat(i.submenu) : [])]);
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
  it.each(["darwin", "win32", "linux"] as const)("%s: zoom roles + fullscreen present, = and + both zoom in", (p) => {
    const t = buildPackagedMenuTemplate(p) as Item[];
    const r = roles(t);
    for (const e of ["resetZoom", "zoomIn", "zoomOut", "togglefullscreen"]) expect(r).toContain(e);
    const accels = flat(t).filter((i) => i.role === "zoomIn").map((i) => i.accelerator);
    expect(accels).toContain("CommandOrControl+=");
    expect(accels).toContain(undefined); // default role accelerator (CmdOrCtrl+Plus)
  });
  it("darwin has File > close; others do not need it", () => {
    const t = buildPackagedMenuTemplate("darwin") as Item[];
    const file = t.find((i) => i.label === "File");
    expect(file?.submenu?.map((i) => i.role)).toContain("close");
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

function listSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      return e.name === "node_modules" || e.name === "__tests__" || e.name === "dist" ? [] : listSources(full);
    }
    return /\.(ts|tsx|js|mjs|cjs)$/.test(e.name) && !/\.(test|spec)\./.test(e.name) && !e.name.endsWith(".d.ts") ? [full] : [];
  });
}

describe("every BrowserWindow sets devTools from the policy", () => {
  it("each `new BrowserWindow(` anywhere in electron/ has a devTools preference", () => {
    let windows = 0;
    for (const f of listSources(path.join(__dirname, "../.."))) {
      const src = fs
        .readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)) // skip comment lines
        .join("\n");
      const n = (src.match(/new BrowserWindow\(/g) || []).length;
      const d = (src.match(/devTools: devToolsPreference\(\)/g) || []).length;
      expect({ f: path.relative(path.join(__dirname, "../../.."), f), d }).toEqual({
        f: path.relative(path.join(__dirname, "../../.."), f),
        d: n,
      });
      windows += n;
    }
    expect(windows).toBeGreaterThanOrEqual(9);
  });
  it("main.ts installs the menu before the first createWindow()", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../main.ts"), "utf8");
    const m = src.indexOf("  installApplicationMenu();");
    expect(m).toBeGreaterThan(0);
    expect(m).toBeLessThan(src.indexOf("\n  createWindow();"));
  });
});
