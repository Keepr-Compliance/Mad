/* eslint-disable no-console */
/* global document, getComputedStyle */
// BACKLOG-4139/4140: measure each dumped billing fragment (with its compiled Tailwind) in Chromium
// and print one PASS/FAIL line per control. usage: node check.cjs <outDir>  (exit 1 on any FAIL)
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.resolve(__dirname, '../../../node_modules/playwright'));
const WIDTHS = [390, 768, 1024, 1280];
const PHONE = [390, 768];

function probe(W) {
  const scrollerOf = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const ox = getComputedStyle(p).overflowX; if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return p; } return null; };
  const shown = (el) => { const sc = scrollerOf(el); const r = el.getBoundingClientRect(); const b = sc ? sc.getBoundingClientRect() : { left: 0, right: W }; return r.left >= Math.max(0, b.left) - 1 && r.right <= Math.min(W, b.right) + 1; };
  const label = (el) => (el.getAttribute('aria-label') || el.getAttribute('data-billing-action') || el.textContent || el.type || '').trim().replace(/\s+/g, ' ').slice(0, 30);
  const out = { sw: document.documentElement.scrollWidth, targets: [], texts: {}, rects: {}, pillRows: [] };
  // BACKLOG-4157: per stacked row, the date cell (first cell), the status cell and the row's content edge
  for (const tr of document.querySelectorAll('tr[data-org-invoice-row], tr[data-billing-row]')) {
    const cells = [...tr.children]; const d = cells[0].getBoundingClientRect();
    const pc = cells.find((c) => /^(Paid|Due|Overdue|Void|Unpaid|Payment failed|Refunded|Partly refunded|Disputed)$/.test(c.textContent.trim()));
    const p = pc.firstElementChild.getBoundingClientRect(); const t = tr.getBoundingClientRect(); const cs = getComputedStyle(tr);
    out.pillRows.push({ dateTop: Math.round(d.top), pillTop: Math.round(pc.getBoundingClientRect().top), pillRight: Math.round(p.right), rowRight: Math.round(t.right - parseFloat(cs.paddingRight)) });
  }
  const seen = {};
  for (const el of document.querySelectorAll('a, button, input, table, td, th, li, section, h2, p, span')) {
    if (el.getClientRects().length === 0) continue;
    const r = el.getBoundingClientRect();
    const k0 = `${el.tagName}:${label(el)}`; seen[k0] = (seen[k0] || 0) + 1; const k = seen[k0] > 1 ? `${k0}#${seen[k0]}` : k0;
    out.rects[k] = [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
    if (/^(A|BUTTON|INPUT)$/.test(el.tagName)) out.targets.push({ k, w: Math.round(r.width), h: Math.round(r.height), shown: shown(el), close: el.getAttribute('aria-label') === 'Close' });
  }
  // text cells the solo control needs: the deepest element whose own text is exactly the value
  for (const t of ['$19.99', 'Paid', 'View', '$99.96', 'Due', 'Pay']) {
    const el = [...document.querySelectorAll('body *')].filter((e) => e.textContent.trim() === t && e.getClientRects().length).pop();
    out.texts[t] = el ? shown(el) : null;
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
      // The doctype is load-bearing: without it Chromium lays out in quirks mode, where the escaping
      // absolute sr-only label does NOT widen the document and C1 reads PASS on broken code.
      await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${fs.readFileSync(path.join(dir, name + '.css'), 'utf8')}</style></head><body>${fs.readFileSync(path.join(dir, f), 'utf8')}</body></html>`);
      M[name][W] = await page.evaluate(probe, W);
      mode[await page.evaluate(() => document.compatMode)] = 1;
      await page.close();
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(dir, 'measure.json'), JSON.stringify(M, null, 1));
  if (Object.keys(mode).join() !== 'CSS1Compat') { console.log('FAIL harness: not standards mode', Object.keys(mode)); process.exit(2); }
  const res = [];
  const ctl = (id, ok, detail) => res.push(`${ok ? 'PASS' : 'FAIL'} ${id} ${detail}`);
  const pay = (W) => M['org-due'][W].targets.find((t) => t.k.startsWith('A:pay_invoice'));
  ctl('C1 org page fits', PHONE.every((W) => M['org-due'][W].sw <= W), PHONE.map((W) => `${W}:sw=${M['org-due'][W].sw}`).join(' '));
  ctl('C2 Pay on screen', WIDTHS.every((W) => pay(W) && pay(W).shown), WIDTHS.map((W) => `${W}:${pay(W) ? (pay(W).shown ? 'shown' : 'hidden') : 'absent'}`).join(' '));
  ctl('C3 solo receipt on screen', PHONE.every((W) => ['$19.99', 'Paid', 'View'].every((t) => M['solo-receipts'][W].texts[t] === true)) && PHONE.every((W) => M['solo-receipts'][W].sw <= W), PHONE.map((W) => `${W}:${JSON.stringify(M['solo-receipts'][W].texts)}`).join(' '));
  // C5 (BACKLOG-4157): below lg the status pill is on the date's line (top within 2 px) and flush right in the row.
  const c5 = [];
  for (const n of ['org-due', 'solo-receipts']) for (const W of PHONE) for (const [i, r] of M[n][W].pillRows.entries()) {
    const ok = Math.abs(r.pillTop - r.dateTop) <= 2 && Math.abs(r.pillRight - r.rowRight) <= 1;
    c5.push({ ok, s: `${n}@${W}#${i} date.top=${r.dateTop} pill.top=${r.pillTop} pill.right=${r.pillRight} row.right=${r.rowRight}` });
  }
  ctl('C5 pill on the date line, flush right (390, 768; brokerage + solo)', c5.length === 6 && c5.every((c) => c.ok), c5.map((c) => `${c.ok ? '' : 'BAD '}${c.s}`).join(' | '));
  const small = [];
  // C4 covers exactly the blocks dumped below; the kit-drawn modal Close is excluded (BACKLOG-4141).
  const C4_BLOCKS = ['org-due', 'solo-receipts', 'seats', 'seats-modal', 'autorenew-on', 'autorenew-ending', 'solo-plan-active', 'solo-plan-failed', 'solo-payment', 'solo-choose'];
  for (const n of C4_BLOCKS)
    for (const W of PHONE) for (const t of M[n][W].targets) if (!t.close && (t.h < 44 || t.w < 44)) small.push(`${n}@${W} ${t.k} ${t.w}x${t.h}`);
  ctl('C4 targets >=44x44 below lg in: brokerage invoices + View all + Manage billing + guide link, solo receipts, seats + Add seats modal, auto-renew, solo plan (Cancel plan, End plan now), payment method + contact (Update card, Edit contact), choose plan (Subscribe, Book a Call)', small.length === 0, small.length ? `${small.length} small: ${[...new Set(small.map((s) => s.replace(/@\d+/, '')))].join('; ')}` : 'all >=44');
  // C4b: targets drawn by the kit itself (Modal close X, ConfirmationDialog buttons); fixable only in
  // packages/design-system, which is BACKLOG-4141's scope. INFO only: it never fails this run (SR R2).
  const kit = [];
  for (const W of PHONE) {
    const c = M['seats-modal'][W].targets.find((t) => t.close);
    if (!c || c.w < 44 || c.h < 44) kit.push(`modal Close@${W} ${c ? `${c.w}x${c.h}` : 'absent'}`);
    const dlg = M['autorenew-confirm'][W].targets.filter((t) => !/Turn off auto-renew$/.test(t.k) || t.k.includes('#'));
    for (const t of dlg) if (t.h < 44 || t.w < 44) kit.push(`confirm ${t.k}@${W} ${t.w}x${t.h}`);
  }
  console.log(res.join('\n'));
  console.log(`INFO C4b kit-drawn targets (BACKLOG-4141, not gated here): ${kit.join('; ') || 'all >=44'}`);
  console.log(`controls: ${res.length} total, ${res.filter((r) => r.startsWith('PASS')).length} pass, ${res.filter((r) => r.startsWith('FAIL')).length} fail`);
  process.exit(res.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})();
