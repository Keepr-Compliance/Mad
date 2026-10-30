/**
 * BACKLOG-4032 slice 3, control C9: PeriodPicker's public props are FROZEN.
 * Three report pages (and an open branch) pass exactly these props; slice 3
 * restyles the component without changing them. Type-checked by
 * `npm run type-check -w @keepr/ui` (tsconfig includes src/**); jest does not run it.
 *
 * Adding a prop, making one required, or widening onChange fails this file.
 */
import type { PeriodOption, PeriodPickerProps } from './period-picker';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

export interface FrozenPeriodOption<K extends string> {
  value: K;
  label: string;
}

export interface FrozenPeriodPickerProps<K extends string> {
  options: readonly FrozenPeriodOption<K>[];
  value: K;
  customKey?: K;
  from?: string;
  to?: string;
  onChange: (value: K, from?: string, to?: string) => void;
  ariaLabel?: string;
  className?: string;
}

type K = 'week' | 'custom';
export type PeriodPickerPropsFrozen = Expect<Equal<PeriodPickerProps<K>, FrozenPeriodPickerProps<K>>>;
export type PeriodOptionFrozen = Expect<Equal<PeriodOption<K>, FrozenPeriodOption<K>>>;
