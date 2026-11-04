/**
 * @jest-environment node
 *
 * BACKLOG-4110 — the dashboard colours (mock v9) compile to the hex the mock
 * gives. Placement A for 2.45: desktop-only colours in tailwind.config.js
 * theme.extend.colors (warm.* and ink.*); the kit (tokens.json / theme.css)
 * is NOT changed, so --border and border-border keep the kit values.
 *
 * Run: npx jest tests/dashboardColours-4110.test.ts
 * Pattern: tests/designSystemWiring-3863.test.ts (real src/index.css with the
 * theme import inlined, real tailwind.config.js, assertions on emitted CSS).
 */
import fs from "fs";
import path from "path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

const ROOT = path.resolve(__dirname, "..");
const INDEX_CSS = path.join(ROOT, "src/index.css");
const THEME_IMPORT = '@import "../packages/ui/src/styles/theme.css";';
const THEME_CSS = path.join(ROOT, "packages/ui/src/styles/theme.css");

let css = "";

beforeAll(async () => {
  const index = fs.readFileSync(INDEX_CSS, "utf8");
  expect(index.indexOf(THEME_IMPORT)).toBeGreaterThanOrEqual(0);
  // No src file uses border-border, so content scanning would not emit it;
  // an @apply probe makes Tailwind resolve it through the same config.
  const source =
    index.replace(THEME_IMPORT, fs.readFileSync(THEME_CSS, "utf8")) +
    "\n.probe-border-border { @apply border-border; }\n";
  const result = await postcss([
    tailwindcss({ config: path.join(ROOT, "tailwind.config.js") }),
  ]).process(source, { from: INDEX_CSS });
  css = result.css;
}, 60_000);

function rule(selector: string): string | null {
  let found: string | null = null;
  postcss.parse(css).walkRules((r) => {
    if (r.selector === selector && found === null) {
      found = r.nodes
        .filter((n): n is postcss.Declaration => n.type === "decl")
        .map((d) => `${d.prop}:${d.value}`)
        .join(";");
    }
  });
  return found;
}

function rootValues(prop: string): string[] {
  const values: string[] = [];
  postcss.parse(css).walkRules((r) => {
    if (r.selector !== ":root") return;
    r.walkDecls(prop, (d) => {
      values.push(d.value);
    });
  });
  return values;
}

/** hex -> Tailwind's "r g b" triple. */
const rgb = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};

const DIVIDE = " > :not([hidden]) ~ :not([hidden])";

// [selector, css property, hex] — every colour class PR-1 uses.
const CASES: Array<[string, string, string]> = [
  [".bg-warm-page", "background-color", "#F6F5F2"],
  [".bg-warm-header", "background-color", "#FAF9F7"],
  [".hover\\:bg-warm-header:hover", "background-color", "#FAF9F7"],
  [".bg-warm-chip", "background-color", "#F1F0EC"],
  [".bg-warm-divider", "background-color", "#EEECE7"],
  [`.divide-warm-divider${DIVIDE}`, "border-color", "#EEECE7"],
  [".border-warm-divider", "border-color", "#EEECE7"],
  [".border-warm-line", "border-color", "#E6E4DF"],
  [".border-warm-control", "border-color", "#CBC8C1"],
  [".hover\\:border-warm-control:hover", "border-color", "#CBC8C1"],
  [".text-ink", "color", "#1C2430"],
  [".text-ink-muted", "color", "#5B6470"],
  [".bg-primary-50", "background-color", "#F0F9FF"],
  [".text-primary-600", "color", "#0284C7"],
];

describe("BACKLOG-4110 — dashboard colour classes compile to the mock's hex", () => {
  it("compiled something (guards against an empty build)", () => {
    expect(css.length).toBeGreaterThan(10_000);
  });

  it.each(CASES)("%s -> %s %s", (selector, prop, hex) => {
    const decls = rule(selector);
    expect(decls).not.toBeNull();
    expect(decls).toContain(`${prop}:rgb(${rgb(hex)} /`);
  });

  it("ring rail and arc: stroke-warm-line #E6E4DF, stroke-success-600 #16a34a", () => {
    expect(rule(".stroke-warm-line")?.toLowerCase()).toBe("stroke:#e6e4df");
    expect(rule(".stroke-success-600")?.toLowerCase()).toBe("stroke:#16a34a");
  });

  it("the kit is untouched: border-border reads --border, and --border is still 220 13% 91%", () => {
    expect(rule(".probe-border-border")).toBe("border-color:hsl(var(--border))");
    const values = rootValues("--border");
    expect(values.length).toBeGreaterThan(0);
    expect(values[values.length - 1]).toBe("220 13% 91%");
  });
});
