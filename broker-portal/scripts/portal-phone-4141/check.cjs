/* eslint-disable no-console */
/* global document, getComputedStyle */
// BACKLOG-4141: measure each dumped login / support-form fragment (with its compiled Tailwind) in
// Chromium. Below lg (390, 768): every link/button/field >= 44 px tall (links also 44 wide) and every
// visible text run >= 14 px. usage: node check.cjs <outDir>  (exit 1 on any FAIL)
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.resolve(__dirname, '../../../node_modules/playwright'));
const WIDTHS = [390, 768, 1024, 1280];
const PHONE = [390, 768];

function probe() {
  const label = (el) => (el.getAttribute('aria-label') || el.getAttribute('id') || el.textContent || el.type || '').trim().replace(/\s+/g, ' ').slice(0, 30);
  const out = { sw: document.documentElement.scrollWidth, targets: [], texts: [], rects: {} };
  const seen = {};
  for (const el of document.querySelectorAll('a, button, input, select, textarea, p, span, label, h1, li')) {
    if (el.getClientRects().length === 0) continue;
    const r = el.getBoundingClientRect();
    const k0 = `${el.tagName}:${label(el)}`; seen[k0] = (seen[k0] || 0) + 1; const k = seen[k0] > 1 ? `${k0}#${seen[k0]}` : k0;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    out.rects[k] = [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom), fs];
    if (/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) out.targets.push({ k, w: Math.round(r.width), h: Math.round(r.height), link: el.tagName === 'A' });
    // a text run: the element owns a non-empty text node and is not decorative
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own && !el.closest('[aria-hidden="true"], .sr-only')) out.texts.push({ k, fs });
  }
  return out;
}

(async () => {
  const dir = path.resolve(process.argv[2]);
  const browser = await chromium.launch();
  const M = {};
  const mode = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html') && !x.endsWith('.tw.html'))) {
    const name = f.replace(/\.html$/, '');
    M[name] = {};
    for (const W of WIDTHS) {
      const page = await browser.newPage({ viewport: { width: W, height: 844 } });
      await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${fs.readFileSync(path.join(dir, name + '.css'), 'utf8')}</style></head><body>${fs.readFileSync(path.join(dir, f), 'utf8')}</body></html>`);
      M[name][W] = await page.evaluate(probe);
      mode[await page.evaluate(() => document.compatMode)] = 1;
      await page.close();
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(dir, 'measure.json'), JSON.stringify(M, null, 1));
  if (Object.keys(mode).join() !== 'CSS1Compat') { console.log('FAIL harness: not standards mode', Object.keys(mode)); process.exit(2); }
  const EXPECT = ['login', 'login-org-not-setup', 'support-new'];
  const res = [];
  const ctl = (id, ok, detail) => res.push(`${ok ? 'PASS' : 'FAIL'} ${id} ${detail}`);
  // positive control: every expected dump exists and yields targets and text (a 0 is a broken harness)
  ctl('C0 dumps measured', EXPECT.every((n) => M[n] && M[n][390].targets.length > 0 && M[n][390].texts.length > 0),
    EXPECT.map((n) => `${n}:${M[n] ? `${M[n][390].targets.length}t/${M[n][390].texts.length}x` : 'absent'}`).join(' '));
  ctl('C1 fits', EXPECT.every((n) => PHONE.every((W) => M[n] && M[n][W].sw <= W)), EXPECT.map((n) => PHONE.map((W) => `${n}@${W}:sw=${M[n] ? M[n][W].sw : '-'}`).join(' ')).join(' '));
  const small = [];
  for (const n of EXPECT) for (const W of PHONE) for (const t of (M[n] ? M[n][W].targets : [])) if (t.h < 44 || (t.link && t.w < 44)) small.push(`${n}@${W} ${t.k} ${t.w}x${t.h}`);
  ctl('C2 targets >=44 below lg (links also >=44 wide)', small.length === 0, small.length ? `${small.length} small: ${small.join('; ')}` : 'all >=44');
  const tiny = [];
  for (const n of EXPECT) for (const W of PHONE) for (const t of (M[n] ? M[n][W].texts : [])) if (t.fs < 14) tiny.push(`${n}@${W} ${t.k} ${t.fs}px`);
  ctl('C3 text >=14 px below lg', tiny.length === 0, tiny.length ? `${tiny.length} small: ${tiny.join('; ')}` : 'all >=14');
  console.log(res.join('\n'));
  console.log(`controls: ${res.length} total, ${res.filter((r) => r.startsWith('PASS')).length} pass, ${res.filter((r) => r.startsWith('FAIL')).length} fail`);
  process.exit(res.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})();
