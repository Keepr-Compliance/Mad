/**
 * Chart kit purity guard (BACKLOG-4208, control 6).
 *
 * The kit renders from data alone: no chart library, no DOM measuring. A chart
 * that measures renders nothing on the server and differently in tests.
 */
import * as fs from 'fs';
import * as path from 'path';

const FORBIDDEN = [/\brecharts\b/, /\bResizeObserver\b/, /\buseLayoutEffect\b/];

const sources = fs
  .readdirSync(__dirname)
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f));

describe('chart kit purity', () => {
  it('scans every chart source file', () => {
    expect(sources).toEqual(expect.arrayContaining(['bar-chart.tsx', 'scale.ts', 'grid-lines.tsx']));
  });

  it.each(sources)('%s uses no chart library or DOM measuring', (file) => {
    const text = fs.readFileSync(path.join(__dirname, file), 'utf-8');
    for (const pattern of FORBIDDEN) expect({ file, hit: pattern.test(text) }).toEqual({ file, hit: false });
  });
});
