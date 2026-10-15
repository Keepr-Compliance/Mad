/**
 * BACKLOG-3841 C9 — below md, text fields are 16px (no iOS focus zoom), and
 * md and up are untouched. Parses app/globals.css; the real-engine check is
 * the harness ":fs" keys (16px at 375, unchanged at 768/1024/1280).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import postcss, { type AtRule, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const css = postcss.parse(readFileSync(join(__dirname, '../../app/globals.css'), 'utf8'));

function fieldFontRules(): Rule[] {
  const out: Rule[] = [];
  css.walkRules((rule) => {
    const hasField = rule.selectors.some((s) => /^(input|select|textarea)\b/.test(s.trim()));
    let setsFont = false;
    rule.walkDecls('font-size', () => {
      setsFont = true;
    });
    if (hasField && setsFont) out.push(rule);
  });
  return out;
}

describe('C9 16px fields below md', () => {
  it('exactly one rule, inside the max-md media query, covering input (not checkbox/radio), select, textarea at 16px !important', () => {
    const rules = fieldFontRules();
    expect(rules).toHaveLength(1);
    const rule = rules[0];

    const parent = rule.parent as AtRule;
    expect(parent.type).toBe('atrule');
    expect(parent.name).toBe('media');
    expect(parent.params).toBe('not all and (min-width: 768px)');

    const sels = rule.selectors.map((s) => s.trim());
    expect(sels).toContain('select');
    expect(sels).toContain('textarea');
    const input = sels.find((s) => s.startsWith('input'));
    expect(input).toBeDefined();
    for (const t of ['checkbox', 'radio', 'file', 'range', 'color', 'hidden']) {
      expect(input).toContain(`:not([type='${t}'])`);
    }

    const decls: { value: string; important: boolean }[] = [];
    rule.walkDecls('font-size', (d) => {
      decls.push({ value: d.value, important: !!d.important });
    });
    expect(decls).toEqual([{ value: '16px', important: true }]);
  });
});
