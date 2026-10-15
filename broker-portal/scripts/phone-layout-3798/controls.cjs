// BACKLOG-3904 fix-up: the phone controls block of Users and Submissions, per
// width. Block = top of the search form to the top of the list that follows it.
// Also: the search form and the filter grid rects (to compare the two pages'
// bars), and the results row (the 44px "Showing X of Y" row) when present.
// usage: node controls.cjs <outDir> <width>...   Reads gap-users*.html / gap-submissions*.html
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.resolve(__dirname, '../../../node_modules/playwright'));
const NAMES = ['gap-users', 'gap-users-filtered', 'gap-submissions', 'gap-submissions-filtered'];
(async () => {
  const [dir, ...widths] = process.argv.slice(2);
  const browser = await chromium.launch();
  const out = {};
  for (const w of widths.map(Number)) {
    out[w] = {};
    for (const name of NAMES) {
      const page = await browser.newPage({ viewport: { width: w, height: 812 } });
      await page.setContent(`<html><head><style>${fs.readFileSync(path.join(dir, name + '.css'), 'utf8')}</style></head><body>${fs.readFileSync(path.join(dir, name + '.html'), 'utf8')}</body></html>`);
      out[w][name] = await page.evaluate(() => {
        const vis = (el) => el && el.getBoundingClientRect().height > 0;
        const rect = (el) => {
          if (!vis(el)) return null;
          const x = el.getBoundingClientRect();
          return { top: Math.round(x.top * 10) / 10, left: Math.round(x.left * 10) / 10, w: Math.round(x.width * 10) / 10, h: Math.round(x.height * 10) / 10 };
        };
        const bar = document.querySelector('[data-testid=mobile-top-bar]').getBoundingClientRect();
        // phone search: a visible search field (form[role=search] on submissions, input on users)
        const input = Array.from(document.querySelectorAll('input[type=search], #user-search')).find(vis);
        const form = input ? (input.closest('form') || input.parentElement) : null;
        const grid = Array.from(document.querySelectorAll('button[aria-haspopup=dialog]')).filter(vis)[0]?.parentElement;
        const row = document.querySelector('[data-slot=phone-results-row]');
        const list = document.querySelector('table')?.closest('.overflow-hidden') || document.querySelector('[class*="grid-cols-1"]');
        const t = (el) => (el ? el.getBoundingClientRect().top : null);
        const startTop = t(form);
        return {
          gapUnderTopBar: startTop === null ? null : Math.round((startTop - bar.bottom) * 10) / 10,
          form: rect(form),
          grid: rect(grid),
          row: rect(row),
          rowKids: row && vis(row) ? Array.from(row.querySelectorAll(':scope > *, :scope > * > *')).map((k) => [k.tagName, k.textContent.trim().slice(0, 20), rect(k)]) : null,
          cards: Array.from(document.querySelectorAll('tbody tr, [class*="grid-cols-1"] > *')).filter(vis).slice(0, 1).map((k) => rect(k)),
          rowText: vis(row) ? row.textContent.trim().replace(/\s+/g, ' ') : null,
          controlsBlockH: startTop !== null && list ? Math.round((t(list) - startTop) * 10) / 10 : null,
          scrollWidth: document.documentElement.scrollWidth,
        };
      });
      await page.close();
    }
  }
  await browser.close();
  console.log(JSON.stringify(out, null, 1));
})();
