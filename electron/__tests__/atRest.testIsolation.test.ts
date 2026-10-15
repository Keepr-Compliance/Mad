/**
 * BACKLOG-3816 S4-C (B1): suites that reach the at-rest stores never share userData.
 *
 * The sync orchestrator, the kept-backup at-rest layer, the saved backup password store
 * and the data key service all resolve their files under `app.getPath("userData")`. A
 * suite that mocks `getPath` as a fixed shared path ("/tmp", "/tmp/keepr-...") reads and
 * writes the SAME store file as every other such suite — and as any later run — which
 * is how the diskGuard-2899 flake happened (`/tmp/backup-password-store.json`).
 *
 * Rule: in every electron test file that names one of those modules, a `getPath` mock
 * must not return a literal path under a shared writable location. Use a fresh directory
 * per file instead: `helpers/testUserData.testUserDataDir()` (or an mkdtemp under
 * os.tmpdir() set in beforeAll). A literal that cannot be created by a normal user
 * (e.g. "/mock/userData") is allowed: nothing can be written there.
 *
 * Text scan, not grep: a raw NUL byte makes grep treat a file as binary and skip it
 * (BACKLOG-2637); this reads every file and fails on a NUL rather than skipping it.
 */
import fs from "fs";
import path from "path";

const REPO = path.resolve(__dirname, "..", "..");
const SCAN_ROOT = path.join(REPO, "electron");

/** Modules whose files live under userData. Matched inside a quoted import/mock specifier. */
const SCOPED_MODULE = /["'][^"'\n]*(deviceSyncOrchestrator|backupAtRest|backupPassword|dataKeyService)["']/;

/** A literal absolute path in a location other suites or the developer's profile can share. */
const SHARED_LITERAL = /["'`](\/tmp\b|\/private\/|\/var\/|\/Users\/|\/home\/|~\/|[A-Za-z]:[\\/])[^"'`]*["'`]/;

/**
 * The text of every `getPath` expression, however many lines it spans: from the word
 * `getPath` to the first `,` / `;` / closing bracket at bracket depth 0 (brackets inside
 * the value, string literals included, are balanced by counting). A factory of any length
 * is scanned whole; there is no fixed line window.
 */
function getPathExpressions(source: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const re = /getPath/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    let depth = 0;
    let end = source.length;
    let quote: string | null = null;
    for (let k = m.index + "getPath".length; k < source.length; k++) {
      const c = source[k];
      if (quote) {
        if (c === "\\") k++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") {
        if (depth === 0) {
          end = k;
          break;
        }
        depth--;
      } else if ((c === "," || c === ";") && depth === 0) {
        end = k;
        break;
      }
    }
    out.push({ line: source.slice(0, m.index).split("\n").length, text: source.slice(m.index, end) });
  }
  return out;
}

function sharedGetPathLiterals(source: string): string[] {
  const hits: string[] = [];
  for (const { line, text } of getPathExpressions(source)) {
    const m = text.match(SHARED_LITERAL);
    if (m) hits.push(`${line}: ${m[0]}`);
  }
  return hits;
}

/** Repo-relative path with forward slashes, whatever the platform separator (Windows: backslash). */
function toPosix(rel: string, sep: string): string {
  return rel.split(sep).join("/");
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
}

describe("at-rest test isolation (BACKLOG-3816 S4-C B1)", () => {
  it("detector: flags a fixed shared path, accepts a per-file temp dir", () => {
    expect(sharedGetPathLiterals(`  getPath: jest.fn().mockReturnValue("/tmp"),`)).toHaveLength(1);
    expect(sharedGetPathLiterals(`app: { getPath: jest.fn(() => "/tmp/keepr-3598-quit") },`)).toHaveLength(1);
    expect(
      sharedGetPathLiterals(`getPath: jest.fn((name) => {\n  const p = { userData: '/Users/x/Library/keepr' };`),
    ).toHaveLength(1);
    // A factory of any length: the literal is found however far below `getPath` it sits.
    expect(
      sharedGetPathLiterals(
        `getPath: jest.fn((name: string) => {\n  const base = name;\n  const x = 1;\n  const y = 2;\n  return "/tmp/" + base;\n}),`,
      ),
    ).toHaveLength(1);
    expect(sharedGetPathLiterals(`getPath: jest.fn(() => require("./helpers/testUserData").testUserDataDir()),`)).toEqual([]);
    expect(sharedGetPathLiterals(`getPath: jest.fn(() => process.env.KEEPR_3816_USERDATA as string),`)).toEqual([]);
    expect(sharedGetPathLiterals(`getPath: jest.fn().mockReturnValue("/mock/userData"),`)).toEqual([]);
  });

  it("detector holds under Windows conditions: CRLF sources, backslash paths", () => {
    const crlf = (t: string) => t.replace(/\n/g, "\r\n");
    expect(sharedGetPathLiterals(crlf(`  getPath: jest.fn().mockReturnValue("/tmp"),\n`))).toHaveLength(1);
    expect(
      sharedGetPathLiterals(
        crlf(`getPath: jest.fn((name: string) => {\n  const base = name;\n  return "/tmp/" + base;\n}),\n`),
      ),
    ).toHaveLength(1);
    expect(sharedGetPathLiterals(crlf(`getPath: jest.fn(() => "C:\\Users\\x\\keepr"),\n`))).toHaveLength(1);
    expect(sharedGetPathLiterals(crlf(`getPath: jest.fn().mockReturnValue("/mock/userData"),\n`))).toEqual([]);
    // Line numbers are unaffected by \r.
    expect(sharedGetPathLiterals(crlf(`a\nb\ngetPath: () => "/tmp",\n`))[0]).toMatch(/^3: /);
    // The relative path the scan reports is slash-normalised on Windows.
    expect(toPosix(path.win32.relative("C:\\r", "C:\\r\\electron\\services\\__tests__\\a.test.ts"), path.win32.sep)).toBe(
      "electron/services/__tests__/a.test.ts",
    );
  });

  it("no suite that reaches the at-rest stores mocks userData as a shared fixed path", () => {
    const files: string[] = [];
    walk(SCAN_ROOT, files);
    const scoped: string[] = [];
    const violations: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      const rel = toPosix(path.relative(REPO, file), path.sep);
      if (source.includes("\u0000")) {
        violations.push(`${rel}: contains a NUL byte; cannot be scanned reliably`);
        continue;
      }
      if (!SCOPED_MODULE.test(source)) continue;
      scoped.push(rel);
      for (const hit of sharedGetPathLiterals(source)) violations.push(`${rel}:${hit}`);
    }
    // The scan must actually reach the suites it exists for.
    expect(scoped).toEqual(
      expect.arrayContaining([
        "electron/services/__tests__/deviceSyncOrchestrator.test.ts",
        "electron/services/__tests__/deviceSyncOrchestrator.diskGuard-2899.test.ts",
        "electron/services/__tests__/stopBackupOnQuit-3598.test.ts",
      ]),
    );
    expect(violations).toEqual([]);
  });
});
