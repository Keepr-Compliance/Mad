/**
 * BACKLOG-4186 PR C: the org picker's list (orgs.ts) and the draft editors (edit.ts).
 * ORG_LIST is the captured admin_list_organizations answer (fixtures-pr-c.ts); {success:false}
 * is the function's own literal (20261031160000_backlog_4098_...sql:19-21).
 */
import { addLocalPart, addStringItems, setMode, splitItems, toggleBulkKey } from '@/lib/sender-rules/edit';
import { filterOrgs, parseOrgList } from '@/lib/sender-rules/orgs';

import { ORG_A, ORG_B } from './fixtures';
import { CONTENT_V3, ORG_LIST } from './fixtures-pr-c';
import { clone } from './helpers';

describe('parseOrgList', () => {
  it('every org, test orgs first (A16)', () => {
    expect(parseOrgList(clone(ORG_LIST), null)).toEqual({
      ok: true,
      orgs: [
        { id: ORG_B, name: 'Test Org B', isTest: true },
        { id: ORG_A, name: 'Test Org A', isTest: false },
      ],
    });
  });

  it.each([
    ['refused', { success: false, error: 'not_authorized' }, null],
    ['an rpc error', null, { code: 'PGRST202', message: 'Could not find the function' }],
    ['not an object', [], null],
    ['organizations not a list', { success: true, organizations: 'x' }, null],
  ])('%s -> a failure, never an empty list (A17)', (_n, data, error) => {
    expect(parseOrgList(data, error)).toEqual({ ok: false });
  });

  it('no orgs at all (jsonb_agg of nothing is null) -> an empty list', () => {
    expect(parseOrgList({ success: true, organizations: null }, null)).toEqual({ ok: true, orgs: [] });
  });

  it('filterOrgs matches by name, any case', () => {
    const r = parseOrgList(clone(ORG_LIST), null);
    if (!r.ok) throw new Error('unreadable');
    expect(filterOrgs(r.orgs, 'org a').map((o) => o.id)).toEqual([ORG_A]);
    expect(filterOrgs(r.orgs, '  ')).toHaveLength(2);
  });
});

describe('edit', () => {
  it('splitItems: commas, newlines, spaces; trimmed and lowercased', () => {
    expect(splitItems(' A.example.com,\nb.example.com  c.example.com;')).toEqual(['a.example.com', 'b.example.com', 'c.example.com']);
  });

  it('addStringItems enforces the cap', () => {
    expect(addStringItems(['a.example.com'], 'b.example.com, c.example.com', 'host', 2)).toEqual({
      items: ['a.example.com', 'b.example.com'],
      error: 'Up to 2 items.',
    });
  });

  it('addStringItems uses the server predicates', () => {
    expect(addStringItems([], 'name@example.com x@nohost', 'address', 500)).toEqual({
      items: ['name@example.com'],
      error: 'x@nohost is not a valid email address.',
    });
  });

  it('addLocalPart: lowercased, match kept, duplicates ignored, invalid refused', () => {
    const one = addLocalPart([], 'NoReply', 'prefix');
    expect(one).toEqual({ items: [{ value: 'noreply', match: 'prefix' }], error: null });
    expect(addLocalPart(one.items, 'noreply', 'prefix').items).toBe(one.items);
    expect(addLocalPart([], 'a@b', 'exact').error).toBe('a@b is not a valid sender name.');
  });

  it('setMode and toggleBulkKey never mutate the input', () => {
    const c = clone(CONTENT_V3);
    const m = setMode(c, 'bulkHeaders', 'detector', 'live');
    expect(m.modes.bulkHeaders.detector).toBe('live');
    expect(c.modes.bulkHeaders.detector).toBe('measure');
    const b = toggleBulkKey(c, 'precedence', true);
    expect(b.suppress.bulkHeaders.anyKeyPresent).toEqual(['list_unsubscribe', 'list_unsubscribe_post', 'precedence']);
    expect(c.suppress.bulkHeaders.anyKeyPresent).toEqual(['list_unsubscribe', 'list_unsubscribe_post']);
  });
});
