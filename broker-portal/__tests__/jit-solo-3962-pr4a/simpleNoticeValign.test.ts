/**
 * @jest-environment node
 */
/**
 * BACKLOG-3962 PR4a N1 (SR 74022277 carry-forward): with several buttons, every button cell is
 * valign="top", so a label that wraps inside its button does not misalign the row. One button
 * renders as before (no button row, so no cell).
 */

import { buildSimpleNotice } from '@/lib/email/templates/simple-notice';

it.each([2, 3])('%i buttons: every button cell is valign="top"', (n) => {
  const buttons = Array.from({ length: n }, (_, i) => ({ label: `Button ${i}`, url: `https://x.example/${i}` }));
  const { html } = buildSimpleNotice('S', ['l'], buttons);
  const cells = Array.from(html.matchAll(/<td [^>]*padding-right:[^>]*>/g)).map((m) => m[0]);
  expect(cells).toHaveLength(n);
  for (const c of cells) expect(c).toContain('valign="top"');
});

it('one button: unchanged, no button row', () => {
  const { html } = buildSimpleNotice('S', ['l'], [{ label: 'Go', url: 'https://x.example' }]);
  expect(html).not.toContain('valign="top"');
});
