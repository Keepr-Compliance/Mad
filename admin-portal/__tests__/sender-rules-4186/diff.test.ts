/**
 * BACKLOG-4186 PR B — diff and equality (control A13: `version` is ignored).
 * Contents: the bundled v1 rules (corpus "bundled") and the keepr-test canary content
 * (fixtures.ts CONTENT_V2, captured from sender_rule_set_admin_content).
 */
import { diffLineText, diffRuleSets, sameContent, stripVersion } from '@/lib/sender-rules/diff';

import { CONTENT_V2 } from './fixtures';
import { bundled, clone } from './helpers';

describe('A13: the diff ignores version', () => {
  it('released v5 vs the same rules stored as v3 is "No changes"', () => {
    const v5 = { ...bundled(), version: 5 };
    const v3 = { ...bundled(), version: 3 };
    expect(diffRuleSets(v5, v3)).toEqual([]);
    expect(sameContent(v5, v3)).toBe(true);
  });

  it('stripVersion removes version only', () => {
    const s = stripVersion(bundled());
    expect('version' in s).toBe(false);
    expect(Object.keys(s).sort()).toEqual(['freeMailDomains', 'keep', 'modes', 'schema', 'suppress', 'thresholds']);
  });
});

describe('diffRuleSets', () => {
  it('lists every change between the bundled rules and the keepr-test canary', () => {
    const lines = diffRuleSets(bundled(), CONTENT_V2);
    expect(lines).toEqual([
      { kind: 'mode', signal: 'bulkHeaders', surface: 'learnQuestions', from: 'measure', to: 'live' },
      { kind: 'add', list: 'suppress.hosts', item: 'promo.example.com' },
      { kind: 'remove', list: 'keep.platformHosts', item: 'showingtime.net' },
      { kind: 'flag', list: 'suppress.bulkHeaders.autoSubmittedCounts', from: false, to: true },
    ]);
    expect(lines.map(diffLineText)).toEqual([
      'Bulk headers in Learn questions: Measure to Live',
      'Adds promo.example.com to Hide mail from: Domains',
      'Removes showingtime.net from Always keep: Platform domains',
      'Counts auto-submitted mail as bulk',
    ]);
    expect(sameContent(bundled(), CONTENT_V2)).toBe(false);
  });

  it('compares lists element by element: a swap of equal length shows both sides', () => {
    const next = clone(bundled());
    next.freeMailDomains = next.freeMailDomains.map((d) => (d === 'aol.com' ? 'example.org' : d));
    expect(diffRuleSets(bundled(), next)).toEqual([
      { kind: 'add', list: 'freeMailDomains', item: 'example.org' },
      { kind: 'remove', list: 'freeMailDomains', item: 'aol.com' },
    ]);
  });

  it('a list in a different order is not a change', () => {
    const next = clone(bundled());
    next.keep.platformHosts = [...next.keep.platformHosts].reverse();
    expect(sameContent(bundled(), next)).toBe(true);
  });

  it('sender-name rules compare by value AND match', () => {
    const a = clone(bundled());
    a.suppress.localParts = [{ value: 'noreply', match: 'exact' }];
    const b = clone(bundled());
    b.suppress.localParts = [{ match: 'prefix', value: 'noreply' }];
    const lines = diffRuleSets(a, b);
    expect(lines.map(diffLineText)).toEqual([
      'Adds noreply (starts with) to Hide mail from: Sender names',
      'Removes noreply (exact) from Hide mail from: Sender names',
    ]);
    const c = clone(bundled());
    c.suppress.localParts = [{ match: 'exact', value: 'noreply' }]; // key order differs only
    expect(sameContent(a, c)).toBe(true);
  });

  it('thresholds, and any other field, show up', () => {
    const next = clone(bundled()) as unknown as Record<string, unknown> & { thresholds: Record<string, number> };
    next.thresholds.reportMaxRows = 100;
    next.schema = 2;
    expect(diffRuleSets(bundled(), next).map((l) => diffLineText(l))).toEqual([
      'Report rows (max 500): 500 to 100',
      'schema: 1 to 2',
    ]);
  });
});
