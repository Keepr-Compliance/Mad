/**
 * @jest-environment node
 *
 * BACKLOG-3966 PR-2 — the reserved id of the private checklist is spelled in
 * ONE production file.
 *
 * `checklistPrivacy.ts` holds `MY_ITEMS_TEMPLATE_ID` and the one SQL fragment
 * built from it (`checklistPrivacy-3966.test.ts` holds those two equal).
 * Every other reader and writer imports the constant or binds it as a
 * parameter. A second literal somewhere else is a second definition of
 * "private" that nothing keeps in step — a rename would leave it behind and
 * quietly turn a private checklist into one that is sent to the broker.
 *
 * Derived by walking the source trees, not from a list: a new file that
 * spells the id reds this test without anyone touching it. Tests are exempt
 * (fixtures import the constant, but a test is allowed to name the value).
 * `schema.sql` is the one non-code exception: a comment documenting the id.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const RESERVED = ["keepr", "my-items"].join(":");
const ALLOWED = new Set([
  "electron/services/db/checklistPrivacy.ts",
  "electron/database/schema.sql",
]);

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "__mocks__") continue;
      walk(full, out);
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs|sql)$/.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name)) {
      out.push(full);
    }
  }
}

describe("BACKLOG-3966 — the reserved private-checklist id has one home", () => {
  it("only checklistPrivacy.ts (and a schema.sql comment) spell it, across electron/ and src/", () => {
    const files: string[] = [];
    for (const top of ["electron", "src"]) walk(path.join(ROOT, top), files);
    // The walk saw the whole tree, not an empty directory.
    expect(files.length).toBeGreaterThan(500);
    const spelled = files
      .filter((f) => fs.readFileSync(f, "utf8").includes(RESERVED))
      .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
      .sort();
    expect(spelled).toEqual([...ALLOWED].sort());
  });
});
