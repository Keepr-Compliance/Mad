// usage: node prof.js <label> '<action js using page>' [settleMs]
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const OUT = process.env.PROF_OUT || path.join(process.cwd(), 'prof3785');
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const [label, action, settle = '8000'] = process.argv.slice(2);
  const b = await chromium.connectOverCDP('http://127.0.0.1:9337');
  const p = b.contexts().flatMap(c => c.pages()).find(x => x.url().includes('5173'));
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
  // renderer heartbeat: record every gap > 200 ms between 50 ms ticks
  await p.evaluate(() => {
    const w = window; clearInterval(w.__hb); w.__gaps = []; let last = performance.now();
    w.__hb = setInterval(() => { const n = performance.now(); if (n - last > 200) w.__gaps.push([Math.round(last), Math.round(n - last)]); last = n; }, 50);
  });
  await cdp.send('Profiler.start');
  const t0 = Date.now();
  const fn = new Function('page', `return (async () => { ${action} })()`);
  await fn(p);
  const tAction = Date.now() - t0;
  await p.waitForTimeout(Number(settle));
  const { profile } = await cdp.send('Profiler.stop');
  const gaps = await p.evaluate(() => window.__gaps);
  fs.writeFileSync(path.join(OUT, `${label}.cpuprofile`), JSON.stringify(profile));
  // self time per function
  const byId = new Map(profile.nodes.map(n => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas; let total = 0;
  profile.samples.forEach((id, i) => {
    const n = byId.get(id); const d = (dt[i + 1] ?? 0) / 1000; total += d;
    const cf = n.callFrame; const key = `${cf.functionName || '(anon)'} ${path.basename(cf.url || '')}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + d);
  });
  // inclusive per function (unique per stack)
  const parent = new Map(); profile.nodes.forEach(n => (n.children || []).forEach(c => parent.set(c, n.id)));
  const incl = new Map();
  profile.samples.forEach((id, i) => {
    const d = (dt[i + 1] ?? 0) / 1000; const seen = new Set(); let cur = id;
    while (cur !== undefined) { const cf = byId.get(cur).callFrame; const key = `${cf.functionName || '(anon)'} ${path.basename(cf.url || '')}:${cf.lineNumber + 1}`;
      if (!seen.has(key)) { seen.add(key); incl.set(key, (incl.get(key) || 0) + d); } cur = parent.get(cur); }
  });
  const top = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([f, ms]) => `${ms.toFixed(0).padStart(7)} ms  ${f}`);
  const maxGap = gaps.reduce((a, g) => Math.max(a, g[1]), 0);
  console.log(`== ${label}: actionMs=${tAction} profiledMs=${total.toFixed(0)} maxRendererGapMs=${maxGap} gaps=${JSON.stringify(gaps.slice(0, 10))}`);
  console.log('-- top self'); console.log(top(self, 18).join('\n'));
  console.log('-- top inclusive'); console.log(top(incl, 30).join('\n'));
  await b.close();
})().catch(e => { console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
