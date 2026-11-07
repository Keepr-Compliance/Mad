/**
 * @jest-environment node
 */

/**
 * BACKLOG-3302 PR 3: the path-taking PDF export channel had no renderer caller
 * and was deleted (founder ruling 2026-09-12, BACKLOG-3234 / BACKLOG-3260).
 *
 * Removed: the IPC channel and its handler, the preload bridge entry, the
 * `WindowApiTransactions` typing, the handler-local freeze-stamp helper and the
 * separate db-layer stamp writer it alone called. The UI's three export modes
 * are served by `transactions:export-enhanced` (One PDF, Summary PDF) and
 * `transactions:export-folder` (Folder), both finishing through
 * `completeExport` (BACKLOG-3303).
 *
 * C1  none of the removed identifiers appears in production code under
 *     electron/ or src/, nor in the e2e driver or QA scripts, comments
 *     included (a stub that keeps the name is red).
 * C1p positive control: the scanner reads the files a stub would land in, and
 *     the live identifiers that sit next to the removed ones ARE found.
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..", "..");

const REMOVED: ReadonlyArray<RegExp> = [
  /transactions:export-pdf\b/,
  /\bexportPDF\b/, // the bridge key; `_exportPDF` (enhancedExportService) is live and does not match
  /\bexportPdfToPath\b/,
  /\bmarkFirstExport\b/,
  /\bstampFirstExportedAt\b/,
];

function scannedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "--", "electron", "src", "e2e", "scripts"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter(
      (f) =>
        /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f) &&
        !/(__tests__|__mocks__|\.test\.|\.spec\.)/.test(f),
    );
}

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
}

describe("BACKLOG-3302 PR 3: the path-taking PDF export channel is gone", () => {
  const files = scannedFiles();

  it("C1 no removed identifier appears in production code, the e2e driver or QA scripts", () => {
    const hits: string[] = [];
    for (const rel of files) {
      const lines = read(rel).split("\n");
      lines.forEach((l, i) => {
        for (const re of REMOVED) if (re.test(l)) hits.push(`${rel}:${i + 1} ${re}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("C1p the scanner sees the handler, bridge, typing, db layer and driver, and the live neighbours", () => {
    for (const must of [
      "electron/handlers/transactionExportHandlers.ts",
      "electron/preload/transactionBridge.ts",
      "electron/types/ipc/window-api-transactions.ts",
      "electron/services/databaseService.ts",
      "electron/services/db/transactionDbService.ts",
      "src/components/ExportModal.tsx",
      "e2e/driver/appDriver.ts",
    ])
      expect([must, files.includes(must)]).toEqual([must, true]);
    expect(read("electron/handlers/transactionExportHandlers.ts")).toMatch(/"transactions:export-enhanced"/);
    expect(read("electron/handlers/transactionExportHandlers.ts")).toMatch(/"transactions:export-folder"/);
    expect(read("electron/preload/transactionBridge.ts")).toMatch(/\bexportEnhanced:/);
    expect(read("electron/types/ipc/window-api-transactions.ts")).toMatch(/\bexportEnhanced:/);
    expect(read("electron/services/db/transactionDbService.ts")).toMatch(/export function recordExportCompletion\(/);
    expect(read("electron/services/enhancedExportService.ts")).toMatch(/\b_exportPDF\(/);
    expect(read("e2e/driver/appDriver.ts")).toMatch(/\bexportCombinedPdfToDir\(/);
  });

  it("C2 the e2e driver drives the One PDF payload into a redirected downloads dir (CI does not run the harness)", () => {
    const src = read("e2e/driver/appDriver.ts");
    const start = src.indexOf("async exportCombinedPdfToDir(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  }\n", start));
    // Transcribed from ExportModal.tsx runExportCall, "combined-pdf" (One PDF).
    expect(body).toMatch(/exportFormat: 'pdf'/);
    expect(body).toMatch(/summaryOnly: false/);
    expect(body).toMatch(/contentType: 'both'/);
    // Never the real ~/Downloads: refuse without the app handle, redirect, verify, then export.
    const refuse = body.indexOf("if (!this.app)");
    const redirect = body.indexOf("app.setPath('downloads', dir)");
    const verify = body.indexOf("if (resolved !== outDir)");
    const exportCall = body.indexOf("exportEnhanced;");
    expect([refuse, redirect, verify].every((i) => i > -1)).toBe(true);
    expect(refuse < redirect && redirect < verify && verify < exportCall).toBe(true);
  });
});
