/**
 * @jest-environment node
 */
/** BACKLOG-3816 S0 — markers and the startup job queue. */
import fs from "fs";
import os from "os";
import path from "path";

import { MARKER_DIR_NAME, STATE_FILE_NAME, createMarkerStore } from "../markers";
import { AtRestStartup, registerDefaultJobs } from "../startup";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-atrest-mk-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("markers", () => {
  const store = () => createMarkerStore({ userData: () => dir, now: () => new Date("2026-10-08T00:00:00Z") });

  it("keeps the backup marker outside the <udid> directory", async () => {
    const s = store();
    expect(await s.readBackupMarker("00008110-ABCDEF")).toBeNull();
    await s.writeBackupMarker("00008110-ABCDEF", "syncing");
    const p = path.join(dir, "Backups", MARKER_DIR_NAME, "00008110-ABCDEF.json");
    expect(s.backupMarkerPath("00008110-ABCDEF")).toBe(p);
    expect((await s.readBackupMarker("00008110-ABCDEF"))?.state).toBe("syncing");
    fs.rmSync(path.join(dir, "Backups", "00008110-ABCDEF"), { recursive: true, force: true });
    expect(fs.existsSync(p)).toBe(true);
  });

  it("refuses a udid that could escape the marker directory", async () => {
    await expect(store().writeBackupMarker("../../evil", "encrypted")).rejects.toThrow();
  });

  it("a malformed marker throws instead of reading as plaintext", async () => {
    const s = store();
    await s.writeBackupMarker("abc", "encrypted");
    fs.writeFileSync(s.backupMarkerPath("abc"), "{}");
    await expect(s.readBackupMarker("abc")).rejects.toThrow(/malformed/);
  });

  it("concurrent scope updates do not lose each other", async () => {
    const s = store();
    await Promise.all([
      s.setScope("attachments", "migrating", { done: 1 }),
      s.setScope("logs", "done"),
      s.setScope("email-attachments", "pending"),
    ]);
    const state = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE_NAME), "utf8"));
    expect(Object.keys(state.scopes).sort()).toEqual(["attachments", "email-attachments", "logs"]);
    expect((await s.getScope("attachments"))?.progress).toEqual({ done: 1 });
  });
});

describe("startup queue", () => {
  const quiet = () => undefined;

  it("runs jobs in order, once, and a failing job does not stop the rest", async () => {
    const seen: string[] = [];
    const q = new AtRestStartup({ log: quiet });
    q.register({ id: "b", order: 20, run: async () => void seen.push("b") });
    q.register({ id: "a", order: 10, run: async () => { seen.push("a"); throw new Error("boom"); } });
    q.register({ id: "c", order: 30, run: async () => void seen.push("c") });
    const first = await q.run();
    const second = await q.run();
    expect(seen).toEqual(["a", "b", "c"]);
    expect(second).toBe(first);
    expect(first.map((o) => `${o.id}:${o.status}`)).toEqual(["a:failed", "b:ok", "c:ok"]);
  });

  it("default registration: data-key first, placeholders replaceable, real jobs not", () => {
    const q = new AtRestStartup({ log: quiet });
    registerDefaultJobs(q);
    expect(q.listJobs().map((j) => j.id)).toEqual([
      "data-key", "logs", "temp-sweep", "attachments", "email-attachments", "backups", "legacy-sweep",
    ]);
    // Every default job is real: "logs" (3819), "temp-sweep"/"attachments"/"email-attachments" (S3),
    // "backups" (S4-C, the kept-iPhone-backup seal), "legacy-sweep". None is a placeholder any more.
    expect(q.listJobs().every((j) => j.placeholder === false)).toBe(true);
    for (const id of ["logs", "attachments", "backups"]) {
      expect(() => q.register({ id, order: 99, run: async () => undefined })).toThrow(/already registered/);
    }
    expect(() => q.register({ id: "data-key", order: 0, run: async () => undefined })).toThrow();
  });

  it("default registration: temp sweep second after logs, legacy sweep LAST, both real", () => {
    const q = new AtRestStartup({ log: quiet });
    registerDefaultJobs(q);
    const jobs = q.listJobs();
    expect(jobs.map((j) => j.id).slice(0, 3)).toEqual(["data-key", "logs", "temp-sweep"]);
    expect(jobs.find((j) => j.id === "temp-sweep")).toEqual({ id: "temp-sweep", order: 20, placeholder: false });
    expect(jobs[jobs.length - 1]).toEqual({ id: "legacy-sweep", order: 60, placeholder: false });
  });

  it("scheduleAfterDbReady waits for readiness, then runs exactly once", async () => {
    let tick: (() => void) | null = null;
    let cleared = false;
    const q = new AtRestStartup({
      log: quiet,
      setInterval: (fn) => { tick = fn; return { unref() {} }; },
      clearInterval: () => { cleared = true; },
    });
    let runs = 0;
    q.register({ id: "x", order: 1, run: async () => void runs++ });
    let ready = false;
    q.scheduleAfterDbReady(() => ready, 10);
    expect(runs).toBe(0);
    tick!();
    expect(runs).toBe(0);
    ready = true;
    tick!();
    await q.run();
    q.scheduleAfterDbReady(() => true, 10);
    tick!();
    await q.run();
    expect(runs).toBe(1);
    expect(cleared).toBe(true);
  });
});
