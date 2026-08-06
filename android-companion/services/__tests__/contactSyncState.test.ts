/**
 * BACKLOG-2208 — contact diff state.
 *
 * Pins the core "send only new/changed" behavior:
 *   - first run (no fingerprints) => FULL sync, everything sent;
 *   - a second sync with nothing changed => 0 to send;
 *   - a brand-new contact => only it is sent;
 *   - an edited contact (name / number / email) => only it is sent;
 *   - the periodic 24h re-sync forces a FULL send while reporting 0 new;
 *   - fingerprints persist across calls and reset() clears them (=> full again);
 *   - commit happens only on the caller's success path (nothing persisted until
 *     commitContactSync is called).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SyncContact } from '../../types/contacts';

// Stateful in-memory AsyncStorage (same rationale as the other service tests).
jest.mock('@react-native-async-storage/async-storage', () => {
  let store: Record<string, string> = {};
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (k: string) => (k in store ? store[k] : null)),
      setItem: jest.fn(async (k: string, v: string) => {
        store[k] = v;
      }),
      removeItem: jest.fn(async (k: string) => {
        delete store[k];
      }),
      __reset: () => {
        store = {};
      },
    },
  };
});
const resetStore = (): void =>
  (AsyncStorage as unknown as { __reset: () => void }).__reset();

import {
  computeContactDiff,
  commitContactSync,
  resetContactSyncState,
  forceFullContactResync,
  fingerprintContact,
  setContactDiffSupported,
  isContactDiffSupported,
  FULL_RESYNC_INTERVAL_MS,
} from '../contactSyncState';

function contact(
  id: string,
  overrides: Partial<SyncContact> = {},
): SyncContact {
  return {
    id,
    displayName: `Name ${id}`,
    phones: [{ number: `+1555000${id.padStart(4, '0')}` }],
    emails: [],
    ...overrides,
  };
}

function idSet(contacts: SyncContact[]): Set<string> {
  return new Set(contacts.map((c) => c.id));
}

/** Simulate one successful cycle: diff -> (send) -> commit. Returns the diff. */
async function syncCycle(
  current: SyncContact[],
  now: number,
): Promise<{ toSend: SyncContact[]; isFullSync: boolean; newOrChanged: number }> {
  const diff = await computeContactDiff(current, now);
  await commitContactSync(current, diff.toSend, diff.isFullSync, now);
  return diff;
}

const T0 = 1_000_000_000_000; // fixed base clock

beforeEach(() => {
  resetStore();
  jest.clearAllMocks();
});

describe('computeContactDiff — first run', () => {
  it('is a FULL sync that sends every contact when nothing has been synced', async () => {
    const all = [contact('1'), contact('2'), contact('3')];

    const diff = await computeContactDiff(all, T0);

    expect(diff.isFullSync).toBe(true);
    expect(idSet(diff.toSend)).toEqual(idSet(all));
    // On a first run every contact is genuinely new.
    expect(diff.newOrChanged).toBe(3);
  });
});

describe('computeContactDiff — steady state (the core fix)', () => {
  it('sends 0 contacts on a second sync when NOTHING changed', async () => {
    const all = [contact('1'), contact('2'), contact('3')];

    // First cycle: full send + commit.
    await syncCycle(all, T0);

    // Second cycle shortly after: identical address book.
    const diff = await computeContactDiff(all, T0 + 60_000);

    expect(diff.isFullSync).toBe(false);
    expect(diff.toSend).toHaveLength(0);
    expect(diff.newOrChanged).toBe(0);
  });

  it('sends ONLY the new contact when one is added', async () => {
    const initial = [contact('1'), contact('2')];
    await syncCycle(initial, T0);

    const withNew = [...initial, contact('3')];
    const diff = await computeContactDiff(withNew, T0 + 60_000);

    expect(diff.isFullSync).toBe(false);
    expect(idSet(diff.toSend)).toEqual(new Set(['3']));
    expect(diff.newOrChanged).toBe(1);
  });

  it.each([
    ['name', { displayName: 'Renamed' }],
    ['number', { phones: [{ number: '+19998887777' }] }],
    ['email', { emails: [{ address: 'new@example.com' }] }],
  ])('sends ONLY the edited contact when its %s changes', async (_label, edit) => {
    const initial = [contact('1'), contact('2'), contact('3')];
    await syncCycle(initial, T0);

    const edited = [
      initial[0],
      { ...initial[1], ...(edit as Partial<SyncContact>) },
      initial[2],
    ];
    const diff = await computeContactDiff(edited, T0 + 60_000);

    expect(diff.isFullSync).toBe(false);
    expect(idSet(diff.toSend)).toEqual(new Set(['2']));
    expect(diff.newOrChanged).toBe(1);
  });

  it('does NOT re-send when only a phone LABEL changes (value is unchanged)', async () => {
    const initial = [
      contact('1', { phones: [{ number: '+15555550130', label: 'mobile' }] }),
    ];
    await syncCycle(initial, T0);

    const relabeled = [
      contact('1', { phones: [{ number: '+15555550130', label: 'work' }] }),
    ];
    const diff = await computeContactDiff(relabeled, T0 + 60_000);

    expect(diff.toSend).toHaveLength(0);
    expect(diff.newOrChanged).toBe(0);
  });
});

describe('computeContactDiff — periodic full re-sync', () => {
  it('forces a FULL send after the 24h interval, reporting 0 new when nothing changed', async () => {
    const all = [contact('1'), contact('2')];
    await syncCycle(all, T0);

    // Just before the interval: still a partial (nothing changed => 0 sent).
    const before = await computeContactDiff(all, T0 + FULL_RESYNC_INTERVAL_MS - 1);
    expect(before.isFullSync).toBe(false);
    expect(before.toSend).toHaveLength(0);

    // At/after the interval: full re-send of everything, but 0 genuinely new.
    const after = await computeContactDiff(all, T0 + FULL_RESYNC_INTERVAL_MS);
    expect(after.isFullSync).toBe(true);
    expect(idSet(after.toSend)).toEqual(idSet(all));
    expect(after.newOrChanged).toBe(0);
  });
});

describe('commitContactSync', () => {
  it('does NOT persist anything until commit (a failed send re-sends next cycle)', async () => {
    const all = [contact('1'), contact('2')];

    // Diff without committing (simulating a send that failed).
    await computeContactDiff(all, T0);

    // Next cycle still sees everything as new — nothing was persisted.
    const diff = await computeContactDiff(all, T0 + 60_000);
    expect(diff.isFullSync).toBe(true); // map still empty => full
    expect(idSet(diff.toSend)).toEqual(idSet(all));
  });

  it('a full commit DROPS fingerprints for contacts no longer on the device', async () => {
    const initial = [contact('1'), contact('2'), contact('3')];
    await syncCycle(initial, T0);

    // Contact 2 is deleted on the phone; trigger a full re-sync (>24h).
    const remaining = [contact('1'), contact('3')];
    await syncCycle(remaining, T0 + FULL_RESYNC_INTERVAL_MS);

    // Re-add a contact reusing id '2' shortly after: it must look NEW again,
    // proving the stale fingerprint for '2' was dropped by the full commit.
    const readded = [...remaining, contact('2')];
    const diff = await computeContactDiff(readded, T0 + FULL_RESYNC_INTERVAL_MS + 60_000);
    expect(idSet(diff.toSend)).toEqual(new Set(['2']));
  });
});

describe('resetContactSyncState', () => {
  it('clears fingerprints so the next sync is a FULL send again (re-pair)', async () => {
    const all = [contact('1'), contact('2')];
    await syncCycle(all, T0);

    await resetContactSyncState();

    const diff = await computeContactDiff(all, T0 + 60_000);
    expect(diff.isFullSync).toBe(true);
    expect(idSet(diff.toSend)).toEqual(idSet(all));
    expect(diff.newOrChanged).toBe(2);
  });
});

describe('fingerprintContact', () => {
  it('is stable across phone/email ordering and identical for identical content', () => {
    const a = contact('1', {
      phones: [{ number: '+111' }, { number: '+222' }],
      emails: [{ address: 'A@x.com' }, { address: 'b@x.com' }],
    });
    const bReordered = contact('1', {
      phones: [{ number: '+222' }, { number: '+111' }],
      emails: [{ address: 'b@x.com' }, { address: 'a@x.com' }], // case-insensitive
    });

    expect(fingerprintContact(a)).toBe(fingerprintContact(bReordered));
  });

  it('changes when a synced field changes', () => {
    const a = contact('1');
    const b = contact('1', { company: 'Acme' });
    expect(fingerprintContact(a)).not.toBe(fingerprintContact(b));
  });
});

describe('computeContactDiff — forceFull (desktop lacks contactDiff support)', () => {
  it('forces a FULL send even when a diff exists, but still reports the real new count', async () => {
    const initial = [contact('1'), contact('2')];
    await syncCycle(initial, T0); // seed fingerprints

    // Contact 3 added: a normal diff would send ONLY 3. forceFull must send all.
    const withNew = [...initial, contact('3')];
    const diff = await computeContactDiff(withNew, T0 + 60_000, /* forceFull */ true);

    expect(diff.isFullSync).toBe(true);
    expect(idSet(diff.toSend)).toEqual(new Set(['1', '2', '3']));
    // Genuine new/changed count is preserved for the "New Contacts" stat.
    expect(diff.newOrChanged).toBe(1);
  });
});

describe('contactDiff capability (BACKLOG-2208 register handshake)', () => {
  it('defaults to false (fail-safe: send full until a desktop confirms support)', async () => {
    expect(await isContactDiffSupported()).toBe(false);
  });

  it('persists true/false and survives across reads (app restart)', async () => {
    await setContactDiffSupported(true);
    expect(await isContactDiffSupported()).toBe(true);

    await setContactDiffSupported(false);
    expect(await isContactDiffSupported()).toBe(false);
  });

  it('is cleared by resetContactSyncState (unpair) — back to fail-safe false', async () => {
    await setContactDiffSupported(true);
    expect(await isContactDiffSupported()).toBe(true);

    await resetContactSyncState();

    expect(await isContactDiffSupported()).toBe(false);
  });
});

describe('forceFullContactResync (BACKLOG-2210 — deviceId adoption)', () => {
  beforeEach(() => resetStore());

  it('forces the NEXT sync to be FULL by clearing the fingerprint map', async () => {
    const now = 1_000_000;
    // Establish a steady state: full sync then a no-op cycle (partial, 0 to send).
    await syncCycle([contact('1'), contact('2')], now);
    const steady = await computeContactDiff([contact('1'), contact('2')], now + 1);
    expect(steady.isFullSync).toBe(false);

    // Adopt a new deviceId → force a full re-key on the next cycle.
    await forceFullContactResync();

    const next = await computeContactDiff([contact('1'), contact('2')], now + 2);
    expect(next.isFullSync).toBe(true);
    expect(idSet(next.toSend)).toEqual(idSet([contact('1'), contact('2')]));
  });

  it('does NOT clear the desktop contactDiff-supported flag (unlike unpair reset)', async () => {
    // registerDevice sets this from the fresh /register response BEFORE adoption;
    // forcing a full resync must preserve it so the diff optimisation survives.
    await setContactDiffSupported(true);

    await forceFullContactResync();

    expect(await isContactDiffSupported()).toBe(true);
  });
});
