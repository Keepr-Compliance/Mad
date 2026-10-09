/**
 * Application menu and DevTools policy (BACKLOG-3830).
 *
 * Electron's default menu carries View -> Toggle Developer Tools and Reload.
 * In a packaged build that gives any user the renderer console. Packaged
 * builds therefore get an explicit menu without those roles, and every
 * BrowserWindow is created with `webPreferences.devTools = false` (which also
 * disables the keyboard shortcut). Unpackaged (dev) builds are unchanged.
 */

import { app, Menu } from "electron";
import type { MenuItemConstructorOptions } from "electron";

/** True when DevTools may be opened (dev / unpackaged builds only). */
export function isDevToolsAllowed(packaged: boolean = app.isPackaged): boolean {
  return !packaged;
}

/** Value for `webPreferences.devTools` on every BrowserWindow. */
export function devToolsPreference(packaged: boolean = app.isPackaged): boolean {
  return isDevToolsAllowed(packaged);
}

/** Menu template for packaged builds: no devtools / reload / forceReload roles. */
export function buildPackagedMenuTemplate(
  platform: NodeJS.Platform = process.platform,
  appName: string = "Keepr"
): MenuItemConstructorOptions[] {
  const isMac = platform === "darwin";
  const template: MenuItemConstructorOptions[] = [];
  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }
  template.push({
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  });
  template.push({
    role: "windowMenu",
  });
  if (!isMac) {
    // Windows/Linux have no app menu; keep an exit path.
    template.unshift({
      label: "File",
      submenu: [{ role: "quit" }],
    });
  }
  return template;
}

/**
 * Install the restricted menu in packaged builds. No-op when unpackaged, which
 * keeps Electron's default menu (and DevTools) for development.
 * Returns true when a menu was installed.
 */
export function installApplicationMenu(
  packaged: boolean = app.isPackaged
): boolean {
  if (!packaged) return false;
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildPackagedMenuTemplate()));
  return true;
}
