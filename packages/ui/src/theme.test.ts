import * as fs from 'fs';
import * as path from 'path';

/**
 * Theming-contract guard.
 *
 * 1. Every CSS variable the Tailwind preset references must be DECLARED in
 *    theme.css (a `bg-primary` with no `--primary` renders nothing).
 * 2. The colored-semantic variables must MATCH the @keepr/design-system token
 *    they map to, by VALUE: we parse tokens.json, convert the mapped hex to an
 *    HSL triplet, and assert theme.css agrees within 1-unit rounding. This makes
 *    palette drift (e.g. wiring --success to success-500 instead of success-600)
 *    impossible — the test fails if EITHER side is edited unilaterally.
 *
 * Neutrals (--background/--foreground/--card/--muted/--border/--input/…) are the
 * Tailwind gray scale (tokens.json defines no grays) and are not value-asserted.
 */
const themeCss = fs.readFileSync(
  path.join(__dirname, 'styles', 'theme.css'),
  'utf-8'
);
const presetJs = fs.readFileSync(
  path.join(__dirname, '..', 'tailwind-preset.js'),
  'utf-8'
);
const tokens = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'design-system', 'tokens.json'),
    'utf-8'
  )
) as Record<string, Record<string, string>>;

/** hex (#rrggbb) → [h(0-360), s(0-100), l(0-100)], rounded — matches theme.css authoring. */
function hexToHsl(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

/** Read a `--name: H S% L%;` triplet out of theme.css. */
function readVar(name: string): [number, number, number] {
  const m = themeCss.match(
    new RegExp(`${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`)
  );
  if (!m) throw new Error(`theme.css is missing ${name}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Circular hue distance so 0/360 don't read as far apart. */
function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

/**
 * The documented mapping: CSS variable → the design-system token it derives from.
 * Keep in sync with theme.css comments + README's theming table.
 */
const TOKEN_MAP: Record<string, { hue: string; step: string }> = {
  '--primary': { hue: 'primary', step: '600' },
  '--ring': { hue: 'primary', step: '500' },
  '--destructive': { hue: 'danger', step: '600' },
  '--success': { hue: 'success', step: '600' },
  '--warning': { hue: 'warning', step: '600' },
};

const REQUIRED_VARS = [
  '--primary',
  '--primary-foreground',
  '--ring',
  '--destructive',
  '--destructive-foreground',
  '--success',
  '--success-foreground',
  '--warning',
  '--warning-foreground',
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--border',
  '--input',
  '--radius',
];

describe('theme contract', () => {
  it.each(REQUIRED_VARS)('declares %s in theme.css', (name) => {
    const re = new RegExp(`${name}\\s*:`, 'm');
    expect(themeCss).toMatch(re);
  });

  it('every hsl(var(--x)) referenced by the preset is declared in theme.css', () => {
    // Strip comments first so prose like `hsl(var(--x))` in the doc block isn't
    // scanned as a real reference.
    const presetCode = presetJs
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const referenced = new Set<string>();
    const re = /var\((--[a-z-]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(presetCode)) !== null) {
      referenced.add(m[1]);
    }
    expect(referenced.size).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(themeCss).toMatch(new RegExp(`${name}\\s*:`, 'm'));
    }
  });

  describe('colored semantics match their design-system token (no drift)', () => {
    it.each(Object.entries(TOKEN_MAP))(
      '%s equals hslOf(tokens) within 1 unit',
      (name, { hue, step }) => {
        const hex = tokens[hue]?.[step];
        expect(hex).toBeDefined(); // guards the mapping table itself
        const [eh, es, el] = hexToHsl(hex);
        const [ah, as, al] = readVar(name);
        expect(hueDist(ah, eh)).toBeLessThanOrEqual(1);
        expect(Math.abs(as - es)).toBeLessThanOrEqual(1);
        expect(Math.abs(al - el)).toBeLessThanOrEqual(1);
      }
    );
  });
});
