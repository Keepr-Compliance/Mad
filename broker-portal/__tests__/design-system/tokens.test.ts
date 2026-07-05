/**
 * Design-system token integrity (BACKLOG-1811)
 *
 * tokens.json is the single source of truth for hex values; the Tailwind
 * preset and the JS `colors` export must both derive from it so Tailwind
 * classes and inline-style consumers can never drift.
 */

import { colors } from '@keepr/design-system';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const preset = require('../../../packages/design-system/tailwind-preset.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tokens = require('../../../packages/design-system/tokens.json');

describe('design-system tokens', () => {
  it('preset colors are exactly tokens.json', () => {
    expect(preset.theme.extend.colors).toEqual(tokens);
  });

  it('JS colors export is exactly tokens.json', () => {
    expect(colors).toEqual(tokens);
  });

  it('defines the full primary (sky) scale', () => {
    expect(tokens.primary['600']).toBe('#0284c7');
    expect(Object.keys(tokens.primary)).toEqual([
      '50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950',
    ]);
  });

  it.each(['success', 'warning', 'danger'] as const)(
    '%s scale includes the badge (100/800) and hover (700) stops plus 300/400',
    (hue) => {
      for (const stop of ['50', '100', '200', '300', '400', '500', '600', '700', '800']) {
        expect(tokens[hue][stop]).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  );
});
