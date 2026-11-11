/**
 * BACKLOG-4186 PR B — only the owner edits (founder decision 2026-11-09: editor = viewer).
 */
import { canEditSenderRules } from '@/lib/sender-rules/access';

describe('canEditSenderRules', () => {
  it.each([
    ['owner', true],
    ['editor', false],
    ['viewer', false],
    [null, false],
    [undefined, false],
  ] as const)('%s -> %s', (access, want) => {
    expect(canEditSenderRules(access)).toBe(want);
  });
});
