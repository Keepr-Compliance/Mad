/**
 * @jest-environment node
 *
 * BACKLOG-4263 PR-4c (plan §14 F7): the deal archive is read and written only by its own module. No other source
 * file under electron/ or src/ names the table or imports the module's table-name constant, so exports,
 * submissions, search, counts and the AI tools cannot read it. Tests are excluded (they read it on purpose).
 *
 * Files are read as UTF-8 text, never skipped as binary; the positive controls prove the walk reads the module and
 * finds the name there.
 */
import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const TABLE = "cloud_sync_deal_archive";
const MODULE = "electron/services/db/cloudSyncDealArchive.ts";
/** schema.sql declares the table; the module owns it. */
const NAMES_ALLOWED = new Set([MODULE, "electron/database/schema.sql"]);
/** Importers of the table-name constant: the cloud table list (parity and shape checks) only. */
const CONSTANT_ALLOWED = new Set([MODULE, "electron/services/db/cloudSyncSql.ts"]);

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "__tests__" || e.name === "__typefixtures__") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs|sql)$/.test(e.name) && !/\.test\.[a-z]+$/.test(e.name)) out.push(p);
  }
}

const files: string[] = [];
walk(path.join(ROOT, "electron"), files);
walk(path.join(ROOT, "src"), files);
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");
const containing = (needle: string) => files.filter((f) => fs.readFileSync(f, "utf8").includes(needle)).map(rel).sort();

describe("the deal archive has one reader (F7)", () => {
  it("the walk reads source files, the module among them", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.map(rel)).toContain(MODULE);
  });

  it("only the module and schema.sql name the table (positive control: the module is in the hit list)", () => {
    const hits = containing(TABLE);
    expect(hits).toContain(MODULE);
    expect(hits.filter((h) => !NAMES_ALLOWED.has(h))).toEqual([]);
  });

  it("only the module and the cloud table list use the table-name constant", () => {
    const hits = containing("DEAL_ARCHIVE_TABLE");
    expect(hits).toContain(MODULE);
    expect(hits.filter((h) => !CONSTANT_ALLOWED.has(h))).toEqual([]);
  });
});
