/**
 * @jest-environment node
 *
 * BACKLOG-4175 PR4 (RS19): consumers read the ACTIVE rule set, and nothing can
 * wait on the download.
 *   (1) Only senderFilter/, the store and baselineRunner.ts (its test default)
 *       value-import BUNDLED_SENDER_RULES.
 *   (2) Only electron/main.ts value-imports senderRuleSetRefresher.
 * Positive controls: the scan finds the store's own bundled import and main.ts's
 * refresher import, and flags a synthetic offender.
 */
import fs from "fs";
import path from "path";

const REPO = path.join(__dirname, "..", "..", "..");
const SCAN_ROOTS = ["electron", "src"].map((d) => path.join(REPO, d));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "__tests__" || e.name === "__mocks__") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const rel = (f: string) => path.relative(REPO, f).split(path.sep).join("/");

/** Value import clauses (not `import type`) from a module whose path ends with `target`. */
function valueImports(text: string, target: string): string[] {
  const re = /import\s+(?!type\b)([^;]*?)\s+from\s+["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g;
  const hits: string[] = [];
  for (const m of text.matchAll(re)) {
    const spec = m[2] ?? m[3] ?? m[4];
    if (!spec || !spec.replace(/\.(ts|js)$/, "").endsWith(target)) continue;
    hits.push(m[1] ?? "(dynamic)");
  }
  return hits;
}

function bundledOffenders(files: Array<[string, string]>): string[] {
  const allowed = (f: string) =>
    f.startsWith("electron/utils/senderFilter/") ||
    f === "electron/services/senderRuleSetStore.ts" ||
    f === "electron/services/learn/baselineRunner.ts";
  return files
    .filter(([f, text]) => !allowed(f) && valueImports(text, "senderFilter/bundledRules").some((c) => /BUNDLED_SENDER_RULES|\*|\(dynamic\)/.test(c.replace(/\btype\s+\w+/g, ""))))
    .map(([f]) => f);
}

function refresherOffenders(files: Array<[string, string]>): string[] {
  return files
    .filter(([f, text]) => f !== "electron/main.ts" && valueImports(text, "senderRuleSetRefresher").length > 0)
    .map(([f]) => f);
}

const FILES: Array<[string, string]> = SCAN_ROOTS.flatMap((d) => sourceFiles(d)).map((f) => [rel(f), fs.readFileSync(f, "utf8")]);

describe("RS19 sender rule-set import guard", () => {
  it("positive controls: the scan sees the store's bundled import and main.ts's refresher import", () => {
    const store = FILES.find(([f]) => f === "electron/services/senderRuleSetStore.ts")!;
    expect(valueImports(store[1], "senderFilter/bundledRules").join()).toContain("BUNDLED_SENDER_RULES");
    const main = FILES.find(([f]) => f === "electron/main.ts")!;
    expect(valueImports(main[1], "senderRuleSetRefresher")).toHaveLength(1);
    expect(FILES.length).toBeGreaterThan(500);
  });

  it("a synthetic offender is flagged by both rules; a type-only import is not", () => {
    const fake: Array<[string, string]> = [
      ["electron/services/fake.ts", 'import { BUNDLED_SENDER_RULES } from "../utils/senderFilter/bundledRules";\nimport { refreshNow } from "./senderRuleSetRefresher";\n'],
      ["electron/services/typeOnly.ts", 'import type { SenderRuleSet } from "../utils/senderFilter/bundledRules";\nimport { type SenderRuleSet as S } from "../utils/senderFilter/bundledRules";\n'],
    ];
    expect(bundledOffenders(fake)).toEqual(["electron/services/fake.ts"]);
    expect(refresherOffenders(fake)).toEqual(["electron/services/fake.ts"]);
  });

  it("(1) no consumer value-imports BUNDLED_SENDER_RULES", () => {
    expect(bundledOffenders(FILES)).toEqual([]);
  });

  it("(2) only electron/main.ts imports the refresher", () => {
    expect(refresherOffenders(FILES)).toEqual([]);
  });
});
