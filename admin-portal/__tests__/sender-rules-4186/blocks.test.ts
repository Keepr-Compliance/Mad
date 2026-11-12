/**
 * BACKLOG-4186 PR B — the release guard's DETAIL in words (control A6).
 * DETAIL: fixtures.ts ERRORS.release_refused, captured from sender_rule_set_publish on keepr-test
 * (one block of each kind: mode, add, remove, flag).
 */
import { blockLines, parseBlocks } from '@/lib/sender-rules/blocks';

import { ERRORS } from './fixtures';

const DETAIL = ERRORS.release_refused.details;

describe('A6: every DETAIL block becomes one line', () => {
  it('the captured DETAIL has the four kinds', () => {
    expect(parseBlocks(DETAIL)?.map((b) => b.kind)).toEqual(['mode', 'add', 'remove', 'flag']);
  });

  it('4 kinds + 1 unknown -> 5 lines, the unknown as raw text', () => {
    const withUnknown = JSON.stringify([...JSON.parse(DETAIL), { kind: 'later', list: 'x.y' }]);
    expect(blockLines(withUnknown)).toEqual([
      'Bulk headers turns Live in Learn questions',
      'Adds promo.example.com to Hide mail from: Domains',
      'Removes showingtime.net from Always keep: Platform domains',
      'Counts auto-submitted mail as bulk',
      '{"kind":"later","list":"x.y"}',
    ]);
  });

  it('a sender-name item reads as its value and match', () => {
    const d = JSON.stringify([{ kind: 'add', list: 'suppress.localParts', item: { value: 'promo', match: 'prefix' } }]);
    expect(blockLines(d)).toEqual(['Adds promo (starts with) to Hide mail from: Sender names']);
  });

  it('an unknown signal, surface or list keeps its server name', () => {
    const d = JSON.stringify([{ kind: 'mode', signal: 'newSignal', surface: 'newSurface' }]);
    expect(blockLines(d)).toEqual(['newSignal turns Live in newSurface']);
  });

  it('a DETAIL that is not a JSON list is one line of raw text', () => {
    expect(blockLines('not json')).toEqual(['not json']);
    expect(blockLines('{"kind":"mode"}')).toEqual(['{"kind":"mode"}']);
    expect(blockLines(null)).toEqual([]);
  });
});
