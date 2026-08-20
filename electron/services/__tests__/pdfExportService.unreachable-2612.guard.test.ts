/**
 * @jest-environment node
 *
 * BACKLOG-2612 — pdfExportService.ts IS DEAD CODE, AND MUST STAY DEAD UNTIL
 * IT IS REMOVED.
 *
 * Measured at develop (plan §1b, SR-endorsed): `transactions:export-pdf`
 * routes to `folderExportService.exportTransactionToCombinedPDF`, and NO
 * production module imports `pdfExportService`. The file still holds a full
 * second copy of handle resolution and the `'Unknown'` sentinel that
 * BACKLOG-2461/2463 removed from the live path — re-wiring an export to it
 * would silently resurrect both, and no other test would notice.
 *
 * This guard converts the dead-code claim into an ENFORCED one: it fails the
 * moment any production file under electron/ or src/ imports the module.
 * Removal of the file is filed separately (deletion is a behaviour-adjacent
 * change; this PR is characterization only). When the file is deleted, this
 * guard goes red by its existence assertion — delete the guard with it.
 *
 * CONTROL G1 (run manually, result on BACKLOG-2612): add
 * `import "./pdfExportService";` to electron/services/folderExport/
 * folderExportService.ts → RED (importer set no longer empty).
 *
 * Note on method: unreachability is a NEGATIVE property — it cannot be
 * derived by execution, so this is a source scan by necessity. The scan reads
 * every production .ts/.tsx file and matches import/require/jest.mock
 * specifiers, not arbitrary text, so a comment mentioning the module does not
 * count as an importer.
 */

import fs from "fs";
import path from "path";

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const TARGET = path.join(REPO_ROOT, "electron", "services", "pdfExportService.ts");

/** Production source files: everything under electron/ and src/ except tests. */
function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "__mocks__") continue;
      out.push(...productionFiles(full));
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(test|spec)\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Import/require specifiers that resolve to pdfExportService.
 *
 * The leading `import\s+` alternative covers a BARE SIDE-EFFECT import
 * (`import "../pdfExportService";`), which has no `from` clause. Control G1
 * found this hole: the guard was mutated by adding exactly such an import to
 * electron/services/folderExport/folderExportService.ts and stayed GREEN,
 * because every alternative here required `from`, `require(`, `jest.mock(` or
 * `import(`. A side-effect import is the cheapest way to re-animate a dead
 * module — it runs every top-level statement in it — so the one import form
 * the guard could not see was the one that needs seeing least conditionally.
 */
const IMPORT_RE =
  /(?:from\s+|require\(\s*|jest\.mock\(\s*|import\(\s*|import\s+)["']([^"']*pdfExportService)["']/g;

describe("BACKLOG-2612 — pdfExportService unreachability guard", () => {
  test("the dead module still exists (delete this guard together with the file)", () => {
    expect(fs.existsSync(TARGET)).toBe(true);
  });

  test("NO production file under electron/ or src/ imports pdfExportService", () => {
    const files = [
      ...productionFiles(path.join(REPO_ROOT, "electron")),
      ...productionFiles(path.join(REPO_ROOT, "src")),
    ];
    // Sanity: the walk found the tree (an empty scan would pass vacuously).
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(TARGET);

    const importers: string[] = [];
    for (const file of files) {
      if (file === TARGET) continue;
      const text = fs.readFileSync(file, "utf8");
      if ([...text.matchAll(IMPORT_RE)].length > 0) {
        importers.push(path.relative(REPO_ROOT, file));
      }
    }
    // EXACT set: the day someone wires an export to the dead module, the
    // offending file is named right here.
    expect(importers).toEqual([]);
  });
});
