/**
 * BACKLOG-3823 (BACKLOG-3816 slice S6) — temp sweep.
 *
 * Real filesystem inside one mkdtemp fixture root that stands in for the OS
 * temp folder; the real OS temp folder is never a sweep target.
 *
 * Control TS1: only allow-listed producer shapes older than their age limit are
 * removed — never keepr-net-guard-*, never any other keepr-* name, never a
 * young file.
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
import { runTempSweep, HOUR_MS, type TempSweepDeps } from "../tempSweep";

let root: string;
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

function make(rel: string, ageHours: number, opts: { dir?: boolean } = {}): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (opts.dir) {
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, "AppleMobileDeviceSupport64.msi"), "msi");
  } else {
    fs.writeFileSync(p, "x");
  }
  const t = (NOW - ageHours * HOUR_MS) / 1000;
  fs.utimesSync(p, t, t);
}

function list(rel: string): string[] {
  return fs.readdirSync(path.join(root, rel)).sort();
}

function deps(over: Partial<TempSweepDeps> = {}): Partial<TempSweepDeps> {
  return {
    tempDir: path.join(root, "temp"),
    userDataDir: path.join(root, "userData"),
    now: () => NOW,
    ...over,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "s6-temp-sweep-"));
  fs.mkdirSync(path.join(root, "temp"));
  fs.mkdirSync(path.join(root, "userData"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("runTempSweep (BACKLOG-3823)", () => {
  it("TS1: removes only allow-listed shapes past their age; everything else in temp survives", async () => {
    // Old, owned — removed.
    make("temp/keepr-amds-a1B2c3", 48, { dir: true });
    make("temp/keepr-cleanup-reset-4242-1760000000000.sh", 48);
    make("temp/keepr-cleanup-uninstall-4242-1760000000000.ps1", 48);
    make("temp/keepr-cleanup-reset-4242-1760000000001.failed", 8 * 24);
    make("temp/pdf-export-1760000000000-k3j2h1.html", 48);
    make("temp/export-1760000000000-abc123.html", 48);
    make("temp/pdf-combine-1760000000000-zz9.html", 48);
    // Young, owned — kept.
    make("temp/keepr-amds-Z9y8X7", 2, { dir: true });
    make("temp/pdf-export-1760000000002-young.html", 23);
    make("temp/keepr-cleanup-reset-4242-1760000000002.failed", 3 * 24);
    // Not owned (or not this exact shape) — kept regardless of age.
    make("temp/keepr-net-guard-AbC123", 999, { dir: true });
    make("temp/keepr-fixture-gen-q1w2e3", 999, { dir: true });
    make("temp/keepr-other.txt", 999);
    make("temp/keepr-amds-a1B2c3.txt", 999);
    make("temp/export-2612-a1b2c3", 999, { dir: true });
    make("temp/export-report.html", 999);
    make("temp/my-export-1760000000000-abc.html", 999);
    make("temp/unrelated.html", 999);

    const result = await runTempSweep(deps());

    expect(list("temp")).toEqual(
      [
        "keepr-amds-Z9y8X7",
        "pdf-export-1760000000002-young.html",
        "keepr-cleanup-reset-4242-1760000000002.failed",
        "keepr-net-guard-AbC123",
        "keepr-fixture-gen-q1w2e3",
        "keepr-other.txt",
        "keepr-amds-a1B2c3.txt",
        "export-2612-a1b2c3",
        "export-report.html",
        "my-export-1760000000000-abc.html",
        "unrelated.html",
      ].sort(),
    );
    expect(result.total.removedFiles).toBe(7); // 6 files + the msi inside keepr-amds
    expect(result.total.removedDirs).toBe(1);
    expect(result.total.errors).toBe(0);
  });

  it("TS1: userData at-rest-tmp / at-rest-open entries and *.kenc-tmp files older than 24 h are removed; young ones and other files kept", async () => {
    make("userData/at-rest-tmp/run-old/Manifest.db", 30);
    fs.utimesSync(path.join(root, "userData/at-rest-tmp/run-old"), (NOW - 30 * HOUR_MS) / 1000, (NOW - 30 * HOUR_MS) / 1000);
    make("userData/at-rest-tmp/run-new.db", 1);
    make("userData/at-rest-open/old.pdf", 25);
    make("userData/at-rest-open/new.pdf", 1);
    make("userData/message-attachments/ab/abcd.png.kenc-tmp", 30);
    make("userData/message-attachments/ab/abcd.png", 30);
    make("userData/message-attachments/young.kenc-tmp", 1);
    make("userData/attachments/x.pdf.kenc-tmp", 30);
    make("userData/Backups/UDID/f.kenc-tmp", 30);
    make("userData/mad.db", 30);

    await runTempSweep(deps());

    expect(list("userData/at-rest-tmp")).toEqual(["run-new.db"]);
    expect(list("userData/at-rest-open")).toEqual(["new.pdf"]);
    expect(list("userData/message-attachments/ab")).toEqual(["abcd.png"]);
    expect(list("userData/message-attachments")).toEqual(["ab", "young.kenc-tmp"]);
    expect(list("userData/attachments")).toEqual([]);
    // Backups is outside the default .kenc-tmp scopes (500k+ files).
    expect(list("userData/Backups/UDID")).toEqual(["f.kenc-tmp"]);
    expect(list("userData")).toEqual(
      ["Backups", "at-rest-open", "at-rest-tmp", "attachments", "mad.db", "message-attachments"].sort(),
    );
  });

  it("a symlinked keepr-amds-* entry is not followed or removed", async () => {
    make("elsewhere/keep.msi", 999);
    const link = path.join(root, "temp/keepr-amds-L1nk00");
    fs.symlinkSync(path.join(root, "elsewhere"), link, "dir");
    const t = (NOW - 999 * HOUR_MS) / 1000;
    fs.lutimesSync(link, t, t);
    await runTempSweep(deps());
    expect(list("elsewhere")).toEqual(["keep.msi"]);
    expect(list("temp")).toEqual(["keepr-amds-L1nk00"]);
  });

  it("missing folders: nothing thrown", async () => {
    const result = await runTempSweep(
      deps({ tempDir: path.join(root, "nope"), userDataDir: path.join(root, "nope2") }),
    );
    expect(result.total.removedFiles).toBe(0);
  });
});
