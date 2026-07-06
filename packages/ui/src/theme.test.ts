import * as fs from 'fs';
import * as path from 'path';

/**
 * Theming-contract guard. We assert the FULL set of CSS variables that
 * `tailwind-preset.js` references is declared in `theme.css`. If a component
 * uses e.g. `bg-primary` but `--primary` is missing, the class silently renders
 * nothing — this catches that. Exact color VALUES are intentionally not
 * asserted (hand-authored HSL rounding vs tokens.json would be brittle); values
 * are reviewed against tokens.json in code review.
 */
const themeCss = fs.readFileSync(
  path.join(__dirname, 'styles', 'theme.css'),
  'utf-8'
);
const presetJs = fs.readFileSync(
  path.join(__dirname, '..', 'tailwind-preset.js'),
  'utf-8'
);

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
    // e.g. matches "--primary:" with any leading whitespace
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
});
