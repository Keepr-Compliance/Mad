/**
 * @jest-environment node
 */

/**
 * BACKLOG-3365 — WHO may consult the hide-from-export gate. An identity set,
 * not an enumeration.
 *
 * BACKLOG-3367's P9 lists export modules by name and asserts each contains no
 * gate reference. That is a good control and it stays, but a list of files can
 * never be proven complete: the next export helper somebody adds is not on it,
 * and P9 stays green while the export starts asking whether the user is still
 * entitled to a text they hid last year.
 *
 * This control asks the question from the other end. It walks every production
 * `.ts`/`.tsx` under `electron/` and `src/` and asserts that the set of files
 * naming the gate is EXACTLY two: where it is defined, and the one hide handler
 * that calls it. A new caller anywhere — in an export helper, a PDF builder, a
 * renderer component — reds this file by name, whether or not anyone remembered
 * to add it to a list.
 *
 * The founder's invariant this defends (epic BACKLOG-3227): the gate covers
 * ONLY the ability to hide. The export never consults it and always honours
 * texts that are already hidden. Unhide is never gated.
 *
 * It also carries BACKLOG-3366's stand-in module out of the repository:
 * `hideFromExportGateStub` must appear in no production file at all.
 */

import fs from "fs";
import path from "path";

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const ROOTS = ["electron", "src"];

/** Every token that names the gate. */
const GATE_TOKENS = [
  "isHideFromExportAllowed",
  "HIDE_FROM_EXPORT_FEATURE_KEY",
  "hideFromExportGateStub",
];

/**
 * The two files, and the only two, that may name it.
 *
 * `useHideFromExportState` is deliberately NOT a gate token. It is the renderer's
 * three-state READ, its name appears inside the import-path string of every file
 * that imports the type, and matching on it would red this control against
 * correct code on day one — a false red, which is worse than a vacuous green.
 * The renderer is not the authority in any case: the write is refused in main.
 */
const EXPECTED = [
  "electron/handlers/featureGateHandlers.ts",
  "electron/handlers/hiddenTextHandlers.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const PRODUCTION_FILES = ROOTS.flatMap((root) => walk(path.join(REPO_ROOT, root)));

function rel(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function filesContaining(token: string): string[] {
  return PRODUCTION_FILES.filter((file) =>
    fs.readFileSync(file, "utf8").includes(token)
  )
    .map(rel)
    .sort();
}

describe("BACKLOG-3365 — the gate has exactly one definition and one caller", () => {
  it("the walk actually read the production tree", () => {
    // Positive control. Without it every assertion below passes vacuously
    // against a walk that found nothing — the failure mode of a source-level
    // control, and the reason P9 asserts `source.length > 200`.
    expect(PRODUCTION_FILES.length).toBeGreaterThan(500);
    const names = PRODUCTION_FILES.map(rel);
    expect(names).toContain("electron/handlers/featureGateHandlers.ts");
    expect(names).toContain("electron/handlers/hiddenTextHandlers.ts");
    expect(names).toContain("electron/services/exportPlan.ts");
    expect(names).toContain("src/hooks/useHideFromExportState.ts");
    // No test file slipped into the corpus.
    expect(names.filter((n) => n.includes("__tests__") || n.includes(".test."))).toEqual([]);
  });

  it("names the gate in exactly two files, and no others", () => {
    const naming = new Set<string>();
    for (const token of GATE_TOKENS) {
      for (const file of filesContaining(token)) {
        naming.add(file);
      }
    }

    // Identity, not a count: the message names the file that broke it.
    expect([...naming].sort()).toEqual(EXPECTED);
  });

  it("the definition and the caller are each the file they claim to be", () => {
    // Without this the set assertion above could hold with the two files
    // swapped, or with the caller holding a second definition of its own.
    expect(filesContaining("HIDE_FROM_EXPORT_FEATURE_KEY")).toEqual([
      "electron/handlers/featureGateHandlers.ts",
    ]);
    expect(filesContaining("isHideFromExportAllowed")).toEqual(EXPECTED);

    const caller = fs.readFileSync(
      path.join(REPO_ROOT, "electron/handlers/hiddenTextHandlers.ts"),
      "utf8"
    );
    expect(caller).toContain('import { isHideFromExportAllowed } from "./featureGateHandlers"');
  });

  it("BACKLOG-3366's stand-in module is gone from the production tree", () => {
    expect(filesContaining("hideFromExportGateStub")).toEqual([]);
    expect(
      fs.existsSync(path.join(REPO_ROOT, "electron/handlers/hideFromExportGateStub.ts"))
    ).toBe(false);
  });

  it("the export path names no part of the gate", () => {
    // The same question P9 asks of three files by name, asked of every file on
    // the export path at once. `resolveExportPlan` filters on the stored marker
    // and must never learn what a plan says.
    const exportFiles = PRODUCTION_FILES.map(rel).filter(
      (n) =>
        n.startsWith("electron/services/export") ||
        n.startsWith("electron/services/folderExport/") ||
        n.startsWith("electron/utils/export") ||
        n === "electron/handlers/transactionExportHandlers.ts" ||
        n === "electron/services/pdfExportService.ts"
    );
    expect(exportFiles.length).toBeGreaterThan(4);

    for (const name of exportFiles) {
      const source = fs.readFileSync(path.join(REPO_ROOT, name), "utf8");
      for (const token of [...GATE_TOKENS, "featureGate", "hide_from_export"]) {
        expect([name, token, source.includes(token)]).toEqual([name, token, false]);
      }
    }
  });
});
