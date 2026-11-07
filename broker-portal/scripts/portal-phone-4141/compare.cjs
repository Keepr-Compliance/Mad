/* eslint-disable no-console */
// BACKLOG-4141: desktop-unchanged check (rects AND font size). usage: node compare.cjs <beforeDir> <afterDir> [widths...]
const fs = require('fs'); const path = require('path');
const [a, b, ...ws] = process.argv.slice(2); const widths = ws.length ? ws : ['1024', '1280'];
const A = JSON.parse(fs.readFileSync(path.join(a, 'measure.json'))); const B = JSON.parse(fs.readFileSync(path.join(b, 'measure.json')));
let diffs = 0;
for (const n of Object.keys(A)) for (const w of widths) {
  const ra = A[n][w].rects, rb = B[n][w].rects;
  for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) if (JSON.stringify(ra[k]) !== JSON.stringify(rb[k])) { diffs++; if (diffs <= 15) console.log(`DIFF ${n}@${w} ${k} ${JSON.stringify(ra[k])} -> ${JSON.stringify(rb[k])}`); }
}
console.log(diffs ? `C4 desktop unchanged: FAIL (${diffs} diffs at ${widths.join(',')})` : `C4 desktop unchanged: PASS IDENTICAL at ${widths.join(',')}`);
process.exit(diffs ? 1 : 0);
