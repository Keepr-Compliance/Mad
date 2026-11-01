/**
 * @jest-environment node
 *
 * BACKLOG-3968 — whether texts are sent is decided in ONE place, and every
 * text-sending path reads that one answer.
 *
 * Two halves:
 *   - behaviour: submissionChecklistTextLinks-3968.test.ts runs both answers
 *     and requires the gap finder, the payload builder and the text rows to
 *     follow it;
 *   - source (here): only the capability module names the cloud function;
 *     only the submission service asks it; only the gap finder and the
 *     snapshot read the answer (`textLinksSupported`). A third reader reds.
 *
 * The file list comes from `git ls-files` (tracked and new files), so a file
 * the scan cannot read is a failure here, not a silent skip.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..", "..", "..");
const CAPABILITY_MODULE = "electron/services/checklistTextLinksCapability.ts";
const SUBMISSION_SERVICE = "electron/services/submissionService.ts";
const READERS = [
  "electron/services/submissionChecklistLinkGaps.ts",
  "electron/services/submissionChecklistSnapshot.ts",
];

function productionSources(): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "electron", "src"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => fs.existsSync(path.join(ROOT, f)))
    .filter((f) => !/\.test\.(ts|tsx)$/.test(f) && !f.includes("__tests__"));
}

const mentioning = (pattern: RegExp): string[] =>
  productionSources()
    .filter((f) => pattern.test(fs.readFileSync(path.join(ROOT, f), "utf8")))
    .sort();

describe("BACKLOG-3968 — the text-link capability is asked in one place", () => {
  it("the scan reads a real file set (positive control: the capability module is in it)", () => {
    const files = productionSources();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(CAPABILITY_MODULE);
  });

  it("only the capability module names the cloud function", () => {
    expect(mentioning(/submission_checklist_capabilities/)).toEqual([CAPABILITY_MODULE]);
  });

  it("only the submission service asks (one call)", () => {
    const callers = mentioning(/\btextLinksCapability\(/).filter((f) => f !== CAPABILITY_MODULE);
    expect(callers).toEqual([SUBMISSION_SERVICE]);
    const text = fs.readFileSync(path.join(ROOT, SUBMISSION_SERVICE), "utf8");
    expect(text.match(/\btextLinksCapability\(/g)).toHaveLength(1);
  });

  // The link writer (checklistDbService, the add-link handler) must never read
  // it: creating a text link is allowed whatever the cloud says.
  it("exactly two readers of the answer — the gap finder and the snapshot — plus the service that passes it", () => {
    const readers = mentioning(/\btextLinksSupported\b/).filter((f) => f !== SUBMISSION_SERVICE);
    expect(readers).toEqual([...READERS].sort());
  });

  it("the old constant is gone everywhere", () => {
    expect(mentioning(/TEXT_LINKS_HELD_UNTIL_CLOUD_MIGRATION|checklistTextLinkHold/)).toEqual([]);
  });
});
