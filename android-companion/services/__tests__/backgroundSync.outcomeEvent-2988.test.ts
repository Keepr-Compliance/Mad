/**
 * BACKLOG-2988 — the REAL `performSync`, and the event it must emit.
 *
 * `syncOutcome.test.ts` proves the classifier and the transport in isolation.
 * This suite proves the WIRING: that every way a real sync run can end passes
 * through the one emission point, including the ones that used to send nothing.
 *
 * ===========================================================================
 * THE CASE THE ITEM NAMES
 * ===========================================================================
 * *"Force a sync that completes with zero messages and no throw. Assert an
 * EVENT reaches Sentry."* That is `a run that completes with nothing to send`
 * below. It ran the whole cycle, threw nothing, sent nothing, and before this
 * item produced a breadcrumb — which Sentry discards unless an event is
 * captured in the same session, so it produced nothing at all.
 *
 * `addBreadcrumb` and `captureMessage` are separate mocks, because asserting
 * "some Sentry call happened" passes on the breadcrumb and proves nothing.
 *
 * ---------------------------------------------------------------------------
 * MUTATIONS THAT MUST GO RED (run, not asserted — results in the PR body)
 * ---------------------------------------------------------------------------
 *  W1  Delete the `emitOutcome` call from the success path of `performSync`.
 *      Every case except the crash case fails.
 *  W2  Delete it from the catch path. The crash case fails.
 *  W3  Drop `stoppedAt: "lan_guard"` from the LAN-refusal return. The refused
 *      case fails — it reports `unreachable`, the BACKLOG-2913 wrong-cause
 *      shape, which is the whole reason the step is carried explicitly.
 *  W4  Drop `contactsFailed = true` from the contact-send failure branch. The
 *      partial case fails and the run reports a clean `completed`.
 *
 * Nothing here is a real device, number, address or message.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SyncMessage, SyncResult, PairingInfo } from '../../types/sync';
import type { SyncContact } from '../../types/contacts';
import type { SmsReadResult } from '../smsReader';

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

jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn(async () => false),
}));
jest.mock('expo-background-fetch', () => ({
  BackgroundFetchResult: { NewData: 1, NoData: 2, Failed: 3 },
  registerTaskAsync: jest.fn(async () => undefined),
  unregisterTaskAsync: jest.fn(async () => undefined),
  getStatusAsync: jest.fn(async () => 3),
}));

// The FULL Sentry surface. Split deliberately: the event and the breadcrumb are
// different assertions and the suite must be able to tell them apart.
jest.mock('@sentry/react-native', () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockReadSmsMessages = jest.fn<Promise<SmsReadResult>, [number, number?]>();
jest.mock('../smsReader', () => ({
  readSmsMessages: (since: number, maxCount?: number) =>
    mockReadSmsMessages(since, maxCount),
}));

import type { SmsPermissionResult } from '../permissions';
const mockCheckSmsPermissions = jest.fn<Promise<SmsPermissionResult>, []>();
jest.mock('../permissions', () => ({
  checkSmsPermissions: () => mockCheckSmsPermissions(),
}));

const mockReadContacts = jest.fn<Promise<SyncContact[]>, []>();
jest.mock('../contactReader', () => ({
  readContacts: () => mockReadContacts(),
}));

const mockSendMessages = jest.fn<Promise<SyncResult>, [SyncMessage[], PairingInfo]>();
const mockSendContacts =
  jest.fn<Promise<SyncResult>, [SyncContact[], PairingInfo, boolean?]>();
const mockPingDesktop = jest.fn(async () => true);
jest.mock('../syncService', () => ({
  sendMessages: (batch: SyncMessage[], pairing: PairingInfo) =>
    mockSendMessages(batch, pairing),
  sendContacts: (batch: SyncContact[], pairing: PairingInfo, isFullSync?: boolean) =>
    mockSendContacts(batch, pairing, isFullSync),
  pingDesktop: () => mockPingDesktop(),
}));

const mockIsPhoneOnLocalNetwork = jest.fn(async () => true);
jest.mock('../connectivity', () => ({
  isPhoneOnLocalNetwork: () => mockIsPhoneOnLocalNetwork(),
}));

import * as Sentry from '@sentry/react-native';
import { performSync } from '../backgroundSync';

const captureMessage = Sentry.captureMessage as jest.MockedFunction<
  typeof Sentry.captureMessage
>;
const addBreadcrumb = Sentry.addBreadcrumb as jest.MockedFunction<
  typeof Sentry.addBreadcrumb
>;

const PAIRING_KEY = '@keepr/pairing';
// pii-allow-uuid: a hand-written placeholder device id, not a real record — the digits are a visible pattern, never generated
const DEVICE = '11111111-2222-4333-8444-555555555555';
const LAN_IP = '192.168.1.50';
/** Documentation-reserved (TEST-NET-3) — never a real host. */
const PUBLIC_IP = '203.0.113.10';

async function storePairing(ip: string = LAN_IP): Promise<void> {
  await AsyncStorage.setItem(
    PAIRING_KEY,
    JSON.stringify({
      ip,
      port: 8765,
      secret: 'f'.repeat(64),
      deviceName: 'Test-Desktop',
      deviceId: DEVICE,
      pairedAt: new Date().toISOString(),
    }),
  );
}

/** The single outcome event: its message and its options. */
function outcomeEvent(): {
  message: string;
  level?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  fingerprint?: string[];
} {
  const calls = captureMessage.mock.calls.filter((c) =>
    String(c[0]).startsWith('Sync outcome:'),
  );
  // EXACTLY one per run — an emission point that fired twice would double-count
  // every rate in the data, and is as wrong as one that never fired.
  expect(calls).toHaveLength(1);
  return { message: String(calls[0][0]), ...(calls[0][1] as object) } as never;
}

beforeEach(() => {
  resetStore();
  captureMessage.mockClear();
  addBreadcrumb.mockClear();
  mockCheckSmsPermissions.mockResolvedValue({
    readSms: 'granted',
    receiveSms: 'granted',
    allGranted: true,
  });
  mockReadSmsMessages.mockResolvedValue({ ok: true, messages: [] });
  mockReadContacts.mockResolvedValue([]);
  mockSendMessages.mockResolvedValue({ success: true });
  mockSendContacts.mockResolvedValue({ success: true });
  mockPingDesktop.mockResolvedValue(true);
  mockIsPhoneOnLocalNetwork.mockResolvedValue(true);
});

describe('performSync emits exactly one outcome event (BACKLOG-2988)', () => {
  it('a run that completes with nothing to send — THE CONTROL', async () => {
    await storePairing();

    const result = await performSync();

    // No throw, nothing sent: the exact shape that sent nothing before.
    expect(result.error).toBeUndefined();
    expect(result.sentMessages).toBe(0);

    const event = outcomeEvent();
    expect(event.message).toBe('Sync outcome: completed_empty');
    expect(event.tags).toMatchObject({
      source: 'android_companion',
      outcome: 'completed_empty',
      step: 'complete',
      address_class: 'private',
      device_id: DEVICE,
    });
  });

  it('the device id is on the event, so a CHANGING one is visible without a log', async () => {
    // BACKLOG-2987 was found by hand-reading four log lines. This is the field
    // that would have shown it on the first sync.
    await storePairing();
    await performSync();
    expect(outcomeEvent().tags?.device_id).toBe(DEVICE);
  });

  it('a run with no pairing at all still emits', async () => {
    // No pairing stored.
    await performSync();

    const event = outcomeEvent();
    expect(event.message).toBe('Sync outcome: not_paired');
    expect(event.tags).toMatchObject({ step: 'pairing', address_class: 'unknown' });
    expect(event.tags?.device_id).toBeUndefined();
  });

  it('a stored pairing that points off the LAN reports REFUSED, not unreachable', async () => {
    // BACKLOG-2956/2913: calling this a reachability failure sends the user to
    // check a network that is working fine.
    await storePairing(PUBLIC_IP);

    const event = outcomeEvent.bind(null);
    await performSync();

    expect(event().message).toBe('Sync outcome: refused');
    expect(event().tags).toMatchObject({
      outcome: 'refused',
      step: 'lan_guard',
      address_class: 'refused',
      reason_code: 'invalid_address',
    });
  });

  it('an unreachable desktop emits, and the address never appears in the event', async () => {
    await storePairing();
    mockPingDesktop.mockResolvedValue(false);

    await performSync();

    const event = outcomeEvent();
    expect(event.message).toBe('Sync outcome: unreachable');
    expect(event.tags).toMatchObject({ step: 'ping', reason_code: 'connection_refused' });
    // The class is sent; the address is not. Asserted on the whole serialized
    // event, so a field added later that carries it fails here.
    expect(JSON.stringify(event)).not.toContain(LAN_IP);
  });

  it('a phone that is off Wi-Fi keeps its own reason code', async () => {
    await storePairing();
    mockPingDesktop.mockResolvedValue(false);
    mockIsPhoneOnLocalNetwork.mockResolvedValue(false);

    await performSync();

    expect(outcomeEvent().tags?.reason_code).toBe('phone_offline');
  });

  it('a revoked SMS permission emits a FAILED run, not a healthy idle one', async () => {
    await storePairing();
    mockCheckSmsPermissions.mockResolvedValue({
      readSms: 'denied',
      receiveSms: 'denied',
      allGranted: false,
    });

    await performSync();

    const event = outcomeEvent();
    expect(event.message).toBe('Sync outcome: failed');
    expect(event.tags).toMatchObject({ step: 'read_sms', reason_code: 'permission_denied' });
  });

  it('a contact send that fails is PARTIAL — the swallowed non-fatal failure', async () => {
    await storePairing();
    mockReadContacts.mockResolvedValue([
      { id: 'c1', displayName: 'Fixture One', phones: [], emails: [] },
    ]);
    mockSendContacts.mockResolvedValue({
      success: false,
      error: 'Server responded with 500',
      errorType: 'server_error',
    });

    const result = await performSync();

    // Still non-fatal to the caller — the message half worked.
    expect(result.error).toBeUndefined();
    // But no longer invisible.
    const event = outcomeEvent();
    expect(event.message).toBe('Sync outcome: partial');
    expect(event.tags).toMatchObject({ outcome: 'partial', step: 'send_contacts' });
    expect(event.level).toBe('warning');
  });

  it('a lock skip emits, because "every sync is skipped" is a failure mode', async () => {
    await storePairing();
    // Two genuinely overlapping runs, the shape `backgroundSync.test.ts` uses:
    // a slow ping makes the first hold the lock while the second arrives. A
    // hand-held promise deadlocks instead, because the lock is acquired before
    // the ping and the second call therefore never releases the first.
    mockPingDesktop.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return true;
    });

    const [r1, r2] = await Promise.all([performSync(), performSync()]);
    expect([r1, r2].filter((r) => r.skipped)).toHaveLength(1);

    const skippedEvents = captureMessage.mock.calls.filter(
      (c) => c[0] === 'Sync outcome: skipped',
    );
    expect(skippedEvents).toHaveLength(1);
    expect((skippedEvents[0][1] as { tags?: Record<string, string> }).tags).toMatchObject({
      outcome: 'skipped',
      step: 'lock',
    });
    // And the run that DID work emitted its own event — two runs, two events,
    // never one covering both.
    expect(
      captureMessage.mock.calls.filter((c) => String(c[0]).startsWith('Sync outcome:')),
    ).toHaveLength(2);
  });

  it('a THROWN cycle emits before the error propagates', async () => {
    await storePairing();
    const boom = new Error('queue exploded');
    mockPingDesktop.mockRejectedValue(boom);

    await expect(performSync()).rejects.toThrow('queue exploded');

    const event = outcomeEvent();
    expect(event.message).toBe('Sync outcome: crashed');
    // `step: unknown`, not `complete`: the run threw, so it never named a step.
    expect(event.tags).toMatchObject({
      outcome: 'crashed',
      step: 'unknown',
      device_id: DEVICE,
    });
  });

  it('a run that actually sends reports completed, so the successes are the denominator', async () => {
    await storePairing();
    mockReadSmsMessages.mockResolvedValue({
      ok: true,
      messages: [
        {
          smsId: '1',
          // Reserved-for-fiction range; the body is a placeholder, not content.
          sender: '+12065550177',
          body: 'placeholder',
          timestamp: 1_700_000_000_000,
          direction: 'inbound',
        } satisfies SyncMessage,
      ],
    });

    await performSync();

    const event = outcomeEvent();
    expect(event.message).toBe('Sync outcome: completed');
    expect(event.extra).toMatchObject({ messagesRead: 1, messagesSent: 1 });
    expect(event.level).toBe('info');
  });

  it('the event is an EVENT — a breadcrumb could not have satisfied any case above', async () => {
    await storePairing();
    await performSync();

    // The cycle still leaves breadcrumbs for context, and that is fine. What
    // must be true is that the OUTCOME is not one of them: a breadcrumb is
    // discarded unless an event is captured, which is the whole defect.
    const breadcrumbMessages = addBreadcrumb.mock.calls.map((c) =>
      String((c[0] as { message?: string }).message ?? ''),
    );
    expect(breadcrumbMessages.some((m) => m.startsWith('Sync outcome:'))).toBe(false);
    expect(captureMessage).toHaveBeenCalled();
  });
});
