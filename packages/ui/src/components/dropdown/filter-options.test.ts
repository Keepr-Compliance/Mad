import { filterDropdownOptions } from './filter-options';
import type { DropdownOption } from './types';

const OPTIONS: DropdownOption[] = [
  { value: 'a', label: 'Admin', description: 'Manages users and billing' },
  { value: 'g', label: 'Agent', description: 'Sees own transactions' },
  { value: 'v', label: 'Viewer', keywords: ['readonly'] },
];

const values = (q: string) => filterDropdownOptions(OPTIONS, q).map((o) => o.value);

describe('filterDropdownOptions (T14)', () => {
  it('returns every option for an empty or blank query', () => {
    expect(values('')).toEqual(['a', 'g', 'v']);
    expect(values('   ')).toEqual(['a', 'g', 'v']);
  });

  it('trims the query', () => {
    expect(values('  adm  ')).toEqual(['a']);
  });

  it('is case-insensitive', () => {
    expect(values('AGENT')).toEqual(['g']);
  });

  it('matches the description', () => {
    expect(values('transactions')).toEqual(['g']);
  });

  it('matches keywords', () => {
    expect(values('readonly')).toEqual(['v']);
  });

  it('returns nothing when nothing matches', () => {
    expect(values('zzz')).toEqual([]);
  });
});
