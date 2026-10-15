/**
 * BACKLOG-3927: the Microsoft Store installer removes $INSTDIR\resources\win\apple-drivers
 * on install; the website installer must not.
 *
 * The NSIS script is compiled per build, so the Store signal is a compile-time define:
 * release.yml's store run passes --config.nsis.include=build/installer-store.nsh, which
 * defines KEEPR_STORE_BUILD and then includes build/installer.nsh. The website build
 * includes build/installer.nsh directly (package.json build.nsis.include).
 *
 * NSIS cannot be compiled in CI here, so these tests read the sources and assert that
 * wiring. Whether the compiled Store installer actually removes the folder on a real
 * machine is verified only by a Store build.
 */
import * as fs from "fs";
import * as path from "path";

const REPO = path.resolve(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const codeLines = (src: string) =>
  src
    .split(/\r?\n/)
    .map((l) => l.replace(/;.*$/, "").trim())
    .filter((l) => l.length > 0);

const NSH = codeLines(read("build/installer.nsh"));
const STORE_NSH = codeLines(read("build/installer-store.nsh"));
const RELEASE = read(".github/workflows/release.yml");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PKG = require(path.join(REPO, "package.json"));

const DEFINE = "KEEPR_STORE_BUILD";
const REMOVAL = 'RMDir /r "$INSTDIR\\resources\\win\\apple-drivers"';

/** Indices of the `!ifdef KEEPR_STORE_BUILD` block (open, close), nesting-aware. */
function storeIfdefSpan(): [number, number] {
  const open = NSH.findIndex((l) => l === `!ifdef ${DEFINE}`);
  if (open < 0) return [-1, -1];
  let depth = 0;
  for (let i = open; i < NSH.length; i++) {
    if (/^!if/i.test(NSH[i])) depth++;
    else if (/^!endif$/i.test(NSH[i])) {
      depth--;
      if (depth === 0) return [open, i];
    }
  }
  return [open, -1];
}

describe("installer.nsh: store-only customInstall (BACKLOG-3927)", () => {
  it("customInstall removes the Apple driver folder", () => {
    const start = NSH.indexOf("!macro customInstall");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = NSH.findIndex((l, i) => i > start && l === "!macroend");
    expect(NSH.slice(start + 1, end)).toEqual([REMOVAL]);
  });

  it("the whole customInstall macro sits inside !ifdef KEEPR_STORE_BUILD (website gets none)", () => {
    const [open, close] = storeIfdefSpan();
    expect(open).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(open);
    const macros = NSH.map((l, i) => (l === "!macro customInstall" ? i : -1)).filter((i) => i >= 0);
    expect(macros).toHaveLength(1);
    expect(macros[0]).toBeGreaterThan(open);
    expect(macros[0]).toBeLessThan(close);
    const removals = NSH.map((l, i) => (l === REMOVAL ? i : -1)).filter((i) => i >= 0);
    expect(removals).toHaveLength(1);
    expect(removals[0]).toBeGreaterThan(open);
    expect(removals[0]).toBeLessThan(close);
  });

  it("installer.nsh never defines KEEPR_STORE_BUILD itself", () => {
    expect(NSH.filter((l) => new RegExp(`^!define\\s+${DEFINE}\\b`).test(l))).toEqual([]);
  });
});

describe("installer-store.nsh: defines the symbol, then includes installer.nsh", () => {
  it("is exactly the define followed by the include", () => {
    expect(STORE_NSH).toEqual([`!define ${DEFINE}`, '!include "installer.nsh"']);
  });
});

describe("only the store run selects installer-store.nsh", () => {
  it("package.json (the website build) includes build/installer.nsh", () => {
    expect(PKG.build.nsis.include).toBe("build/installer.nsh");
  });

  it("release.yml passes the store include inside the store-only $channelArgs block", () => {
    const m = RELEASE.match(
      /if \(\$env:KEEPR_CHANNEL -eq "store"\) \{\s*\$channelArgs = @\(([\s\S]*?)\)\s*\n/,
    );
    expect(m).not.toBeNull();
    expect(m![1]).toContain('"--config.nsis.include=build/installer-store.nsh"');
  });

  it("release.yml names installer-store.nsh nowhere else", () => {
    const hits = RELEASE.split(/\r?\n/).filter(
      (l) => l.includes("installer-store.nsh") && !l.trim().startsWith("#"),
    );
    expect(hits).toEqual(['              "--config.nsis.include=build/installer-store.nsh"']);
  });
});
