/**
 * @jest-environment node
 *
 * BACKLOG-4120 PR1 — static boundaries of Learn mode.
 *
 * N3 (SR 426498b4 change 4): walk the TRANSITIVE value-import graph from every
 * Learn mode module and assert it never reaches the auto-detect scan, the
 * hybrid/LLM extractor, any LLM provider, the provider fetchers or the
 * auto-detect gate. Positive control: the same walker, started at
 * emailSyncHandlers.ts, does reach transactionService and the fetchers.
 *
 * P4: the learn tables are named only by schema.sql, the learn SQL module and
 * tests, so no sync, export or upload path reads them. Positive control: the
 * same scan finds learnModeSql.ts.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const REPO = path.join(__dirname, "..", "..", "..", "..");
const ELECTRON = path.join(REPO, "electron");

const LEARN_ENTRIES = [
  ...fs
    .readdirSync(path.join(ELECTRON, "services", "learn"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => path.join(ELECTRON, "services", "learn", f)),
  path.join(ELECTRON, "services", "db", "learnModeDbService.ts"),
  path.join(ELECTRON, "services", "db", "learnModeSql.ts"),
];

const FORBIDDEN: Array<[string, RegExp]> = [
  ["transactionService (scan / createTransaction)", /electron\/services\/transactionService\//],
  ["hybridExtractorService", /electron\/services\/extraction\/hybridExtractorService\.ts$/],
  ["LLM providers / llmConfigService", /electron\/services\/llm\//],
  ["gmailFetchService", /electron\/services\/gmailFetchService\.ts$/],
  ["outlookFetchService", /electron\/services\/outlookFetchService\.ts$/],
  ["emailSyncHandlers (isAutoDetectAllowed)", /electron\/handlers\/emailSyncHandlers\.ts$/],
];

// Value imports only: `import type` / `export type` carry no code.
const SPEC_RE =
  /(?:^|\n)\s*(?:import(?!\s+type\b)[^'"`;]*?from\s*|import\s*|export(?!\s+type\b)[^'"`;]*?from\s*)["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g;

function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // packages are not app modules
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [`${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts"), base]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function closure(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(SPEC_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const target = spec ? resolveSpec(file, spec) : null;
      if (target && !seen.has(target)) stack.push(target);
    }
  }
  return seen;
}

function forbiddenHits(files: Set<string>): string[] {
  const hits: string[] = [];
  for (const f of files) {
    const rel = path.relative(REPO, f).split(path.sep).join("/");
    for (const [name, re] of FORBIDDEN) if (re.test(rel)) hits.push(`${name}: ${rel}`);
  }
  return hits.sort();
}

describe("N3 Learn mode import boundary (transitive)", () => {
  it("positive control: from emailSyncHandlers the walker reaches the scan and the fetchers", () => {
    const hits = forbiddenHits(closure([path.join(ELECTRON, "handlers", "emailSyncHandlers.ts")]));
    expect(hits.some((h) => h.includes("electron/services/transactionService/transactionService.ts"))).toBe(true);
    expect(hits.some((h) => h.startsWith("gmailFetchService"))).toBe(true);
    expect(hits.some((h) => h.startsWith("outlookFetchService"))).toBe(true);
    expect(hits.some((h) => h.startsWith("hybridExtractorService"))).toBe(true);
  });

  it("every Learn mode module's closure reaches none of them", () => {
    expect(LEARN_ENTRIES.length).toBeGreaterThanOrEqual(9);
    const files = closure(LEARN_ENTRIES);
    // the walk really went somewhere (the extractor and the address helpers)
    expect([...files].some((f) => f.endsWith("transactionExtractorService.ts"))).toBe(true);
    expect([...files].some((f) => f.endsWith("addressNormalization.ts"))).toBe(true);
    expect(forbiddenHits(files)).toEqual([]);
  });
});

describe("P4 learn tables appear in no sync / export / upload path", () => {
  const TABLES = /\blearn_(mode_settings|deal_answers|bulk_answers)\b/;
  const ALLOWED = new Set([
    "electron/database/schema.sql",
    "electron/services/db/learnModeSql.ts",
  ]);

  function filesNamingTables(): string[] {
    const out = execFileSync("git", ["grep", "-lE", "learn_(mode_settings|deal_answers|bulk_answers)", "--", "electron", "src", "supabase", "broker-portal", "admin-portal", "scripts"], {
      cwd: REPO,
      encoding: "utf8",
    });
    return out.split("\n").filter(Boolean);
  }

  it("positive control: the scan finds the learn SQL module", () => {
    expect(filesNamingTables()).toContain("electron/services/db/learnModeSql.ts");
    expect(TABLES.test(fs.readFileSync(path.join(REPO, "electron/services/db/learnModeSql.ts"), "utf8"))).toBe(true);
  });

  it("outside schema.sql, the learn SQL module and tests, nothing names a learn table", () => {
    const offenders = filesNamingTables().filter(
      (f) => !ALLOWED.has(f) && !/__tests__\//.test(f) && !/\.test\.tsx?$/.test(f),
    );
    expect(offenders).toEqual([]);
  });
});
