/**
 * BACKLOG-2407 — adding `lookupKey` to SyncContact must NOT perturb the sync
 * fingerprint.
 *
 * WHY THIS EXISTS. `canonicalContact()` builds an explicit field list, so today
 * a new field on `SyncContact` is invisible to `fingerprintContact()`. That is
 * the correct behaviour and it is currently an ACCIDENT of the implementation —
 * nothing states it, and the obvious "tidy-up" of folding every field into the
 * canonical string would silently do real damage:
 *
 *   - every fingerprint already stored on every paired phone changes at once;
 *   - the next diff therefore reports the ENTIRE address book as new/changed;
 *   - the user sees a bogus "New Contacts" count;
 *   - and the whole book is re-encrypted and re-sent over the WiFi link.
 *
 * All for a field that is captured and matched on by nothing. This test turns
 * "it happens not to" into "it must not".
 */

import { fingerprintContact } from '../contactSyncState';
import type { SyncContact } from '../../types/contacts';

const BASE: SyncContact = {
  id: '101',
  displayName: 'Ada Lovelace',
  phones: [{ number: '+15555550104', label: 'mobile' }],
  emails: [{ address: 'ada@example.com', label: 'home' }],
  company: 'Analytical Engines',
  title: 'Engineer',
};

describe('fingerprintContact — lookupKey is not part of the content hash', () => {
  it('is byte-identical with and without a lookupKey', () => {
    const without = fingerprintContact(BASE);
    const withKey = fingerprintContact({ ...BASE, lookupKey: '0r1-4A3B2C' });

    expect(withKey).toBe(without);
  });

  it('is unchanged when the lookupKey CHANGES', () => {
    // The case that matters on a re-pairing: the platform can hand back a
    // different lookup key for the same unchanged person. That must not present
    // as a content change and force a re-send.
    const a = fingerprintContact({ ...BASE, lookupKey: '0r1-4A3B2C' });
    const b = fingerprintContact({ ...BASE, lookupKey: '0r99-ZZZZZZ' });

    expect(b).toBe(a);
  });

  it('still changes when real content changes — the test is not vacuous', () => {
    // Guards against a fingerprint function that returned a constant, which
    // would make every assertion above pass while proving nothing.
    const base = fingerprintContact(BASE);

    expect(fingerprintContact({ ...BASE, displayName: 'Ada L.' })).not.toBe(base);
    expect(
      fingerprintContact({ ...BASE, phones: [{ number: '+15555550120' }] })
    ).not.toBe(base);
  });
});
