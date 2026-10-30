/**
 * @jest-environment node
 *
 * BACKLOG-3863 wired the @keepr/ui preset into the desktop Tailwind build.
 * BACKLOG-4073 (founder D1, 2026-10-29) switched the desktop primary from
 * #007AFF to the kit's sky blue, so desktop and kit pieces share one blue.
 *
 * Compiles the real src/index.css (theme import included) with the real
 * tailwind.config.js and asserts on the emitted CSS:
 *   - bg-primary / text-primary read the kit variable, hsl(var(--primary));
 *   - the LAST `:root` --primary is the kit's 200 98% 39% (#0284c7), so no
 *     later override pulls it back to #007AFF at runtime;
 *   - --ring stays the kit's 199 89% 48% (#0ea5e9);
 *   - text-primary-foreground exists;
 *   - rounded-*-sm stays 2px (the preset would make it 4px).
 *
 * Mutations run before this was written (exact-string replace, applied proof):
 *   tailwind `primary: { DEFAULT: '#007AFF' }` restored  -> bg-primary = rgb(0 122 255) -> RED
 *   index.css `--primary: 211 100% 50%` block restored   -> last :root --primary = 211 100% 50% -> RED
 *   radius pin removed                                   -> rounded-*-sm = calc(var(--radius) - 4px) -> RED
 */
import fs from "fs";
import path from "path";
import postcss from "postcss";
import postcssImport from "postcss-import";
import tailwindcss from "tailwindcss";

const ROOT = path.resolve(__dirname, "..");
const INDEX_CSS = path.join(ROOT, "src/index.css");

let css = "";

beforeAll(async () => {
  const result = await postcss([
    postcssImport(),
    tailwindcss({ config: path.join(ROOT, "tailwind.config.js") }),
  ]).process(fs.readFileSync(INDEX_CSS, "utf8"), { from: INDEX_CSS });
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

/** Every value a `:root` rule gives `prop`, in source order. */
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

describe("BACKLOG-3863 / 4073 — desktop primary is the kit sky blue", () => {
  it("compiled something (guards against an empty build)", () => {
    expect(css.length).toBeGreaterThan(10_000);
  });

  it("bg-primary and text-primary read the kit variable", () => {
    expect(rule(".bg-primary")).toMatch(
      /background-color:hsl\(var\(--primary\)/,
    );
    expect(rule(".text-primary")).toMatch(
      /(^|;)color:hsl\(var\(--primary\)/,
    );
  });

  it("the last :root --primary is the kit's 200 98% 39%", () => {
    const values = rootValues("--primary");
    expect(values.length).toBeGreaterThan(0);
    expect(values[values.length - 1]).toBe("200 98% 39%");
  });

  it("--ring is the kit's 199 89% 48%", () => {
    const values = rootValues("--ring");
    expect(values.length).toBeGreaterThan(0);
    expect(values[values.length - 1]).toBe("199 89% 48%");
  });

  it("the kit's primary-foreground survives", () => {
    expect(rule(".text-primary-foreground")).toBe("color:hsl(var(--primary-foreground))");
  });

  it("existing rounded-*-sm corners stay 2px", () => {
    expect(rule(".rounded-bl-sm")).toBe("border-bottom-left-radius:0.125rem");
    expect(rule(".rounded-br-sm")).toBe("border-bottom-right-radius:0.125rem");
    expect(rule(".rounded-tl-sm")).toBe("border-top-left-radius:0.125rem");
  });
});
