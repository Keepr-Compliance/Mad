import { buildParamUrl, readFirst, readList, readSort, writeParam, writeSort, type SortParamOptions } from './url-params';

type Key = 'when' | 'name';
const SORT: SortParamOptions<Key> = {
  keys: ['when', 'name'],
  defaultKey: 'when',
  defaultDirectionFor: (k) => (k === 'when' ? 'desc' : 'asc'),
};

describe('url params', () => {
  it('readFirst takes the first of a repeated param', () => {
    expect(readFirst(['a', 'b'])).toBe('a');
    expect(readFirst(undefined)).toBe('');
    expect(readFirst([])).toBe('');
  });

  it('readList trims, drops empties and duplicates, and keeps only allowed values', () => {
    expect(readList(' a, b,,a ')).toEqual(['a', 'b']);
    expect(readList('a,zz,b', ['a', 'b'])).toEqual(['a', 'b']);
    expect(readList(undefined)).toEqual([]);
  });

  it("readSort falls back on an unknown key and on a missing dir uses the key's default", () => {
    expect(readSort({ sort: 'bogus' }, SORT)).toEqual({ key: 'when', direction: 'desc' });
    expect(readSort({ sort: 'name' }, SORT)).toEqual({ key: 'name', direction: 'asc' });
    expect(readSort({ sort: 'name', dir: 'desc' }, SORT)).toEqual({ key: 'name', direction: 'desc' });
    expect(readSort({ sort: 'name', dir: 'sideways' }, SORT)).toEqual({ key: 'name', direction: 'asc' });
  });

  it('writeSort drops the key and direction at their defaults', () => {
    expect(writeSort(new URLSearchParams('sort=name&dir=desc'), { key: 'when', direction: 'desc' }, SORT).toString()).toBe('');
    expect(writeSort(new URLSearchParams(), { key: 'name', direction: 'asc' }, SORT).toString()).toBe('sort=name');
    expect(writeSort(new URLSearchParams(), { key: 'name', direction: 'desc' }, SORT).toString()).toBe('sort=name&dir=desc');
    expect(writeSort(new URLSearchParams(), { key: 'when', direction: 'asc' }, SORT).toString()).toBe('dir=asc');
  });

  it('writeParam sets a value and deletes an empty one', () => {
    const p = new URLSearchParams('a=1');
    writeParam(p, 'b', '2');
    writeParam(p, 'a', '');
    writeParam(p, 'c', null);
    expect(p.toString()).toBe('b=2');
  });

  it('buildParamUrl KEEPS every param it is not told to change', () => {
    expect(buildParamUrl('outcome=failed&q=ann&period=week', { period: 'month' })).toBe('?outcome=failed&q=ann&period=month');
    expect(buildParamUrl(new URLSearchParams('outcome=failed&from=2026-01-01'), { from: null, to: undefined })).toBe(
      '?outcome=failed'
    );
    expect(buildParamUrl('', { a: '' })).toBe('?');
  });
});
