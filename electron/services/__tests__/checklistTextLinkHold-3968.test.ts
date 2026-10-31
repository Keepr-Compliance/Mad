/**
 * @jest-environment node
 *
 * BACKLOG-3968 PR-4a (SR plan review c4cae33e R6) — the hold on sending text
 * links is ONE constant in ONE module, and every text-sending path reads it.
 *
 * Two halves:
 *   - behaviour: submissionChecklistTextLinks-3968.test.ts flips the module's
 *     value and requires BOTH the gap finder and the payload builder to follow
 *     it (a reader that inlined the value stays put and goes red there);
 *   - source (here): the value is defined once, and the two readers import it
 *     from that module rather than restating it.
 *
 * The file list comes from `git ls-files` (tracked and new files), so a file the scan cannot read is a
 * failure here, not a silent skip.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..", "..", "..");
const NAME = "TEXT_LINKS_HELD_UNTIL_CLOUD_MIGRATION";
const HOLD_MODULE = "electron/services/checklistTextLinkHold.ts";
const READERS = [
  "electron/services/submissionChecklistLinkGaps.ts",
  "electron/services/submissionChecklistSnapshot.ts",
];

function productionSources(): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "electron", "src"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => !/\.test\.(ts|tsx)$/.test(f) && !f.includes("__tests__"));
}

describe("BACKLOG-3968 — the text-link hold is defined once", () => {
  it("the scan reads a real file set (positive control: the hold module is in it)", () => {
    const files = productionSources();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(HOLD_MODULE);
  });

  it("exactly one definition, in the hold module", () => {
    const definition = new RegExp(`\\b(const|let|var)\\s+${NAME}\\b`);
    const defining = productionSources().filter((f) => definition.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
    expect(defining).toEqual([HOLD_MODULE]);
  });

  it.each(READERS)("%s imports the constant from the hold module", (file) => {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    expect(text).toMatch(new RegExp(`import \\{ ${NAME} \\} from "\\./checklistTextLinkHold";`));
  });
});
