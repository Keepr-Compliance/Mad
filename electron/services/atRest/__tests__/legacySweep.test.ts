/**
 * BACKLOG-3823 (BACKLOG-3816 slice S6) — legacy "magic-audit" folder sweep.
 *
 * Real filesystem, every target inside one mkdtemp fixture root. The fixture
 * is shaped like the founder's measured Windows layout (BACKLOG-3818 Windows
 * inventory): a legacy userData folder holding Backups/<udid>, message
 * attachments, logs, a Chromium profile and the legacy database + key files,
 * next to the current keepr / keepr-dev profiles.
 *
 * Controls:
 *   LS1 — only the exact legacy folder and exact child names; never keepr /
 *         keepr-dev / a look-alike folder; never through a symlink.
 *   LS2 — legacy mad.db, db-key-store.json, session.json (and every other
 *         unnamed entry) are kept.
 */

jest.mock("electron", () => ({
  app: {
    isPackaged: true,
    getPath: jest.fn(() => "/nonexistent-keepr-test-path"),
    commandLine: { hasSwitch: jest.fn(() => false) },
  },
}));

jest.mock("../../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runLegacySweep, LEGACY_KEEP_NAMES, type LegacySweepDeps } from "../legacySweep";

let root: string;

function write(rel: string, content = "x"): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** Every entry under `dir`, relative, links listed but never followed. */
function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      out.push(r);
      const st = fs.lstatSync(p);
      if (st.isDirectory() && !st.isSymbolicLink()) walk(p, r);
    }
  };
  walk(dir, "");
  return out.sort();
}

/** Build the fixture: appData with current profiles, a decoy and the legacy folder. */
function buildWindowsShapedFixture(): void {
  // Current profiles — must never be touched.
  write("appData/keepr/mad.db", "current-db");
  write("appData/keepr/Backups/UDID-CURRENT/Manifest.db");
  write("appData/keepr/message-attachments/a.png");
  write("appData/keepr-dev/Backups/UDID-DEV/Manifest.db");
  write("appData/keepr-dev/logs/main.log");
  // Look-alike folder — not the legacy folder.
  write("appData/magic-audit-old/Backups/UDID-DECOY/Manifest.db");
  write("appData/magic-audit-old/message-attachments/decoy.png");

  // Legacy folder, shaped like the measured Windows inventory.
  const L = "appData/magic-audit";
  write(`${L}/Backups/UDID-LEGACY/Manifest.db`, "sqlite");
  write(`${L}/Backups/UDID-LEGACY/Manifest.plist`);
  write(`${L}/Backups/UDID-LEGACY/Info.plist`);
  write(`${L}/Backups/UDID-LEGACY/Status.plist`);
  write(`${L}/Backups/UDID-LEGACY/00/00a1b2c3`, "jpeg-bytes");
  write(`${L}/Backups/UDID-LEGACY/3d/3d0d7e5f`, "");
  write(`${L}/message-attachments/0123abcd.png`, "png");
  write(`${L}/message-attachments/4567ef01.heic`, "heic");
  write(`${L}/message-attachments/89ab.m4a`, "m4a");
  write(`${L}/attachments/report.pdf`, "pdf");
  write(`${L}/logs/main.log`, "log line");
  for (const dir of [
    "Cache/Cache_Data/data_0",
    "Code Cache/js/index",
    "GPUCache/data_1",
    "DawnGraphiteCache/data_0",
    "DawnWebGPUCache/data_0",
    "Network/Cookies",
    "Local Storage/leveldb/000003.log",
    "Session Storage/000003.log",
    "Shared Dictionary/db",
    "blob_storage/abc/1",
    "IndexedDB/https_x.leveldb/LOG",
  ]) {
    write(`${L}/${dir}`);
  }
  // Kept (D5) and every unnamed entry.
  write(`${L}/mad.db`, "encrypted-db");
  write(`${L}/mad.db-wal`);
  write(`${L}/db-key-store.json`, "{}");
  write(`${L}/session.json`, "{}");
  write(`${L}/license-cache.json`, "{}");
  write(`${L}/Local State`, "{}");
  write(`${L}/Preferences`, "{}");
  write(`${L}/sentry/scope.json`, "{}");

  // Something outside every profile, reachable only through a link.
  write("outside/secret.txt", "must survive");
  fs.symlinkSync(
    path.join(root, "outside"),
    path.join(root, `${L}/Backups/UDID-LEGACY/link-to-outside`),
    "dir",
  );
  fs.symlinkSync(
    path.join(root, "outside"),
    path.join(root, `${L}/message-attachments/link-to-outside`),
    "dir",
  );
}

function deps(over: Partial<LegacySweepDeps> = {}): Partial<LegacySweepDeps> {
  return {
    isPackaged: true,
    profileOverridden: false,
    appDataDir: path.join(root, "appData"),
    macLogsDir: null,
    userDataDir: path.join(root, "appData", "keepr"),
    ...over,
  };
}

const KEPT_LEGACY_TREE = [
  "Local State",
  "Preferences",
  "db-key-store.json",
  "license-cache.json",
  "mad.db",
  "mad.db-wal",
  "sentry",
  "sentry/scope.json",
  "session.json",
];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "s6-legacy-sweep-"));
});

afterEach(() => {
  // Restore any permission a test removed, then clean up.
  const restore = (d: string): void => {
    try {
      fs.chmodSync(d, 0o755);
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n);
        if (fs.lstatSync(p).isDirectory()) restore(p);
      }
    } catch {
      /* ignore */
    }
  };
  restore(root);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("runLegacySweep (BACKLOG-3823)", () => {
  it("LS2: deletes only the named children; legacy mad.db, key store, session and every unnamed entry are kept", async () => {
    buildWindowsShapedFixture();
    const result = await runLegacySweep(deps());

    expect(result.ran).toBe(true);
    expect(result.rootsFound).toBe(1);
    expect(listTree(path.join(root, "appData/magic-audit"))).toEqual(KEPT_LEGACY_TREE);
    for (const name of ["mad.db", "db-key-store.json", "session.json"]) {
      expect(LEGACY_KEEP_NAMES).toContain(name);
    }
    expect(fs.readFileSync(path.join(root, "appData/magic-audit/mad.db"), "utf8")).toBe("encrypted-db");
    expect(result.total.errors).toBe(0);
    expect(result.total.skipped).toBe(0);
    expect(result.total.removedLinks).toBe(2);
    expect(result.total.bytes).toBeGreaterThan(0);
  });

  it("LS1: keepr, keepr-dev and a look-alike magic-audit-* folder are untouched", async () => {
    buildWindowsShapedFixture();
    const before = {
      keepr: listTree(path.join(root, "appData/keepr")),
      dev: listTree(path.join(root, "appData/keepr-dev")),
      decoy: listTree(path.join(root, "appData/magic-audit-old")),
    };
    await runLegacySweep(deps());
    expect(listTree(path.join(root, "appData/keepr"))).toEqual(before.keepr);
    expect(listTree(path.join(root, "appData/keepr-dev"))).toEqual(before.dev);
    expect(listTree(path.join(root, "appData/magic-audit-old"))).toEqual(before.decoy);
  });

  it("LS1: a look-alike folder alone is not treated as the legacy folder", async () => {
    write("appData/magic-audit-old/Backups/UDID-DECOY/Manifest.db");
    write("appData/magic-auditor/message-attachments/a.png");
    const result = await runLegacySweep(deps());
    expect(result.rootsFound).toBe(0);
    expect(listTree(path.join(root, "appData"))).toEqual([
      "magic-audit-old",
      "magic-audit-old/Backups",
      "magic-audit-old/Backups/UDID-DECOY",
      "magic-audit-old/Backups/UDID-DECOY/Manifest.db",
      "magic-auditor",
      "magic-auditor/message-attachments",
      "magic-auditor/message-attachments/a.png",
    ]);
  });

  it("LS1: a link inside a deleted child is removed as a link; its target is untouched", async () => {
    buildWindowsShapedFixture();
    await runLegacySweep(deps());
    expect(fs.existsSync(path.join(root, "appData/magic-audit/Backups"))).toBe(false);
    expect(listTree(path.join(root, "outside"))).toEqual(["secret.txt"]);
    expect(fs.readFileSync(path.join(root, "outside/secret.txt"), "utf8")).toBe("must survive");
  });

  it("LS1: a legacy folder that is itself a symlink is not swept", async () => {
    write("real-target/Backups/UDID/Manifest.db");
    write("real-target/message-attachments/a.png");
    fs.mkdirSync(path.join(root, "appData"));
    fs.symlinkSync(path.join(root, "real-target"), path.join(root, "appData/magic-audit"), "dir");
    const result = await runLegacySweep(deps());
    expect(result.rootsFound).toBe(0);
    expect(listTree(path.join(root, "real-target"))).toEqual([
      "Backups",
      "Backups/UDID",
      "Backups/UDID/Manifest.db",
      "message-attachments",
      "message-attachments/a.png",
    ]);
  });

  it("macOS: the legacy Logs folder loses its *.log files and is removed when empty; Logs/keepr untouched", async () => {
    write("Logs/magic-audit/main.log");
    write("Logs/magic-audit/main.old.log");
    write("Logs/keepr/main.log");
    const result = await runLegacySweep(deps({ macLogsDir: path.join(root, "Logs") }));
    expect(result.rootsFound).toBe(1);
    expect(listTree(path.join(root, "Logs"))).toEqual(["keepr", "keepr/main.log"]);
  });

  it("does nothing in a dev build or with a moved profile (protects the founder's QA fixture)", async () => {
    buildWindowsShapedFixture();
    const before = listTree(root);
    const dev = await runLegacySweep(deps({ isPackaged: false }));
    const moved = await runLegacySweep(deps({ profileOverridden: true }));
    expect(dev).toMatchObject({ ran: false, skipReason: "not-packaged" });
    expect(moved).toMatchObject({ ran: false, skipReason: "profile-override" });
    expect(listTree(root)).toEqual(before);
  });

  it("refuses a legacy root equal to the running userData", async () => {
    buildWindowsShapedFixture();
    const before = listTree(root);
    const result = await runLegacySweep(
      deps({ userDataDir: path.join(root, "appData", "magic-audit") }),
    );
    expect(result.rootsFound).toBe(0);
    expect(listTree(root)).toEqual(before);
  });

  it("a locked entry is skipped, counted, and the rest of the sweep continues", async () => {
    write("appData/magic-audit/message-attachments/locked/held.png");
    write("appData/magic-audit/Backups/UDID/Manifest.db");
    write("appData/magic-audit/mad.db");
    fs.chmodSync(path.join(root, "appData/magic-audit/message-attachments/locked"), 0o555);
    const result = await runLegacySweep(deps());
    expect(result.total.skipped).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(root, "appData/magic-audit/Backups"))).toBe(false);
    expect(fs.existsSync(path.join(root, "appData/magic-audit/message-attachments/locked/held.png"))).toBe(true);
    expect(fs.existsSync(path.join(root, "appData/magic-audit/mad.db"))).toBe(true);
  });

  it("no legacy folder: nothing happens, nothing thrown", async () => {
    write("appData/keepr/mad.db");
    const result = await runLegacySweep(deps());
    expect(result).toMatchObject({ ran: true, rootsFound: 0 });
    expect(listTree(path.join(root, "appData"))).toEqual(["keepr", "keepr/mad.db"]);
  });
});
