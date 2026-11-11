import * as React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { SharingDialog } from './sharing-dialog';
import type { SharingDialogProps, SharingEntry, SharingPrincipal } from './types';
import { SharingDialog as SharingDialogFromIndex } from '../../index';

/**
 * BACKLOG-3513 PR-1, controls K1-K10 (plan pm_comments f24fdbc7) plus SR C10
 * (pm_comments e332c2b8). Rendered with controlled open={true}. Focus moves
 * after effects, so focus assertions flush timers first (`settle`).
 *
 * Fixtures are invented. Shapes follow the plan's types: candidates carry no
 * email; an agent carries maxLevel 'viewer'.
 */
const JORDAN: SharingEntry = { id: 'u-jl', kind: 'person', name: 'Jordan Lee', detail: 'Office manager', level: 'editor' };
const PRIYA: SharingEntry = {
  id: 'u-pr',
  kind: 'person',
  name: 'Priya Raman',
  detail: 'Agent',
  maxLevel: 'viewer',
  level: 'viewer',
};
const AGENTS_ROLE: SharingEntry = { id: 'agent', kind: 'role', name: 'Agents', detail: '4 people', maxLevel: 'viewer', level: 'viewer' };
const ENTRIES: SharingEntry[] = [JORDAN, PRIYA, AGENTS_ROLE];

const SAM: SharingPrincipal = { id: 'u-so', kind: 'person', name: 'Sam Ortiz', detail: 'Broker' };
const TESS: SharingPrincipal = { id: 'u-tw', kind: 'person', name: 'Tess Wren', detail: 'Admin' };
const AVA: SharingPrincipal = { id: 'u-ac', kind: 'person', name: 'Ava Chen', detail: 'Agent', maxLevel: 'viewer' };
const BROKERS_ROLE: SharingPrincipal = { id: 'broker', kind: 'role', name: 'Brokers', detail: '2 people' };
// Candidates include people already on the list and the owner: the dialog must not offer them.
const CANDIDATES: SharingPrincipal[] = [
  SAM,
  TESS,
  AVA,
  BROKERS_ROLE,
  { id: 'u-jl', kind: 'person', name: 'Jordan Lee' },
  { id: 'u-dh', kind: 'person', name: 'Dana Holt' },
];

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

function setup(overrides: Partial<SharingDialogProps> = {}) {
  const props: SharingDialogProps = {
    open: true,
    onOpenChange: jest.fn(),
    name: 'Agent commissions, Q4',
    candidates: CANDIDATES,
    entries: ENTRIES,
    owner: { id: 'u-dh', name: 'Dana Holt', isYou: true, detail: 'Broker · created this report' },
    error: null,
    onGrant: jest.fn(),
    onChangeLevel: jest.fn(),
    onRemove: jest.fn(),
    ...overrides,
  };
  const utils = render(<SharingDialog {...props} />);
  return { ...utils, props };
}

const dialog = () => screen.getByRole('dialog', { name: 'Share “Agent commissions, Q4”' });
const trigger = (name: RegExp) => screen.getByRole('button', { name });
const menu = () => screen.getByRole('menu');
const radio = (name: RegExp) => within(menu()).getByRole('menuitemradio', { name });
const item = (name: RegExp) => within(menu()).getByRole('menuitem', { name });
const input = () => screen.getByRole('combobox', { name: 'Add people or roles' });
const accessSelect = () => screen.getByRole('button', { name: /^Access Can/ });
const rowNames = () =>
  Array.from(within(screen.getByRole('list', { name: 'People with access' })).getAllByRole('listitem')).map(
    (li) => li.querySelector('.font-medium')?.textContent
  );

function pick(text: string, option: RegExp) {
  fireEvent.change(input(), { target: { value: text } });
  fireEvent.click(screen.getByRole('option', { name: option }));
}

function expectNoCalls(props: SharingDialogProps) {
  expect(props.onGrant).not.toHaveBeenCalled();
  expect(props.onChangeLevel).not.toHaveBeenCalled();
  expect(props.onRemove).not.toHaveBeenCalled();
}

describe('SharingDialog (BACKLOG-3513)', () => {
  it('K1 changing a level calls onChangeLevel once, and never remove + re-grant', () => {
    const { props } = setup();
    fireEvent.click(trigger(/^Access for Jordan Lee: Can edit$/));
    fireEvent.click(radio(/^Can view/));
    expect(props.onChangeLevel).toHaveBeenCalledTimes(1);
    expect(props.onChangeLevel).toHaveBeenCalledWith(JORDAN, 'viewer');
    expect(props.onGrant).not.toHaveBeenCalled();
    expect(props.onRemove).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('C10 picking the level a row already holds calls nothing and closes the menu', () => {
    const { props } = setup();
    fireEvent.click(trigger(/^Access for Jordan Lee: Can edit$/));
    const held = radio(/^Can edit/);
    expect(held).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(held);
    expectNoCalls(props);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('K2 the owner row is first, reads "Owner" with its detail line, initials avatar, no menu', () => {
    setup();
    // The viewer is the owner: the real name with "(You)" (BACKLOG-3513 PR-6).
    expect(rowNames()).toEqual(['Dana Holt (You)', 'Jordan Lee', 'Priya Raman', 'Role: Agents']);
    const ownerRow = document.querySelector('[data-slot="sharing-owner"]') as HTMLElement;
    expect(ownerRow).toHaveTextContent('Broker · created this report');
    expect(ownerRow).toHaveTextContent(/Owner$/);
    expect(within(ownerRow).queryByRole('button')).toBeNull();
    expect(ownerRow.querySelector('[data-slot="sharing-avatar"]')).toHaveTextContent('DH');
    // Other people get initials; a role gets an icon, not letters.
    const avatars = Array.from(document.querySelectorAll('[data-slot="sharing-entry"] [data-slot="sharing-avatar"]'));
    expect(avatars.map((a) => a.textContent)).toEqual(['JL', 'PR', '']);
    expect(avatars[2].querySelector('svg')).not.toBeNull();
  });

  it('K2c the owner avatar takes the real name\'s initials, never "You"; with no name the row reads "You"', () => {
    const { rerender, props } = setup({ owner: { id: 'u-dh', name: 'Daniel Haim', isYou: true } });
    const ownerRow = () => document.querySelector('[data-slot="sharing-owner"]') as HTMLElement;
    const ownerAvatar = () => ownerRow().querySelector('[data-slot="sharing-avatar"]');
    expect(rowNames()[0]).toBe('Daniel Haim (You)');
    expect(ownerAvatar()).toHaveTextContent('DH');
    expect(ownerAvatar()).not.toHaveTextContent('YO');
    expect(ownerRow().querySelector('.font-medium')).toHaveAttribute('title', 'Daniel Haim (You)');
    rerender(<SharingDialog {...props} owner={{ id: 'u-dh', name: '  ', isYou: true }} />);
    expect(rowNames()[0]).toBe('You');
    expect(ownerAvatar()).not.toHaveTextContent('YO');
  });

  it('K2b an owner who is not the viewer is named, and the transfer copy says who stays', () => {
    setup({ owner: { id: 'u-dh', name: 'Dana Holt', isYou: false }, onTransferOwnership: jest.fn() });
    expect(rowNames()[0]).toBe('Dana Holt');
    fireEvent.click(trigger(/^Access for Jordan Lee/));
    fireEvent.click(item(/^Make owner/));
    expect(screen.getByRole('group', { name: 'Make Jordan Lee the owner' })).toHaveTextContent(
      'Make Jordan Lee the owner? Dana Holt stays on the list with Can edit.'
    );
  });

  it('K3 Make owner: hidden without the callback, never on a role, and only the confirm transfers', async () => {
    const first = setup();
    fireEvent.click(trigger(/^Access for Jordan Lee/));
    expect(within(menu()).queryByRole('menuitem', { name: /Make owner/ })).toBeNull();
    first.unmount();

    const onTransferOwnership = jest.fn();
    const { props } = setup({ onTransferOwnership });
    fireEvent.click(trigger(/^Access for role Agents/));
    expect(within(menu()).queryByRole('menuitem', { name: /Make owner/ })).toBeNull();
    fireEvent.keyDown(menu(), { key: 'Escape' });

    fireEvent.click(trigger(/^Access for Jordan Lee/));
    fireEvent.click(item(/^Make owner…$/));
    const group = screen.getByRole('group', { name: 'Make Jordan Lee the owner' });
    expect(group).toHaveTextContent('Make Jordan Lee the owner? You stay on the list with Can edit.');
    expect(onTransferOwnership).not.toHaveBeenCalled();
    await settle();
    expect(within(group).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }));
    expect(onTransferOwnership).not.toHaveBeenCalled();
    await settle();
    expect(trigger(/^Access for Jordan Lee/)).toHaveFocus();

    fireEvent.click(trigger(/^Access for Jordan Lee/));
    fireEvent.click(item(/^Make owner…$/));
    fireEvent.click(within(screen.getByRole('group', { name: 'Make Jordan Lee the owner' })).getByRole('button', { name: 'Make owner' }));
    expect(onTransferOwnership).toHaveBeenCalledTimes(1);
    expect(onTransferOwnership).toHaveBeenCalledWith(JORDAN);
    expectNoCalls(props);
  });

  it('K4 Remove access asks first; Cancel calls nothing; only the confirm calls onRemove', async () => {
    const { props } = setup();
    fireEvent.click(trigger(/^Access for Priya Raman/));
    fireEvent.click(item(/^Remove access$/));
    const group = screen.getByRole('group', { name: 'Remove access for Priya Raman' });
    expect(group).toHaveTextContent('Remove access for Priya Raman?');
    expect(props.onRemove).not.toHaveBeenCalled();
    fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }));
    expect(props.onRemove).not.toHaveBeenCalled();
    await settle();
    expect(trigger(/^Access for Priya Raman/)).toHaveFocus();

    fireEvent.click(trigger(/^Access for Priya Raman/));
    fireEvent.click(item(/^Remove access$/));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Remove access for Priya Raman' })).getByRole('button', { name: 'Remove access' })
    );
    expect(props.onRemove).toHaveBeenCalledTimes(1);
    expect(props.onRemove).toHaveBeenCalledWith(PRIYA);
    expect(props.onGrant).not.toHaveBeenCalled();
    expect(props.onChangeLevel).not.toHaveBeenCalled();
  });

  it('K5 two people and one role picked: one onGrant with all three, then the field clears', () => {
    const { props } = setup();
    expect(screen.getByRole('button', { name: 'Share' })).toBeDisabled();
    pick('sam', /Sam Ortiz/);
    pick('tess', /Tess Wren/);
    pick('brok', /Role: Brokers/);
    expect(screen.getByRole('button', { name: 'Remove Sam Ortiz from the list' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Role: Brokers from the list' })).toBeInTheDocument();
    fireEvent.click(accessSelect());
    fireEvent.click(screen.getByRole('option', { name: /Can edit/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(props.onGrant).toHaveBeenCalledTimes(1);
    expect(props.onGrant).toHaveBeenCalledWith([SAM, TESS, BROKERS_ROLE], 'editor');
    expect(document.querySelectorAll('[data-slot="sharing-chip"]')).toHaveLength(0);
    expect(accessSelect()).toHaveTextContent('Can view');
    expect(screen.getByRole('button', { name: 'Share' })).toBeDisabled();
  });

  it('K5b a chip can be taken back off before sharing', () => {
    const { props } = setup();
    pick('sam', /Sam Ortiz/);
    pick('tess', /Tess Wren/);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sam Ortiz from the list' }));
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(props.onGrant).toHaveBeenCalledWith([TESS], 'viewer');
  });

  it('K5c people already on the list and the owner are not offered; the keyboard can add', () => {
    setup();
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    const offered = screen.getAllByRole('option').map((o) => o.textContent);
    expect(offered).toEqual(['Sam OrtizBroker', 'Tess WrenAdmin', 'Ava ChenAgent', 'Role: Brokers2 people']);
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(Array.from(document.querySelectorAll('[data-slot="sharing-chip"]')).map((c) => c.textContent)).toEqual([
      'Tess Wren',
    ]);
    fireEvent.keyDown(input(), { key: 'Backspace' });
    expect(document.querySelectorAll('[data-slot="sharing-chip"]')).toHaveLength(0);
  });

  it('K6 / C10 an agent row keeps its menu: Can edit and Make owner disabled, Remove access available', () => {
    const { props } = setup({ onTransferOwnership: jest.fn() });
    fireEvent.click(trigger(/^Access for Priya Raman: Can view$/));
    const canEdit = radio(/^Can edit/);
    expect(canEdit).toHaveAttribute('aria-disabled', 'true');
    expect(canEdit).toHaveTextContent('Not available for Priya Raman');
    fireEvent.click(canEdit);
    expect(props.onChangeLevel).not.toHaveBeenCalled();
    expect(menu()).toBeInTheDocument();
    expect(item(/^Make owner/)).toHaveAttribute('aria-disabled', 'true');
    const remove = item(/^Remove access$/);
    expect(remove).not.toHaveAttribute('aria-disabled');
    fireEvent.click(remove);
    expect(screen.getByRole('group', { name: 'Remove access for Priya Raman' })).toBeInTheDocument();
  });

  it('K6b a capped principal in the add field disables Can edit and resets the level to Can view', () => {
    const { props } = setup();
    fireEvent.click(accessSelect());
    fireEvent.click(screen.getByRole('option', { name: /Can edit/ }));
    expect(accessSelect()).toHaveTextContent('Can edit');
    pick('ava', /Ava Chen/);
    expect(accessSelect()).toHaveTextContent('Can view');
    fireEvent.click(accessSelect());
    expect(screen.getByRole('option', { name: /Can edit/ })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('option', { name: /Can edit/ }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(props.onGrant).toHaveBeenCalledWith([AVA], 'viewer');
  });

  it('K7 general access, the extra section and Copy link render only when given; Done closes', () => {
    const first = setup();
    expect(dialog()).not.toHaveTextContent('General access');
    expect(screen.queryByRole('button', { name: /Copy link/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(first.props.onOpenChange).toHaveBeenCalledWith(false);
    first.unmount();

    const onChange = jest.fn();
    const onCopyLink = jest.fn();
    setup({
      generalAccess: {
        value: 'restricted',
        onChange,
        options: [
          { value: 'restricted', label: 'Only people added', description: 'Only the people and roles listed above' },
          { value: 'organization', label: 'Everyone in Northside', description: 'Anyone in your organisation can view it' },
        ],
      },
      extraSection: { title: 'What each person sees', content: <p>Row scope goes here</p> },
      onCopyLink,
    });
    expect(dialog()).toHaveTextContent('General access');
    expect(dialog()).toHaveTextContent('Who can open it');
    expect(dialog()).toHaveTextContent('Only the people and roles listed above');
    expect(dialog()).toHaveTextContent('What each person sees');
    expect(screen.getByText('Row scope goes here')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Who can open it/ }));
    fireEvent.click(screen.getByRole('option', { name: /Everyone in Northside/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('organization');
    fireEvent.click(screen.getByRole('button', { name: /Copy link/ }));
    expect(onCopyLink).toHaveBeenCalledTimes(1);
  });

  it('K8 the dialog makes no data calls: no network or browser storage in any sharing source file', () => {
    const files = fs.readdirSync(__dirname).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f));
    expect(files.length).toBeGreaterThanOrEqual(5);
    const banned = /\bfetch\s*\(|supabase\.|\.rpc\(|localStorage|sessionStorage|XMLHttpRequest|indexedDB|window\.confirm/i;
    const offenders = files.filter((f) => banned.test(fs.readFileSync(path.join(__dirname, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('K9 Escape closes the menu first, then a confirm, then the dialog; focus returns to the trigger', async () => {
    const { props } = setup();
    fireEvent.click(trigger(/^Access for Jordan Lee/));
    await settle();
    expect(radio(/^Can edit/)).toHaveFocus();
    fireEvent.keyDown(radio(/^Can edit/), { key: 'ArrowDown' });
    expect(item(/^Remove access$/)).toHaveFocus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(props.onOpenChange).not.toHaveBeenCalled();
    await settle();
    expect(trigger(/^Access for Jordan Lee/)).toHaveFocus();

    fireEvent.click(trigger(/^Access for Jordan Lee/));
    fireEvent.click(item(/^Remove access$/));
    await settle();
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: /Remove access/ })).toBeNull();
    expect(props.onOpenChange).not.toHaveBeenCalled();

    fireEvent.change(input(), { target: { value: 's' } });
    expect(screen.getByRole('listbox', { name: 'Add people or roles' })).toBeInTheDocument();
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Add people or roles' })).toBeNull();
    expect(props.onOpenChange).not.toHaveBeenCalled();

    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expectNoCalls(props);
  });

  it('K9b the menu is a real menu: trigger states and roles', () => {
    setup();
    const t = trigger(/^Access for Jordan Lee/);
    expect(t).toHaveAttribute('aria-haspopup', 'menu');
    expect(t).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(t);
    expect(t).toHaveAttribute('aria-expanded', 'true');
    expect(menu()).toHaveAccessibleName('Access for Jordan Lee');
    expect(within(menu()).getAllByRole('menuitemradio')).toHaveLength(2);
    expect(within(menu()).getByRole('separator')).toBeInTheDocument();
    expect(document.querySelectorAll('button button')).toHaveLength(0);
  });

  it('K9c loading and refusal states', () => {
    setup({ candidates: null, entries: null, error: 'You can no longer share this report.' });
    expect(input()).toBeDisabled();
    expect(dialog()).toHaveTextContent('Loading…');
    expect(screen.getByRole('alert')).toHaveTextContent('You can no longer share this report.');
  });

  it('K9d the search placeholder defaults to "Name or role" and can be set', () => {
    const first = setup();
    expect(input()).toHaveAttribute('placeholder', 'Name or role');
    first.unmount();
    setup({ searchPlaceholder: 'Name, email or role' });
    expect(input()).toHaveAttribute('placeholder', 'Name, email or role');
  });

  it('R1 a pointer-down outside the row closes the menu without moving focus; the trigger still toggles', async () => {
    const { props } = setup();
    const t = trigger(/^Access for Jordan Lee/);
    fireEvent.pointerDown(t);
    fireEvent.click(t);
    expect(menu()).toBeInTheDocument();
    // A pointer-down inside the menu keeps it open.
    fireEvent.pointerDown(radio(/^Can view/));
    expect(menu()).toBeInTheDocument();
    // Pointer-down on another control: the menu closes and focus stays where the user put it.
    fireEvent.pointerDown(input());
    act(() => input().focus());
    expect(screen.queryByRole('menu')).toBeNull();
    await settle();
    expect(input()).toHaveFocus();
    // Pointer-down on plain text outside closes it too.
    fireEvent.click(t);
    expect(menu()).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByText('People with access', { selector: 'p' }));
    expect(screen.queryByRole('menu')).toBeNull();
    await settle();
    expect(t).not.toHaveFocus();
    // The trigger toggles: open, then a pointer-down + click on it closes.
    fireEvent.click(t);
    expect(menu()).toBeInTheDocument();
    fireEvent.pointerDown(t);
    fireEvent.click(t);
    expect(screen.queryByRole('menu')).toBeNull();
    expectNoCalls(props);
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  it('S1 a disabled Make owner says why', () => {
    setup({ onTransferOwnership: jest.fn() });
    fireEvent.click(trigger(/^Access for Priya Raman/));
    expect(item(/^Make owner/)).toHaveTextContent('Not available for Priya Raman');
  });

  it('S2 ArrowDown and ArrowUp on the trigger open the menu', async () => {
    setup();
    fireEvent.keyDown(trigger(/^Access for Jordan Lee/), { key: 'ArrowDown' });
    expect(menu()).toBeInTheDocument();
    await settle();
    expect(radio(/^Can edit/)).toHaveFocus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    fireEvent.keyDown(trigger(/^Access for Priya Raman/), { key: 'ArrowUp' });
    expect(menu()).toHaveAccessibleName('Access for Priya Raman');
  });

  it('S3 the combobox points at its list only while the list is open; the empty row is a disabled option', () => {
    setup({ candidates: [] });
    expect(input()).not.toHaveAttribute('aria-controls');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    const list = screen.getByRole('listbox', { name: 'Add people or roles' });
    expect(input()).toHaveAttribute('aria-controls', list.id);
    const empty = within(list).getByRole('option', { name: 'No one else to add' });
    expect(empty).toHaveAttribute('aria-disabled', 'true');
  });

  it('S4 after a confirmed Remove focus goes to the next row, or the add field after the last row', async () => {
    setup();
    fireEvent.click(trigger(/^Access for Priya Raman/));
    fireEvent.click(item(/^Remove access$/));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Remove access for Priya Raman' })).getByRole('button', { name: 'Remove access' })
    );
    await settle();
    expect(trigger(/^Access for role Agents/)).toHaveFocus();

    fireEvent.click(trigger(/^Access for role Agents/));
    fireEvent.click(item(/^Remove access$/));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Remove access for Role: Agents' })).getByRole('button', { name: 'Remove access' })
    );
    await settle();
    expect(input()).toHaveFocus();
  });

  // BACKLOG-3513 PR-6: a row write in flight. The adopter returns the write's promise.
  function deferred() {
    let resolve: () => void = () => undefined;
    let reject: (e: unknown) => void = () => undefined;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  function confirmRemove(name: string) {
    fireEvent.click(trigger(new RegExp(`^Access for ${name}: `)));
    fireEvent.click(item(/^Remove access$/));
    fireEvent.click(within(screen.getByRole('group', { name: `Remove access for ${name}` })).getByRole('button', { name: 'Remove access' }));
  }
  const rowTrigger = (name: string) => screen.queryByRole('button', { name: new RegExp(`^Access for ${name}: `) });

  it('W1 remove in flight: the row reads Removing…, its menu is disabled, and no second remove can start', async () => {
    const d = deferred();
    const onRemove = jest.fn(() => d.promise);
    setup({ onRemove });
    confirmRemove('Jordan Lee');
    expect(onRemove).toHaveBeenCalledTimes(1);
    const t = rowTrigger('Jordan Lee')!;
    expect(t).toHaveAccessibleName('Access for Jordan Lee: Removing…');
    expect(t).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(t);
    fireEvent.keyDown(t, { key: 'ArrowDown' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Remove access for Jordan Lee' })).toBeNull();
    expect(onRemove).toHaveBeenCalledTimes(1);
    await act(async () => d.reject(new Error('refused')));
  });

  it('W2 remove succeeds: the row leaves at once, before the next entries; the next entries are the truth', async () => {
    const d = deferred();
    const onRemove = jest.fn(() => d.promise);
    const { rerender, props } = setup({ onRemove });
    confirmRemove('Jordan Lee');
    await act(async () => d.resolve());
    expect(rowTrigger('Jordan Lee')).toBeNull();
    expect(rowNames()).toEqual(['Dana Holt (You)', 'Priya Raman', 'Role: Agents']);
    // Same entries array (a re-render, not a read): still gone.
    rerender(<SharingDialog {...props} onRemove={onRemove} />);
    expect(rowTrigger('Jordan Lee')).toBeNull();
    // A new array with the same content (a stale read, or a parent that rebuilds it): still gone.
    rerender(<SharingDialog {...props} onRemove={onRemove} entries={[...ENTRIES]} />);
    expect(rowTrigger('Jordan Lee')).toBeNull();
    // A read without Jordan confirms the remove ...
    rerender(<SharingDialog {...props} onRemove={onRemove} entries={[PRIYA, AGENTS_ROLE]} />);
    expect(rowTrigger('Jordan Lee')).toBeNull();
    // ... and clears it: a later read that lists Jordan (granted again elsewhere) shows the row.
    rerender(<SharingDialog {...props} onRemove={onRemove} entries={[...ENTRIES]} />);
    expect(rowTrigger('Jordan Lee')).toHaveAccessibleName('Access for Jordan Lee: Can edit');
  });

  it('W6 a level change survives a stale entries with the old level; a read with the new level confirms it', async () => {
    const d = deferred();
    const onChangeLevel = jest.fn(() => d.promise);
    const { rerender, props } = setup({ onChangeLevel });
    fireEvent.click(rowTrigger('Jordan Lee')!);
    fireEvent.click(radio(/^Can view/));
    await act(async () => d.resolve());
    expect(rowTrigger('Jordan Lee')).toHaveAccessibleName('Access for Jordan Lee: Can view');
    rerender(<SharingDialog {...props} onChangeLevel={onChangeLevel} entries={[...ENTRIES]} />);
    expect(rowTrigger('Jordan Lee')).toHaveAccessibleName('Access for Jordan Lee: Can view');
    rerender(<SharingDialog {...props} onChangeLevel={onChangeLevel} entries={[{ ...JORDAN, level: 'viewer' }, PRIYA, AGENTS_ROLE]} />);
    expect(rowTrigger('Jordan Lee')).toHaveAccessibleName('Access for Jordan Lee: Can view');
    // Confirmed and cleared: a later read is shown as it is.
    rerender(<SharingDialog {...props} onChangeLevel={onChangeLevel} entries={[...ENTRIES]} />);
    expect(rowTrigger('Jordan Lee')).toHaveAccessibleName('Access for Jordan Lee: Can edit');
  });

  it('W7 a removed person can be granted again, and the row comes back', async () => {
    const d = deferred();
    const onRemove = jest.fn(() => d.promise);
    const { props } = setup({ onRemove });
    confirmRemove('Jordan Lee');
    await act(async () => d.resolve());
    expect(rowTrigger('Jordan Lee')).toBeNull();
    pick('jordan', /Jordan Lee/);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(props.onGrant).toHaveBeenCalledWith([expect.objectContaining({ id: 'u-jl', kind: 'person' })], 'viewer');
    expect(rowTrigger('Jordan Lee')).toHaveAccessibleName('Access for Jordan Lee: Can edit');
  });

  it('W8 a read that lands while a remove is in flight keeps the row pending', async () => {
    const d = deferred();
    const onRemove = jest.fn(() => d.promise);
    const { rerender, props } = setup({ onRemove });
    confirmRemove('Jordan Lee');
    rerender(<SharingDialog {...props} onRemove={onRemove} entries={[...ENTRIES]} />);
    expect(rowTrigger('Jordan Lee')).toHaveAccessibleName('Access for Jordan Lee: Removing…');
    expect(rowTrigger('Jordan Lee')).toHaveAttribute('aria-disabled', 'true');
    await act(async () => d.resolve());
    expect(rowTrigger('Jordan Lee')).toBeNull();
  });

  it('W3 remove refused: the row comes back as it was, menu usable', async () => {
    const d = deferred();
    setup({ onRemove: jest.fn(() => d.promise) });
    confirmRemove('Jordan Lee');
    await act(async () => d.reject(new Error('refused')));
    const t = rowTrigger('Jordan Lee')!;
    expect(t).toHaveAccessibleName('Access for Jordan Lee: Can edit');
    expect(t).not.toHaveAttribute('aria-disabled');
    fireEvent.click(t);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('W4 level change: Saving… and disabled while in flight; the new level on success; unchanged on refusal', async () => {
    const ok = deferred();
    const onChangeLevel = jest.fn(() => ok.promise);
    const { unmount } = setup({ onChangeLevel });
    fireEvent.click(rowTrigger('Jordan Lee')!);
    fireEvent.click(radio(/^Can view/));
    const t = rowTrigger('Jordan Lee')!;
    expect(t).toHaveAccessibleName('Access for Jordan Lee: Saving…');
    expect(t).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(t);
    expect(screen.queryByRole('menu')).toBeNull();
    await act(async () => ok.resolve());
    expect(rowTrigger('Jordan Lee')).toHaveAccessibleName('Access for Jordan Lee: Can view');
    expect(onChangeLevel).toHaveBeenCalledTimes(1);
    unmount();

    const no = deferred();
    setup({ onChangeLevel: jest.fn(() => no.promise) });
    fireEvent.click(rowTrigger('Jordan Lee')!);
    fireEvent.click(radio(/^Can view/));
    await act(async () => no.reject(new Error('refused')));
    expect(rowTrigger('Jordan Lee')).toHaveAccessibleName('Access for Jordan Lee: Can edit');
    expect(rowTrigger('Jordan Lee')).not.toHaveAttribute('aria-disabled');
  });

  it('W5 an adopter that returns nothing keeps today\'s behaviour: no pending, the row waits for the next entries', () => {
    setup({ onRemove: jest.fn() });
    confirmRemove('Jordan Lee');
    expect(rowTrigger('Jordan Lee')).toHaveAccessibleName('Access for Jordan Lee: Can edit');
  });

  it('K10 SharingDialog is exported from the package index', () => {
    expect(SharingDialogFromIndex).toBe(SharingDialog);
  });
});
