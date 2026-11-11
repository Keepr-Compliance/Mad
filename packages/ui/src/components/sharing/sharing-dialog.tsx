'use client';

import * as React from 'react';
import { ChevronDown, Link as LinkIcon, Lock } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from '../button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../dialog';
import { Dropdown } from '../dropdown';
import type { DropdownOption } from '../dropdown/types';
import { AccessMenu, type AccessMenuItem } from './access-menu';
import { PrincipalPicker } from './principal-picker';
import { SharingAvatar, displayName, principalKey } from './sharing-avatar';
import type { SharingDialogProps, SharingEntry, SharingLevel, SharingLevelOption, SharingPrincipal } from './types';

/**
 * SharingDialog (BACKLOG-3513 PR-1): one generic "Share" dialog for anything
 * with an owner, people and roles. It knows nothing about reports or views.
 *
 * Built on the kit Dialog (Radix: focus trap, Escape, aria-modal, focus
 * return to the opener) and the kit Dropdown. It makes NO
 * data calls: the adopter feeds `candidates` (from a server-side function
 * scoped to the item and the caller, never a full user list), `entries`,
 * `owner` and `error`, and performs every write in the callbacks.
 *
 * - The owner row comes first, reads "Owner" and has no menu.
 * - Every other row has an access menu: the levels (Can view / Can edit),
 *   then "Make owner…" (people only, only with `onTransferOwnership`) and
 *   "Remove access". Picking the level a row already has calls nothing.
 * - Levels above a principal's `maxLevel` are disabled, in the menu and in
 *   the Access select while such a principal is picked; so is "Make owner…".
 *   Remove access is always available.
 * - Remove and Make owner ask first, inline in the row. Only the confirm
 *   calls the callback.
 * - Escape closes the innermost thing first: an open menu or list, then a
 *   confirm, then the dialog.
 * - Hiding or disabling controls is presentation only. The server functions
 *   decide who may share, and refuse everyone else.
 */

export const DEFAULT_SHARING_LEVELS: readonly SharingLevelOption[] = [
  { value: 'viewer', label: 'Can view', description: 'Opens it' },
  { value: 'editor', label: 'Can edit', description: 'Also changes it for everyone' },
];

const DEFAULT_DESCRIPTION = 'People you add can open it. Edits show for everyone.';
const DEFAULT_SEARCH_PLACEHOLDER = 'Name or role';
const ORDER: Record<SharingLevel, number> = { viewer: 0, editor: 1 };

function allowed(level: SharingLevel, maxLevel: SharingLevel | undefined): boolean {
  return maxLevel === undefined || ORDER[level] <= ORDER[maxLevel];
}

/** Refocus target meaning the add field rather than a row trigger. */
/**
 * The owner row's name: "<name> (You)" when the viewer is the owner, the name otherwise, and
 * "You" when the viewer is the owner and no name is known. The avatar always takes the initials
 * of `owner.name` itself, never of this label.
 */
export function ownerLabel(owner: { name: string; isYou?: boolean }): string {
  const name = owner.name.trim();
  if (!owner.isYou) return name;
  return name.length > 0 ? `${name} (You)` : 'You';
}

const ADD_FIELD = '#add';

type Confirm = { kind: 'remove' | 'owner'; key: string } | null;

export function SharingDialog({
  open,
  onOpenChange,
  name,
  description = DEFAULT_DESCRIPTION,
  levels = DEFAULT_SHARING_LEVELS,
  candidates,
  entries,
  owner,
  error,
  searchPlaceholder = DEFAULT_SEARCH_PLACEHOLDER,
  onGrant,
  onChangeLevel,
  onRemove,
  onTransferOwnership,
  generalAccess,
  extraSection,
  onCopyLink,
}: SharingDialogProps) {
  const firstLevel = levels[0]?.value ?? 'viewer';
  const [chips, setChips] = React.useState<SharingPrincipal[]>([]);
  const [level, setLevel] = React.useState<SharingLevel>(firstLevel);
  const [menuFor, setMenuFor] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<Confirm>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const confirmCancelRef = React.useRef<HTMLButtonElement>(null);
  const addInputId = `${React.useId()}-add`;
  /** The row whose menu is open: pointer-down outside it closes the menu. */
  const openRowRef = React.useRef<HTMLDivElement>(null);
  /** Row whose menu trigger gets focus back after a menu or confirm closes. */
  const [refocus, setRefocus] = React.useState<string | null>(null);
  /** Rows with a write in flight (adopter returned a promise): what kind, for the pending label. */
  const [busy, setBusy] = React.useState<ReadonlyMap<string, 'remove' | 'level'>>(new Map());
  /** Rows whose remove succeeded and levels whose change succeeded, until the next `entries`. */
  const [gone, setGone] = React.useState<ReadonlySet<string>>(new Set());
  const [levelNow, setLevelNow] = React.useState<ReadonlyMap<string, SharingLevel>>(new Map());

  // Reconcile by confirmation, not by identity: an `entries` that no longer lists a removed row
  // confirms the remove; one that shows the new level confirms the change. A stale read (still
  // listing the row, or the old level) or a re-render with an equal new array changes nothing.
  // `busy` is untouched here: only the write settling clears it.
  React.useEffect(() => {
    if (entries === null) return;
    const levels = new Map(entries.map((e) => [principalKey(e), e.level] as const));
    setGone((prev) => {
      const next = new Set(Array.from(prev).filter((k) => levels.has(k)));
      return next.size === prev.size ? prev : next;
    });
    setLevelNow((prev) => {
      const next = new Map(Array.from(prev).filter(([k, to]) => levels.has(k) && levels.get(k) !== to));
      return next.size === prev.size ? prev : next;
    });
  }, [entries]);

  /**
   * Run one row write. A promise from the adopter marks the row busy until it settles; success
   * applies `onOk` (hide the row / show the level); failure leaves the row as it was.
   */
  function track(key: string, kind: 'remove' | 'level', result: void | Promise<unknown>, onOk: () => void) {
    if (!result || typeof (result as Promise<unknown>).then !== 'function') return;
    setBusy((prev) => new Map(prev).set(key, kind));
    const done = () =>
      setBusy((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    (result as Promise<unknown>).then(
      () => {
        done();
        onOk();
      },
      () => done()
    );
  }

  // A closed dialog forgets its picks, menus, confirms and what it assumed after a write.
  React.useEffect(() => {
    if (open) return;
    setChips([]);
    setLevel(firstLevel);
    setMenuFor(null);
    setConfirm(null);
    setGone(new Set());
    setLevelNow(new Map());
  }, [open, firstLevel]);

  React.useEffect(() => {
    if (confirm !== null) confirmCancelRef.current?.focus();
  }, [confirm]);

  React.useEffect(() => {
    if (refocus === null) return;
    if (refocus === ADD_FIELD) {
      document.getElementById(addInputId)?.focus();
      setRefocus(null);
      return;
    }
    const triggers = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-menu-for]') ?? [];
    Array.from(triggers).find((b) => b.dataset.menuFor === refocus)?.focus();
    setRefocus(null);
  }, [refocus, addInputId]);

  // What the list shows: `entries` less rows whose remove succeeded, with levels whose change
  // succeeded, until the adopter's next read replaces them.
  const visible = React.useMemo(
    () =>
      entries === null
        ? null
        : entries
            .filter((e) => !gone.has(principalKey(e)))
            .map((e) => {
              const to = levelNow.get(principalKey(e));
              return to === undefined || to === e.level ? e : { ...e, level: to };
            }),
    [entries, gone, levelNow]
  );

  const levelLabel = (value: SharingLevel) => levels.find((l) => l.value === value)?.label ?? value;
  const editorLabel = levelLabel('editor');

  const exclude = React.useMemo(() => {
    // A removed row (hidden) may be picked again.
    const keys = new Set((visible ?? []).map(principalKey));
    if (owner) keys.add(principalKey({ kind: 'person', id: owner.id }));
    return keys;
  }, [visible, owner]);

  const levelOptions: DropdownOption<SharingLevel>[] = levels.map((l) => {
    const blockedBy = chips.find((c) => !allowed(l.value, c.maxLevel));
    return {
      value: l.value,
      label: l.label,
      description: l.description,
      disabled: blockedBy !== undefined,
      hint: blockedBy ? `Not available for ${displayName(blockedBy)}` : undefined,
    };
  });

  function addChip(p: SharingPrincipal) {
    setChips((prev) => (prev.some((c) => principalKey(c) === principalKey(p)) ? prev : [...prev, p]));
    if (!allowed(level, p.maxLevel)) setLevel(p.maxLevel ?? firstLevel);
  }

  function share() {
    if (chips.length === 0) return;
    // Granting a removed principal again brings the row back (the next read sets its level).
    const granted = new Set(chips.map(principalKey));
    setGone((prev) => (Array.from(prev).some((k) => granted.has(k)) ? new Set(Array.from(prev).filter((k) => !granted.has(k))) : prev));
    onGrant(chips, level);
    setChips([]);
    setLevel(firstLevel);
  }

  function closeMenu(restoreFocus: boolean) {
    const key = menuFor;
    setMenuFor(null);
    if (restoreFocus && key !== null) setRefocus(key);
  }

  function cancelConfirm() {
    const key = confirm?.key ?? null;
    setConfirm(null);
    if (key !== null) setRefocus(key);
  }

  function menuItems(entry: SharingEntry): AccessMenuItem[] {
    const key = principalKey(entry);
    const items: AccessMenuItem[] = levels.map((l) => ({
      kind: 'radio',
      key: `level-${l.value}`,
      label: l.label,
      description: l.description,
      checked: entry.level === l.value,
      disabled: !allowed(l.value, entry.maxLevel),
      hint: `Not available for ${displayName(entry)}`,
      onSelect: () => {
        closeMenu(true);
        if (busy.has(key) || entry.level === l.value) return;
        const to = l.value;
        track(key, 'level', onChangeLevel(entry, to), () => setLevelNow((prev) => new Map(prev).set(key, to)));
      },
    }));
    items.push({ kind: 'separator', key: 'sep' });
    if (onTransferOwnership && entry.kind === 'person') {
      items.push({
        kind: 'action',
        key: 'owner',
        label: 'Make owner…',
        disabled: !allowed('editor', entry.maxLevel),
        hint: `Not available for ${displayName(entry)}`,
        onSelect: () => {
          setMenuFor(null);
          setConfirm({ kind: 'owner', key });
        },
      });
    }
    items.push({
      kind: 'action',
      key: 'remove',
      label: 'Remove access',
      tone: 'danger',
      onSelect: () => {
        setMenuFor(null);
        setConfirm({ kind: 'remove', key });
      },
    });
    return items;
  }

  const stayCopy = owner && !owner.isYou ? `${owner.name} stays` : 'You stay';

  function renderEntry(entry: SharingEntry) {
    const key = principalKey(entry);
    const shown = displayName(entry);
    const forWhom = entry.kind === 'role' ? `role ${entry.name}` : entry.name;
    if (confirm?.key === key && confirm.kind === 'remove') {
      return (
        <div
          role="group"
          aria-label={`Remove access for ${shown}`}
          className="flex flex-wrap items-center gap-2 rounded-md bg-danger-50 px-2.5 py-2"
        >
          <span className="min-w-0 flex-1 text-sm text-danger-700">Remove access for {shown}?</span>
          <Button ref={confirmCancelRef} type="button" variant="ghost" size="sm" onClick={cancelConfirm}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => {
              // No second remove while one is in flight: this confirm unmounts on click, and the
              // row's menu (the only way back to it) is disabled until the write settles.
              // Focus moves to the next row's trigger, or the add field when this was the last row.
              const list = visible ?? [];
              const at = list.findIndex((e) => principalKey(e) === key);
              const next = at >= 0 && at + 1 < list.length ? principalKey(list[at + 1]) : ADD_FIELD;
              setConfirm(null);
              setRefocus(next);
              track(key, 'remove', onRemove(entry), () => setGone((prev) => new Set(prev).add(key)));
            }}
          >
            Remove access
          </Button>
        </div>
      );
    }
    if (confirm?.key === key && confirm.kind === 'owner' && onTransferOwnership) {
      return (
        <div
          role="group"
          aria-label={`Make ${shown} the owner`}
          className="flex flex-col gap-2 rounded-md bg-warning-50 px-3 py-2.5"
        >
          <span className="text-sm text-warning-800">
            Make {shown} the owner? {stayCopy} on the list with {editorLabel}.
          </span>
          <div className="flex justify-end gap-2">
            <Button ref={confirmCancelRef} type="button" variant="ghost" size="sm" onClick={cancelConfirm}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setConfirm(null);
                onTransferOwnership(entry);
              }}
            >
              Make owner
            </Button>
          </div>
        </div>
      );
    }
    const pending = busy.get(key);
    const menuOpen = menuFor === key && !pending;
    const menuId = `sharing-menu-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    const pendingLabel = pending === 'remove' ? 'Removing…' : pending === 'level' ? 'Saving…' : null;
    return (
      <div ref={menuOpen ? openRowRef : undefined} aria-busy={pending ? true : undefined}>
        <div className="flex items-center gap-3 py-2">
          <SharingAvatar kind={entry.kind} name={entry.name} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium text-gray-900" title={shown}>
              {shown}
            </span>
            {entry.detail ? <span className="truncate text-xs text-gray-500">{entry.detail}</span> : null}
          </span>
          <button
            type="button"
            data-menu-for={key}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            aria-label={`Access for ${forWhom}: ${pendingLabel ?? levelLabel(entry.level)}`}
            aria-disabled={pending ? true : undefined}
            onClick={() => {
              if (pending) return;
              setMenuFor(menuOpen ? null : key);
            }}
            onKeyDown={(e) => {
              if (pending) return;
              if (!menuOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();
                setMenuFor(key);
              }
            }}
            className={cn(
              'flex h-8 flex-shrink-0 items-center gap-1 rounded-md border pl-2.5 pr-2 text-sm text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
              menuOpen ? 'border-gray-300 bg-gray-100' : 'border-transparent hover:bg-gray-100',
              pending && 'cursor-wait text-gray-500 hover:bg-transparent'
            )}
          >
            {pendingLabel ?? levelLabel(entry.level)}
            <ChevronDown className={cn('h-4 w-4 text-gray-500', menuOpen && 'rotate-180')} aria-hidden="true" />
          </button>
        </div>
        {menuOpen ? (
          <div className="flex justify-end pb-2">
            <AccessMenu
              id={menuId}
              ariaLabel={`Access for ${forWhom}`}
              items={menuItems(entry)}
              onClose={closeMenu}
              containerRef={openRowRef}
            />
          </div>
        ) : null}
      </div>
    );
  }

  const selectedGeneral = generalAccess?.options.find((o) => o.value === generalAccess.value);
  const generalLabel = generalAccess?.label ?? 'Who can open it';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="sharing-dialog"
        className="max-h-[90vh] gap-5 overflow-y-auto sm:max-w-[560px]"
        onEscapeKeyDown={(e) => {
          if (confirm !== null) {
            e.preventDefault();
            cancelConfirm();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="truncate pr-6">Share “{name}”</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <PrincipalPicker
            label="Add people or roles"
            placeholder={searchPlaceholder}
            candidates={candidates}
            exclude={exclude}
            chips={chips}
            onAdd={addChip}
            inputId={addInputId}
            onRemoveChip={(p) => setChips((prev) => prev.filter((c) => principalKey(c) !== principalKey(p)))}
          />
          <div className="sm:w-32">
            <Dropdown<SharingLevel>
              label="Access"
              options={levelOptions}
              value={level}
              onChange={setLevel}
              searchable={false}
            />
          </div>
          <Button type="button" onClick={share} disabled={chips.length === 0}>
            Share
          </Button>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-danger-600">
            {error}
          </p>
        ) : null}

        <div className="flex flex-col gap-1">
          <p className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500">People with access</p>
          {visible === null ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : visible.length === 0 && !owner ? (
            <p className="text-sm text-gray-500">Only you</p>
          ) : (
            <ul ref={listRef} aria-label="People with access" className="flex flex-col divide-y divide-gray-100">
              {owner ? (
                <li data-slot="sharing-owner" className="flex items-center gap-3 py-2">
                  <SharingAvatar kind="person" name={owner.name} tone="owner" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium text-gray-900" title={ownerLabel(owner)}>
                      {ownerLabel(owner)}
                    </span>
                    {owner.detail ? <span className="truncate text-xs text-gray-500">{owner.detail}</span> : null}
                  </span>
                  <span className="px-2.5 text-sm text-gray-600">Owner</span>
                </li>
              ) : null}
              {visible.map((entry) => (
                <li key={principalKey(entry)} data-slot="sharing-entry">
                  {renderEntry(entry)}
                </li>
              ))}
            </ul>
          )}
        </div>

        {generalAccess ? (
          <div data-slot="sharing-general" className="flex flex-col gap-2 border-t border-gray-200 pt-4">
            <p className="text-xs font-medium uppercase tracking-wider text-gray-500">General access</p>
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-700"
              >
                <Lock className="h-4 w-4" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-gray-900">{generalLabel}</span>
                {selectedGeneral?.description ? (
                  <span className="text-xs text-gray-500">{selectedGeneral.description}</span>
                ) : null}
              </div>
              <div className="w-48 flex-shrink-0">
                <Dropdown
                  ariaLabel={generalLabel}
                  options={generalAccess.options}
                  value={generalAccess.value}
                  onChange={(v) => {
                    if (v !== generalAccess.value) generalAccess.onChange(v);
                  }}
                  disabled={generalAccess.disabled}
                  searchable={false}
                />
              </div>
            </div>
          </div>
        ) : null}

        {extraSection ? (
          <div data-slot="sharing-extra" className="flex flex-col gap-2 border-t border-gray-200 pt-4">
            <p className="text-xs font-medium uppercase tracking-wider text-gray-500">{extraSection.title}</p>
            {extraSection.content}
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-3 border-t border-gray-200 pt-4">
          {onCopyLink ? (
            <Button type="button" variant="secondary" onClick={onCopyLink}>
              <LinkIcon className="h-4 w-4" aria-hidden="true" />
              Copy link
            </Button>
          ) : (
            <span />
          )}
          <Button type="button" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
