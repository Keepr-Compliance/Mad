// BACKLOG-3841 (ported from broker 3798) layout harness: compare before/after measurements at the given
// widths. A key present on both sides must have the identical rect. A key on
// one side only must be invisible there (all-zero rect, i.e. display:none).
// usage: node compare.cjs <beforeDir> <afterDir> <width>...   (exit 1 on any diff)
const fs = require('fs');
const path = require('path');
const [before, after, ...widths] = process.argv.slice(2);
let bad = 0;
const zero = (r) => Array.isArray(r) && r.every((v) => v === 0);
for (const f of fs.readdirSync(before).filter((x) => x.endsWith('.json'))) {
  const a = path.join(after, f);
  if (!fs.existsSync(a)) { console.log(`MISSING after: ${f}`); bad++; continue; }
  const B = JSON.parse(fs.readFileSync(path.join(before, f), 'utf8'));
  const A = JSON.parse(fs.readFileSync(a, 'utf8'));
  for (const w of widths) {
    const b = B[w] || {}, n = A[w] || {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(n)])) {
      if (k in b && k in n) {
        if (JSON.stringify(b[k]) !== JSON.stringify(n[k])) { console.log(`DIFF ${f} @${w} ${k}: ${JSON.stringify(b[k])} -> ${JSON.stringify(n[k])}`); bad++; }
      } else if (k in b && !zero(b[k])) { console.log(`GONE ${f} @${w} ${k}: ${JSON.stringify(b[k])}`); bad++; }
      else if (k in n && !zero(n[k])) { console.log(`NEW  ${f} @${w} ${k}: ${JSON.stringify(n[k])}`); bad++; }
    }
  }
}
console.log(bad ? `${bad} difference(s)` : 'IDENTICAL');
process.exit(bad ? 1 : 0);
