// BACKLOG-3841 layout harness (ported from broker 3798): load one dumped
// fragment + its compiled CSS into Chromium at each width and print element
// rects as JSON. Form fields also get a "<key>:fs" entry with the computed
// font-size, so the below-md 16px rule is measured in a real engine.
// usage: node measure.cjs <fragment.html> <compiled.css> <width>...
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.resolve(__dirname, '../../../node_modules/playwright'));

const SELECTOR = [
  'button', 'a', 'aside', 'main', 'header', 'nav', 'table', 'thead', 'tr', 'h1', 'h2', 'h3',
  'div.fixed', '[role=dialog]', '[role=menu]', 'input', 'select', 'textarea', 'p',
].join(',');

(async () => {
  const [frag, css, ...widths] = process.argv.slice(2);
  const browser = await chromium.launch();
  const out = {};
  for (const w of widths.map(Number)) {
    const page = await browser.newPage({ viewport: { width: w, height: 812 } });
    await page.setContent(
      `<html><head><style>${fs.readFileSync(css, 'utf8')}</style></head><body>${fs.readFileSync(frag, 'utf8')}</body></html>`
    );
    out[w] = await page.evaluate((sel) => {
      const r = {};
      const seen = {};
      for (const el of document.querySelectorAll(sel)) {
        const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '')
          .trim().replace(/\s+/g, ' ').slice(0, 30);
        const base = `${el.tagName}:${label}`;
        seen[base] = (seen[base] || 0) + 1;
        const k = seen[base] === 1 ? base : `${base}#${seen[base]}`;
        const x = el.getBoundingClientRect();
        r[k] = [Math.round(x.left), Math.round(x.top), Math.round(x.right), Math.round(x.bottom)];
        if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) r[`${k}:fs`] = getComputedStyle(el).fontSize;
      }
      r.scrollWidth = document.documentElement.scrollWidth;
      return r;
    }, SELECTOR);
    await page.close();
  }
  await browser.close();
  console.log(JSON.stringify(out));
})();
