/**
 * @jest-environment node
 *
 * BACKLOG-3863 (SR R5') — the @keepr/ui preset is wired into the desktop
 * Tailwind build WITHOUT changing the desktop primary colour (founder D2:
 * keep #007AFF).
 *
 * Compiles the real tailwind.config.js and asserts on the emitted CSS:
 *   - bg-primary / text-primary are exactly rgb(0 122 255) (#007AFF);
 *   - text-primary-foreground exists (a bare-string `primary` would remove it);
 *   - rounded-*-sm stays 2px (the preset would make it 4px);
 *   - src/index.css sets --primary to 211 100% 50% AFTER importing the kit
 *     theme, so kit classes built on the variable also read #007AFF.
 *
 * Mutations run before this was written (exact-string replace, applied proof):
 *   bare string `primary: '#007AFF'`  -> text-primary-foreground absent -> RED
 *   override removed                  -> bg-primary = hsl(var(--primary)) -> RED
 *   --primary line removed            -> last --primary = 200 98% 39% -> RED
 *   radius pin removed                -> rounded-*-sm = calc(var(--radius) - 4px) -> RED
 */
import fs from "fs";
import path from "path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

const ROOT = path.resolve(__dirname, "..");

let css = "";

beforeAll(async () => {
  const result = await postcss([
    tailwindcss({ config: path.join(ROOT, "tailwind.config.js") }),
  ]).process("@tailwind utilities;", { from: undefined });
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

describe("BACKLOG-3863 — design-system wiring keeps #007AFF", () => {
  it("compiled something (guards against an empty build)", () => {
    expect(css.length).toBeGreaterThan(10_000);
  });

  it("bg-primary and text-primary are exactly #007AFF", () => {
    expect(rule(".bg-primary")).toMatch(/background-color:rgb\(0 122 255 /);
    expect(rule(".text-primary")).toMatch(/color:rgb\(0 122 255 /);
  });

  it("the kit's primary-foreground survives (object-form primary)", () => {
    expect(rule(".text-primary-foreground")).toBe("color:hsl(var(--primary-foreground))");
  });

  it("existing rounded-*-sm corners stay 2px", () => {
    expect(rule(".rounded-bl-sm")).toBe("border-bottom-left-radius:0.125rem");
    expect(rule(".rounded-br-sm")).toBe("border-bottom-right-radius:0.125rem");
    expect(rule(".rounded-tl-sm")).toBe("border-top-left-radius:0.125rem");
  });

  it("index.css imports the kit theme first, then sets --primary to #007AFF", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/index.css"), "utf8");
    const importAt = src.indexOf('@import "../packages/ui/src/styles/theme.css";');
    const baseAt = src.indexOf("@tailwind base;");
    const overrideAt = src.indexOf("--primary: 211 100% 50%;");
    expect(importAt).toBeGreaterThanOrEqual(0);
    expect(importAt).toBeLessThan(baseAt);
    expect(overrideAt).toBeGreaterThan(baseAt);
  });
});
