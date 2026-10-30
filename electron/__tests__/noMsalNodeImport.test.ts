/**
 * BACKLOG-3820: the unused Outlook MSAL service was removed.
 * Guard: no main-process source file imports @azure/msal-node or names its
 * cache file. Files are read as latin1 so a stray NUL byte cannot hide one.
 */
import fs from "fs";
import path from "path";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["__tests__", "__mocks__", "node_modules"].includes(entry.name)) walk(p, out);
    } else if (/\.(ts|js|mjs|cjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

describe("electron/ main-process sources", () => {
  it("do not import @azure/msal-node or name an msal-cache file", () => {
    const root = path.resolve(__dirname, "..");
    const files = walk(root);
    expect(files.length).toBeGreaterThan(100);
    const hits = files
      .filter((f) => /msal-cache|@azure\/msal-node/.test(fs.readFileSync(f, "latin1")))
      .map((f) => path.relative(root, f));
    expect(hits).toEqual([]);
  });
});
