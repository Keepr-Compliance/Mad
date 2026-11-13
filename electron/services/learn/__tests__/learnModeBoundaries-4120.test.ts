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
import os from "os";
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
  // PR2: the IPC surface, its schemas and the preload bridge.
  path.join(ELECTRON, "handlers", "learnModeHandlers.ts"),
  path.join(ELECTRON, "schemas", "learnMode.ts"),
  path.join(ELECTRON, "preload", "learnModeBridge.ts"),
];

const FORBIDDEN: Array<[string, RegExp]> = [
  ["transactionService (scan / createTransaction)", /electron\/services\/transactionService\//],
  ["hybridExtractorService", /electron\/services\/extraction\/hybridExtractorService\.ts$/],
  ["LLM providers / llmConfigService", /electron\/services\/llm\//],
  ["gmailFetchService", /electron\/services\/gmailFetchService\.ts$/],
  ["outlookFetchService", /electron\/services\/outlookFetchService\.ts$/],
  ["emailSyncHandlers (isAutoDetectAllowed)", /electron\/handlers\/emailSyncHandlers\.ts$/],
  // PR2: the on-demand attachment download path (it downloads every attachment
  // of a message and pulls both fetchers).
  ["attachmentHandlers (provider download)", /electron\/handlers\/attachmentHandlers\.ts$/],
  ["emailAttachmentService (provider download)", /electron\/services\/emailAttachmentService\.ts$/],
];

// Value imports only: `import type` / `export type` carry no code.
const SPEC_RE =
  /(?:^|\n)\s*(?:import(?!\s+type\b)[^'"`;]*?from\s*|import\s*|export(?!\s+type\b)[^'"`;]*?from\s*)["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g;

/**
 * App path aliases, transcribed from tsconfig.json / tsconfig.electron.json
 * "paths" (and jest.config.js moduleNameMapper). PR2 (SR 08267f11 should-fix
 * 4): an alias import is resolved and walked like a relative one, and an
 * alias-shaped spec that resolves to no file FAILS the walk instead of being
 * skipped as a package — otherwise an `@electron/...` import of a forbidden
 * module would be invisible to N3.
 */
const APP_ALIASES: Array<[string, string]> = [
  ["@/", path.join(REPO, "src") + path.sep],
  ["@electron/", path.join(REPO, "electron") + path.sep],
  ["@types/", path.join(REPO, "types") + path.sep],
  ["@keepr/shared/", path.join(REPO, "packages", "shared", "src") + path.sep],
  ["@keepr/shared", path.join(REPO, "packages", "shared", "src")],
  ["@keepr/ui", path.join(REPO, "packages", "ui", "src", "index.ts")],
  ["@keepr/design-system", path.join(REPO, "packages", "design-system", "src", "index.ts")],
];

class UnresolvedAppImport extends Error {}

function resolveFile(rawBase: string): string | null {
  // Normalise: an alias target joined with a "/"-spec has mixed separators on Windows.
  const base = path.normalize(rawBase);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts")]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function resolveSpec(fromFile: string, spec: string): string | null {
  if (spec.startsWith(".")) {
    return resolveFile(path.resolve(path.dirname(fromFile), spec));
  }
  for (const [prefix, target] of APP_ALIASES) {
    const exact = !prefix.endsWith("/");
    if (exact ? spec === prefix : spec.startsWith(prefix)) {
      const resolved = resolveFile(exact ? target : target + spec.slice(prefix.length));
      if (!resolved) throw new UnresolvedAppImport(`${path.relative(REPO, fromFile)}: cannot resolve app import "${spec}"`);
      return resolved;
    }
  }
  return null; // a package, not an app module
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

  describe("app aliases (SF4)", () => {
    let dir: string;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-n3-"));
    });
    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("an @electron/ alias import is walked: it reaches the scan and the fetchers", () => {
      const f = path.join(dir, "aliasForbidden.ts");
      fs.writeFileSync(f, 'import { x } from "@electron/handlers/emailSyncHandlers";\n');
      const hits = forbiddenHits(closure([f]));
      expect(hits.some((h) => h.startsWith("emailSyncHandlers"))).toBe(true);
      expect(hits.some((h) => h.startsWith("gmailFetchService"))).toBe(true);
    });

    it("an app-alias import that resolves to no file fails the walk", () => {
      const f = path.join(dir, "aliasMissing.ts");
      fs.writeFileSync(f, 'import { x } from "@electron/services/doesNotExist4120";\n');
      expect(() => closure([f])).toThrow(/cannot resolve app import "@electron\/services\/doesNotExist4120"/);
    });

    it("an @/ alias resolves into src/", () => {
      const f = path.join(dir, "aliasSrc.ts");
      fs.writeFileSync(f, 'import { x } from "@/hooks/useFeatureGate";\n');
      expect([...closure([f])].some((p) => p.endsWith(path.join("src", "hooks", "useFeatureGate.ts")))).toBe(true);
    });

    it("a package import is not an app module", () => {
      const f = path.join(dir, "pkg.ts");
      fs.writeFileSync(f, 'import { z } from "zod/v4";\nimport x from "electron";\n');
      expect(closure([f]).size).toBe(1);
    });
  });

  it("every Learn mode module's closure reaches none of them", () => {
    expect(LEARN_ENTRIES.length).toBeGreaterThanOrEqual(12);
    const files = closure(LEARN_ENTRIES);
    // the walk really went somewhere (the extractor and the address helpers)
    expect([...files].some((f) => f.endsWith("transactionExtractorService.ts"))).toBe(true);
    expect([...files].some((f) => f.endsWith("addressNormalization.ts"))).toBe(true);
    expect(forbiddenHits(files)).toEqual([]);
  });
});

describe("PR2 gate and renderer boundaries", () => {
  it("the handlers never name the fail-open reader, the auto-detect gate, or the plan key itself", () => {
    const text = fs.readFileSync(path.join(ELECTRON, "handlers", "learnModeHandlers.ts"), "utf8");
    const code = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).toContain("isAutodetectEvalAllowed");
    expect(code).not.toMatch(/checkFeature|isAutoDetectAllowed|isStrictFeatureAllowed|"autodetect_eval"|"ai_detection"/);
  });

  it("the renderer service carries no main-process code (type-only imports)", () => {
    const files = closure([path.join(REPO, "src", "services", "learnModeService.ts")]);
    expect(files.size).toBe(1);
    const text = fs.readFileSync(path.join(REPO, "src", "services", "learnModeService.ts"), "utf8");
    expect(text).toMatch(/import type \{[\s\S]*?\} from "\.\.\/\.\.\/electron\/types\/ipc\/window-api-learn";/);
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

// BACKLOG-4175 PR4 (RS20): Learn's scoring and run code carry the run's rule
// set as data; they never reach the store or the download. (supabaseService is
// already in this closure before PR4, so it is not asserted here.)
describe("RS20 (4175 PR4) the rule-set store and download stay outside Learn's services", () => {
  const LEARN_ONLY = LEARN_ENTRIES.filter((f) => !/handlers|schemas|preload/.test(path.relative(ELECTRON, f)));
  const relOf = (s: Set<string>) => [...s].map((f) => path.relative(REPO, f).split(path.sep).join("/"));

  it("positive control: from learnModeHandlers the walk reaches the store, not the refresher", () => {
    const reached = relOf(closure([path.join(ELECTRON, "handlers", "learnModeHandlers.ts")]));
    expect(reached).toContain("electron/services/senderRuleSetStore.ts");
    expect(reached).not.toContain("electron/services/senderRuleSetRefresher.ts");
  });

  it("services/learn/* and the two learn db modules reach neither the store nor the refresher", () => {
    expect(LEARN_ONLY.length).toBeGreaterThanOrEqual(11);
    const reached = relOf(closure(LEARN_ONLY));
    expect(reached).toContain("electron/services/learn/scoring.ts");
    expect(
      reached.filter((f) => /senderRuleSetStore|senderRuleSetRefresher/.test(f)),
    ).toEqual([]);
  });

  it("no Learn entry (handlers included) reaches the refresher", () => {
    expect(relOf(closure(LEARN_ENTRIES)).filter((f) => f.includes("senderRuleSetRefresher"))).toEqual([]);
  });
});

// BACKLOG-4219 PR2 (P10): the pilot report's network path is INJECTED into the
// Learn handlers by main.ts; no Learn entry imports it.
describe("P10 (4219) the pilot send / withdraw service stays outside the Learn closure", () => {
  const relOf = (s: Set<string>) => [...s].map((f) => path.relative(REPO, f).split(path.sep).join("/"));

  it("positive control: from main.ts the walk reaches the service", () => {
    expect(relOf(closure([path.join(ELECTRON, "main.ts")]))).toContain("electron/services/learnPilotReportService.ts");
  });

  it("no Learn entry (handlers included) reaches it; the builder is in the closure", () => {
    const reached = relOf(closure(LEARN_ENTRIES));
    expect(reached).toContain("electron/services/learn/pilotReport.ts");
    expect(reached.filter((f) => f.includes("learnPilotReportService"))).toEqual([]);
  });
});
