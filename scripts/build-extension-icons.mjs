#!/usr/bin/env node
/**
 * Keepr extension icons: PNGs from the brand-mark SVGs in
 * chrome-extension/icons/ (keepr-mark.svg; keepr-mark-small.svg for 16 / 32
 * px, simplified so it stays crisp). Run after changing an SVG:
 *   node scripts/build-extension-icons.mjs
 * The PNGs are checked in (the extension folder ships as-is).
 */
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "chrome-extension", "icons");
const sizes = [
  [16, "keepr-mark-small.svg"],
  [32, "keepr-mark-small.svg"],
  [48, "keepr-mark.svg"],
  [128, "keepr-mark.svg"],
];
for (const [size, svg] of sizes) {
  await sharp(path.join(dir, svg), { density: 384 })
    .resize(size, size)
    .png()
    .toFile(path.join(dir, `keepr-${size}.png`));
  console.log(`icons/keepr-${size}.png`);
}
