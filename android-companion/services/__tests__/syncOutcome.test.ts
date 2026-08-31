/**
 * BACKLOG-2988 — ONE EVENT PER SYNC RUN, WHATEVER HAPPENS.
 *
 * ===========================================================================
 * THE CONTROL THE ITEM ASKS FOR, AND THE ONE IT WARNS AGAINST
 * ===========================================================================
 * *"Force a sync that completes with zero messages and no throw. Assert an EVENT
 * reaches Sentry. Asserting 'some Sentry call happened' would pass on the
 * breadcrumb and prove nothing — assert the EVENT."*
 *
 * So `addBreadcrumb` and `captureMessage` are separate mocks here, and the
 * suite's own last case asserts that the breadcrumb path could NOT have
 * satisfied the event assertions. Without that, a future refactor that turned
 * the event back into a breadcrumb could leave this file green.
 *
 * ---------------------------------------------------------------------------
 * MUTATIONS THAT MUST GO RED (run, not asserted — results in the PR body)
 * ---------------------------------------------------------------------------
 *  S1  `reportSyncOutcome` calls `Sentry.addBreadcrumb` instead of
 *      `captureMessage` — i.e. exactly the pre-fix behaviour. Every emission
 *      case fails.
 *  S2  `classifySyncOutcome` returns `completed` where it returns
 *      `completed_empty`. The zero-message case fails.
 *  S3  Drop `contactsFailed` from the classifier. The partial case fails.
 *  S4  Drop `if (row.deviceId) tags.device_id` from `buildOutcomeTags`. The
 *      device-id case fails — the tag the item asks for by name.
 *  S5  Let `scrubOutcomeFields` through unfiltered. The privacy cases fail.
 *  S6  Fall back to `'complete'` instead of `'unknown'` on the throw path — the
 *      wart this suite was written to close. The crash cases fail.
 *
 * Everything below is invented. No real address, contact or message appears.
 */

jest.mock('@sentry/react-native', () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

import * as Sentry from '@sentry/react-native';

import {
  buildOutcomeTags,
  classifyAddress,
  classifySyncOutcome,
  durationBucket,
  reportSyncOutcome,
  scrubOutcomeFields,
  type SyncOutcomeRow,
} from '../syncOutcome';

const captureMessage = Sentry.captureMessage as jest.MockedFunction<
  typeof Sentry.captureMessage
>;
const addBreadcrumb = Sentry.addBreadcrumb as jest.MockedFunction<
  typeof Sentry.addBreadcrumb
>;

// pii-allow-uuid: a hand-written placeholder device id, not a real record — the digits are a visible pattern, never generated
const DEVICE = '11111111-2222-4333-8444-555555555555';

function row(overrides: Partial<SyncOutcomeRow> = {}): SyncOutcomeRow {
  return {
    outcome: 'completed',
    step: 'complete',
    elapsedMs: 1_200,
    addressClass: 'private',
    deviceId: DEVICE,
    counts: {
      messagesRead: 0,
      messagesSent: 0,
      contactsSent: 0,
      newContacts: 0,
      queueSize: 0,
    },
    ...overrides,
  };
}

/** The options object of the single captured event. */
function capturedEvent(): {
  level?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  fingerprint?: string[];
} {
  expect(captureMessage).toHaveBeenCalledTimes(1);
  return captureMessage.mock.calls[0][1] as never;
}

beforeEach(() => {
  captureMessage.mockClear();
  addBreadcrumb.mockClear();
});

describe('classifySyncOutcome', () => {
  it('a run that reached the desktop and had NOTHING to send is completed_empty', () => {
    // THE CASE THE ITEM NAMES: completes, no throw, zero messages. Before this
    // item it produced a breadcrumb and therefore nothing at all.
    expect(
      classifySyncOutcome({
        desktopReachable: true,
        stoppedAt: 'complete',
        newMessages: 0,
        sentMessages: 0,
        contactsSynced: 0,
      }),
    ).toEqual({ outcome: 'completed_empty', step: 'complete' });
  });

  it('a run that moved something is completed', () => {
    expect(
      classifySyncOutcome({ desktopReachable: true, stoppedAt: 'complete', sentMessages: 3 }),
    ).toEqual({ outcome: 'completed', step: 'complete' });
    // New messages read but still queued also counts as movement — the run did
    // work, and reporting it as "empty" would hide a queue that never drains.
    expect(
      classifySyncOutcome({ desktopReachable: true, stoppedAt: 'complete', newMessages: 4 }),
    ).toEqual({ outcome: 'completed', step: 'complete' });
    expect(
      classifySyncOutcome({ desktopReachable: true, stoppedAt: 'complete', contactsSynced: 7 }),
    ).toEqual({ outcome: 'completed', step: 'complete' });
  });

  it('messages sent but CONTACTS failed is partial, not completed', () => {
    // The swallowed non-fatal failure. `contactsSynced: 0` alone is
    // indistinguishable from "nothing to send", which is why the flag exists.
    expect(
      classifySyncOutcome({
        desktopReachable: true,
        stoppedAt: 'send_contacts',
        sentMessages: 2,
        contactsSynced: 0,
        contactsFailed: true,
      }),
    ).toEqual({ outcome: 'partial', step: 'send_contacts' });
  });

  it('the LAN-guard refusal is refused, never unreachable', () => {
    // BACKLOG-2956/2913: reporting this as a reachability problem sends the user
    // to check a network that is working fine.
    expect(
      classifySyncOutcome({
        desktopReachable: false,
        stoppedAt: 'lan_guard',
        errorType: 'invalid_address',
        error: 'This pairing is no longer valid',
      }),
    ).toEqual({ outcome: 'refused', step: 'lan_guard' });
  });

  it('a failed ping is unreachable, and the phone being off Wi-Fi keeps its own reason', () => {
    expect(
      classifySyncOutcome({
        desktopReachable: false,
        stoppedAt: 'ping',
        errorType: 'connection_refused',
        error: "Can't reach Keepr on your computer.",
      }),
    ).toEqual({ outcome: 'unreachable', step: 'ping' });
    expect(
      classifySyncOutcome({
        desktopReachable: false,
        stoppedAt: 'ping',
        errorType: 'phone_offline',
        error: "You're not connected to Wi-Fi.",
      }),
    ).toEqual({ outcome: 'unreachable', step: 'ping' });
  });

  it('a send error is failed', () => {
    expect(
      classifySyncOutcome({
        desktopReachable: true,
        stoppedAt: 'send_messages',
        error: 'Server responded with 403',
        errorType: 'server_error',
      }),
    ).toEqual({ outcome: 'failed', step: 'send_messages' });
  });

  it('an SMS read failure is failed even when the desktop was reached', () => {
    // Mirrors `reachedDesktop = !sendError && !readError` in backgroundSync: we
    // cannot trust "nothing new" when the read itself errored.
    expect(
      classifySyncOutcome({
        desktopReachable: true,
        stoppedAt: 'read_sms',
        readError: { reason: 'permission_denied' },
      }),
    ).toEqual({ outcome: 'failed', step: 'read_sms' });
  });

  it('no pairing is not_paired, and the lock skip is skipped', () => {
    expect(
      classifySyncOutcome({ desktopReachable: false, stoppedAt: 'pairing' }),
    ).toEqual({ outcome: 'not_paired', step: 'pairing' });
    expect(
      classifySyncOutcome({ skipped: true, desktopReachable: true, stoppedAt: 'lock' }),
    ).toEqual({ outcome: 'skipped', step: 'lock' });
  });

  it('a throw is crashed, and outranks everything else on the result', () => {
    expect(
      classifySyncOutcome({ threw: true, skipped: true, desktopReachable: true }),
    ).toEqual({ outcome: 'crashed', step: 'unknown' });
  });

  it('a crashed run says its step is UNKNOWN, never `complete`', () => {
    // A run that threw never returned a result and so never named a step.
    // Reporting `complete` would put a false value in the one field the item
    // asks for by name, on the rarest outcome — where it is least likely to be
    // questioned and most likely to be believed.
    expect(classifySyncOutcome({ threw: true }).step).toBe('unknown');
  });
});

describe('classifyAddress', () => {
  it('reduces the address to a class and never returns the address', () => {
    expect(classifyAddress('192.168.1.50')).toBe('private');
    expect(classifyAddress('10.0.0.4')).toBe('private');
    expect(classifyAddress('203.0.113.10')).toBe('refused');
    expect(classifyAddress(undefined)).toBe('unknown');
    expect(classifyAddress(null)).toBe('unknown');
    expect(classifyAddress('')).toBe('unknown');
  });
});

describe('durationBucket', () => {
  it('sweeps the boundaries rather than sampling them', () => {
    expect(durationBucket(0)).toBe('<1s');
    expect(durationBucket(999)).toBe('<1s');
    expect(durationBucket(1_000)).toBe('1-5s');
    expect(durationBucket(4_999)).toBe('1-5s');
    expect(durationBucket(5_000)).toBe('5-15s');
    expect(durationBucket(14_999)).toBe('5-15s');
    expect(durationBucket(15_000)).toBe('15-60s');
    expect(durationBucket(59_999)).toBe('15-60s');
    expect(durationBucket(60_000)).toBe('>60s');
    expect(durationBucket(-1)).toBe('unknown');
    expect(durationBucket(Number.NaN)).toBe('unknown');
  });
});

describe('reportSyncOutcome', () => {
  it('raises an EVENT, not a breadcrumb, for a run that completed with nothing', () => {
    // THE CONTROL. Pre-fix this path called `addBreadcrumb` and the event never
    // existed, so a run that finished badly sent nothing at all.
    reportSyncOutcome(row({ outcome: 'completed_empty' }));

    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage.mock.calls[0][0]).toBe('Sync outcome: completed_empty');
  });

  it('carries the DEVICE ID as a tag — the field that would have exposed BACKLOG-2987', () => {
    reportSyncOutcome(row({ deviceId: DEVICE }));
    expect(capturedEvent().tags?.device_id).toBe(DEVICE);
  });

  it('tags the source, outcome, step, address class and duration bucket', () => {
    reportSyncOutcome(
      row({ outcome: 'unreachable', step: 'ping', elapsedMs: 7_000, addressClass: 'private' }),
    );

    expect(capturedEvent().tags).toMatchObject({
      source: 'android_companion',
      outcome: 'unreachable',
      step: 'ping',
      address_class: 'private',
      duration_bucket: '5-15s',
    });
  });

  it('uses the desktop\'s `reason_code` tag name so one query spans both halves', () => {
    reportSyncOutcome(row({ outcome: 'failed', errorType: 'server_error' }));
    expect(capturedEvent().tags?.reason_code).toBe('server_error');

    captureMessage.mockClear();
    reportSyncOutcome(row({ outcome: 'failed', readErrorReason: 'permission_denied' }));
    expect(capturedEvent().tags?.reason_code).toBe('permission_denied');
  });

  it('groups by ["sync-outcome", source, outcome], matching the desktop reporter', () => {
    reportSyncOutcome(row({ outcome: 'refused' }));
    expect(capturedEvent().fingerprint).toEqual([
      'sync-outcome',
      'android_companion',
      'refused',
    ]);
  });

  it('sends the counts as extra', () => {
    reportSyncOutcome(
      row({
        counts: {
          messagesRead: 4,
          messagesSent: 3,
          contactsSent: 389,
          newContacts: 2,
          queueSize: 1,
        },
      }),
    );

    expect(capturedEvent().extra).toMatchObject({
      messagesRead: 4,
      messagesSent: 3,
      contactsSent: 389,
      newContacts: 2,
      queueSize: 1,
    });
  });

  it('raises the level for the outcomes a user would call broken', () => {
    reportSyncOutcome(row({ outcome: 'failed' }));
    expect(capturedEvent().level).toBe('warning');

    captureMessage.mockClear();
    reportSyncOutcome(row({ outcome: 'completed_empty' }));
    expect(capturedEvent().level).toBe('info');
  });

  it('emits for EVERY outcome, including the successful ones (the denominator)', () => {
    const outcomes = [
      'completed',
      'completed_empty',
      'partial',
      'unreachable',
      'refused',
      'failed',
      'not_paired',
      'skipped',
      'crashed',
    ] as const;

    for (const outcome of outcomes) reportSyncOutcome(row({ outcome }));

    expect(captureMessage).toHaveBeenCalledTimes(outcomes.length);
    expect(captureMessage.mock.calls.map((c) => c[0])).toEqual(
      outcomes.map((o) => `Sync outcome: ${o}`),
    );
  });

  it('NEVER raises a breadcrumb in place of the event', () => {
    // The discriminator the item demands. If `reportSyncOutcome` were ever
    // reverted to `addBreadcrumb`, every case above would fail AND this one
    // would too — asserting "some Sentry call happened" would not.
    reportSyncOutcome(row());
    expect(addBreadcrumb).not.toHaveBeenCalled();
  });
});

describe('privacy — the repo is public and Sentry is a third party', () => {
  it('drops keys that could name a person, a place or a credential', () => {
    const safe = scrubOutcomeFields({
      messagesSent: 3,
      deviceId: DEVICE,
      // None of these are produced today. They are the NEXT field somebody adds.
      desktopIp: '192.168.1.50',
      pairingSecret: 'f'.repeat(64),
      bearerToken: 'abc',
      contactName: 'Fixture One',
      senderNumber: '+15550100',
      messageBody: 'hello',
      emailAddress: 'one@example.test',
      supabaseUserId: 'user-1',
    });

    expect(Object.keys(safe).sort()).toEqual(['deviceId', 'messagesSent']);
  });

  it('drops an IPv4 value even when it arrives under an innocent key', () => {
    const safe = scrubOutcomeFields({ host: '192.168.1.50', messagesSent: 1 });
    expect(safe).toEqual({ messagesSent: 1 });
  });

  it('the emitted event contains no address, secret or content anywhere', () => {
    reportSyncOutcome(row({ outcome: 'refused', addressClass: 'refused' }));

    const serialized = JSON.stringify(capturedEvent());
    // The class is present; the address is not, and neither is anything else
    // that could identify a person or let someone into the pairing.
    expect(serialized).toContain('refused');
    for (const forbidden of ['192.168.', '10.0.0.', 'Bearer', 'secret']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
