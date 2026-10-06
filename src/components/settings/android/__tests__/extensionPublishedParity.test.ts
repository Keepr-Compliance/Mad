/**
 * SR: one EXTENSION_PUBLISHED for both processes. The renderer may not
 * value-import from electron/, and electron/ may not import from outside it
 * (tsconfig.electron.json rootDir), so the value is mirrored — this test is
 * what keeps the two equal (the repo's mirror + parity pattern).
 *
 * Mutations (each red): either copy flipped alone; the renderer importing
 * the value from electron/ again.
 */
import * as fs from "fs";
import * as path from "path";
import { EXTENSION_PUBLISHED as RENDERER } from "../extensionDistribution";
import { EXTENSION_PUBLISHED as MAIN } from "../../../../../electron/constants/extensionDistribution";

describe("EXTENSION_PUBLISHED: the renderer mirror equals the main process's", () => {
  it("the same value in both", () => {
    expect(RENDERER).toBe(MAIN);
  });

  it("the renderer defines its own (no value import from electron/)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "extensionDistribution.ts"), "utf8");
    expect(src).toMatch(/export const EXTENSION_PUBLISHED = (true|false);/);
    expect(src).not.toMatch(/from "[./]*electron\//);
  });
});
