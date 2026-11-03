/**
 * BACKLOG-4032 slice 4a, control M13: the multi member of DropdownProps.
 * Type-checked by `npm run type-check -w @keepr/ui` (tsconfig includes
 * src/**); jest does not run it. Each `@ts-expect-error` must still be an
 * error: if the type is widened so the line compiles, tsc reports TS2578
 * ("Unused '@ts-expect-error' directive") and the type-check fails.
 */
import { Dropdown } from './dropdown';
import type { DropdownOption } from './types';

const options: DropdownOption[] = [{ value: 'a', label: 'Acme' }];
const noop = () => {};

export const multiOk = (
  <Dropdown mode="multi" ariaLabel="Organization" options={options} value={['a']} onChange={(_v: string[]) => noop()} />
);

export const singleOk = <Dropdown ariaLabel="Role" options={options} value="a" onChange={(_v: string) => noop()} />;

export const multiWithStringValue = (
  // @ts-expect-error multi takes an array value
  <Dropdown mode="multi" ariaLabel="Organization" options={options} value="a" onChange={noop} />
);

export const arrayValueWithoutMode = (
  // @ts-expect-error an array value needs mode="multi"
  <Dropdown ariaLabel="Organization" options={options} value={['a']} onChange={noop} />
);

export const multiSheet = (
  // @ts-expect-error multi is popover only; the sheet is RESERVED
  <Dropdown mode="multi" presentation="sheet" ariaLabel="Organization" options={options} value={['a']} onChange={noop} />
);
