/**
 * SR U1 (storyboards H01 / H02): every failure reason has ONE short line
 * (≤ 45 chars) — the same on the page box and in Keepr's bubble — and the
 * long text never reaches the card.
 *
 * Mutations (each turns a test red):
 *   U1a a code missing from either table, or the tables differ   → "one table"
 *   U1b a line longer than 45 characters                         → "short"
 *   U1c a fail() code with no line                               → "every code"
 *   U1d the long message on the card                             → "no long text"
 */
import * as fs from "fs";
import * as path from "path";
import { SYNC_FAILURE_FALLBACK, SYNC_FAILURE_LINES, syncFailureLine } from "../../src/components/settings/android/syncFailureLines";

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const job = require("../../chrome-extension/job.js") as Record<string, any>;
const SRC = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "job.js"), "utf8");

describe("failure lines (SR U1)", () => {
  it("one table: the page box's FAILURE_LINES equals Keepr's SYNC_FAILURE_LINES", () => {
    expect(job.FAILURE_LINES).toEqual(SYNC_FAILURE_LINES);
    expect(job.failureLine("no_such_code")).toBe(SYNC_FAILURE_FALLBACK);
    expect(syncFailureLine(undefined)).toBe(SYNC_FAILURE_FALLBACK);
  });

  it("short: every line (and the fallback) is one sentence of at most 45 characters", () => {
    for (const [code, line] of Object.entries(SYNC_FAILURE_LINES).concat([["fallback", SYNC_FAILURE_FALLBACK]])) {
      expect([code, line.length <= 45, /^[A-Z].*\.$/.test(line)]).toEqual([code, true, true]);
    }
  });

  it("every code the page or Keepr fails with has its line", () => {
    const codes = new Set<string>();
    for (const m of SRC.matchAll(/fail\("([a-z_]+)"/g)) codes.add(m[1]);
    for (const m of SRC.matchAll(/code: "([a-z_]+)"/g)) codes.add(m[1]);
    for (const m of SRC.matchAll(/kind === "phone_unreachable" \? "([a-z_]+)" : "([a-z_]+)"/g)) {
      codes.add(m[1]);
      codes.add(m[2]);
    }
    for (const k of ["unreachable", "unknown_job", "refused"]) codes.add("keepr_" + k); // the Keepr-lost kinds
    codes.add("not_opened"); // Keepr's own (rcsImportJob: the page never opened)
    codes.add("save_failed"); // Keepr's own (the commit failed)
    expect(codes.size).toBeGreaterThan(10);
    for (const c of codes) expect([c, c in SYNC_FAILURE_LINES]).toEqual([c, true]);
  });

  it("no long text on the card: a failure shows the short line; the long one is in the details", () => {
    const box = document.createElement("div");
    const long = "Keepr stopped: Messages for Web could not reconnect to your phone for 5 minutes. Check your phone, then sync again from Keepr.";
    // What fail() hands the box (see the job tests for the wiring).
    job.renderOverlay(box, job.failureLine("connection_lost"), true, { retry: true, details: long }, { copy: async () => true, theme: "light", retry: async () => true });
    expect(box.querySelector('[data-keepr="progress"]')!.textContent).toBe("Lost the connection to your phone.");
    expect(box.textContent).not.toContain("5 minutes");
    expect(SRC).toContain("env.overlay.show(failureLine(code), true, failExtras);");
  });
});
