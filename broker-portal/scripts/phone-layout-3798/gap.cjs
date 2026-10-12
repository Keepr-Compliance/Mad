// BACKLOG-3904 fix-up: gap (px) from the bottom of the phone top bar to the top
// of the first content, per width. usage: node gap.cjs <outDir> <width>...
// Reads <outDir>/gap-*.html and the .css run.sh compiled next to each.
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.resolve(__dirname, '../../../node_modules/playwright'));
(async () => {
  const [dir, ...widths] = process.argv.slice(2);
  const browser = await chromium.launch();
  const out = {};
  for (const w of widths.map(Number)) {
    const row = {};
    for (const name of ['gap-dashboard', 'gap-submissions', 'gap-submissions-filtered']) {
      const page = await browser.newPage({ viewport: { width: w, height: 812 } });
      await page.setContent(`<html><head><style>${fs.readFileSync(path.join(dir, name + '.css'), 'utf8')}</style></head><body>${fs.readFileSync(path.join(dir, name + '.html'), 'utf8')}</body></html>`);
      row[name] = await page.evaluate(() => {
        const r = (el) => (el ? el.getBoundingClientRect() : null);
        const bar = r(document.querySelector('[data-testid=mobile-top-bar]'));
        const card = r(document.querySelector('[data-stat-label]')?.closest('a,div.grid>div'));
        const search = r(Array.from(document.querySelectorAll('form[role=search]')).find((f) => f.getBoundingClientRect().height > 0));
        const clear = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Clear filters');
        const c = r(clear);
        const grid = clear ? r(clear.closest('.md\\:hidden').querySelector('.grid')) : null;
        const table = r(document.querySelector('table')?.closest('.overflow-hidden'));
        const first = card || search;
        return {
          gap: bar && first ? Math.round((first.top - bar.bottom) * 10) / 10 : null,
          clearH: c ? c.height : null,
          aboveClear: c && grid ? Math.round((c.top - grid.bottom) * 10) / 10 : null,
          belowClear: c && table ? Math.round((table.top - c.bottom) * 10) / 10 : null,
        };
      });
      await page.close();
    }
    out[w] = row;
  }
  await browser.close();
  console.log(JSON.stringify(out, null, 1));
})();
