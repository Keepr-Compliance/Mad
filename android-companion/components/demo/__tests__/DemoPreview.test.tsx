/**
 * BACKLOG-3027 — the sample preview reads nothing real, and says it is a sample.
 *
 * ## What is actually being guarded
 *
 * This app requests `READ_SMS` under Google Play's "Cross-device synchronization
 * or transfer of SMS or calls" exception. The preview exists so a reviewer with
 * no Keepr desktop can see what that permission is for. A preview that quietly
 * touched real messages, real contacts, or the OS permission prompt would not be
 * a bug — it would be a policy problem, and a worse one than the wall it
 * replaces. So the central assertion here is a NEGATIVE one.
 *
 * ## Why the positive assertions come first
 *
 * A negative assertion is worthless on a screen that did not render: "it never
 * read any SMS" passes trivially when nothing mounted. Every test below asserts
 * that the sample CONTENT is on screen — the banner, a sample name, a sample
 * message body — BEFORE it asserts what was not called. If the render breaks,
 * these fail on the positive assertion, not silently pass on the negative one.
 *
 * ## The spies
 *
 * Both layers are watched, because "does not call `readSmsMessages`" would not
 * catch a component that reached past the service to the bridge:
 *
 *   - service layer: `smsReader`, `contactReader`, `syncService`
 *   - native layer:  `NativeModules.Sms.list` (the actual content-provider
 *     query `smsReader` issues), `expo-contacts`, and `PermissionsAndroid`
 *     (the OS dialog — a preview that triggered a permission prompt would
 *     destroy the entire point of hosting it before the permissions screen)
 *   - storage:       `AsyncStorage.setItem` / `removeItem`, which is the single
 *     spy covering the pairing record (`@keepr/pairing`), the device identity
 *     and the sync cursor at once
 */
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';

// --- Native SMS bridge. `smsReader` reads `NativeModules.Sms` and calls
// `.list(...)` on it; if the preview ever reached the content provider, by any
// route, this spy is what sees it. Installed by assignment in `beforeEach`
// rather than `jest.mock`: mocking the BatchedBridge module itself detonates
// the preset ("__fbBatchedBridgeConfig is not set"), and the property is what
// `smsReader.getSmsNativeModule()` actually reads. ---
const mockSmsList = jest.fn();

// --- Contacts provider ---
const mockGetContacts = jest.fn(async () => ({ data: [] }));
const mockContactsPermissions = jest.fn(async () => ({ status: 'granted' }));
jest.mock('expo-contacts', () => ({
  getContactsAsync: (...a: unknown[]) => mockGetContacts(...(a as [])),
  getPermissionsAsync: () => mockContactsPermissions(),
  requestPermissionsAsync: () => mockContactsPermissions(),
  Fields: { FirstName: 'firstName', PhoneNumbers: 'phoneNumbers' },
}));

// --- Service layer ---
const mockReadSmsMessages = jest.fn(async () => ({ ok: true, messages: [] }));
jest.mock('../../../services/smsReader', () => ({
  readSmsMessages: (...a: unknown[]) => mockReadSmsMessages(...(a as [])),
  getUnreadSmsCount: jest.fn(async () => 0),
  SMS_READ_PAGE_SIZE: 200,
}));

const mockReadContacts = jest.fn(async () => []);
jest.mock('../../../services/contactReader', () => ({
  readContacts: () => mockReadContacts(),
}));

const mockPerformSync = jest.fn(async () => ({ success: true }));
const mockRegisterDevice = jest.fn(async () => ({ success: true }));
jest.mock('../../../services/syncService', () => ({
  performSync: () => mockPerformSync(),
  registerDevice: () => mockRegisterDevice(),
}));

// --- Storage: pairing record, device identity, sync cursor ---
const mockSetItem = jest.fn(async () => undefined);
const mockRemoveItem = jest.fn(async () => undefined);
const mockMultiRemove = jest.fn(async () => undefined);
jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: (...a: unknown[]) => mockSetItem(...(a as [])),
  removeItem: (...a: unknown[]) => mockRemoveItem(...(a as [])),
  multiRemove: (...a: unknown[]) => mockMultiRemove(...(a as [])),
  getItem: jest.fn(async () => null),
}));

import { NativeModules, PermissionsAndroid } from 'react-native';
import DemoPreview, {
  DemoPreviewModal,
  DEMO_BANNER_TEXT,
  DEMO_LINK_TEXT,
} from '../DemoPreview';
import {
  DEMO_CONVERSATIONS,
  DEMO_MESSAGE_COUNT,
  DEMO_SYNC_STEPS,
  DEMO_DESKTOP_NAME,
} from '../sampleConversations';

/** Every spy that must stay untouched, in one place. */
function assertNothingRealWasTouched(): void {
  expect(mockSmsList).not.toHaveBeenCalled();
  expect(mockReadSmsMessages).not.toHaveBeenCalled();
  expect(mockGetContacts).not.toHaveBeenCalled();
  expect(mockReadContacts).not.toHaveBeenCalled();
  expect(mockContactsPermissions).not.toHaveBeenCalled();
  expect(mockPerformSync).not.toHaveBeenCalled();
  expect(mockRegisterDevice).not.toHaveBeenCalled();
  expect(mockSetItem).not.toHaveBeenCalled();
  expect(mockRemoveItem).not.toHaveBeenCalled();
  expect(mockMultiRemove).not.toHaveBeenCalled();
  expect(permissionRequest).not.toHaveBeenCalled();
  expect(permissionRequestMultiple).not.toHaveBeenCalled();
}

let permissionRequest: jest.SpyInstance;
let permissionRequestMultiple: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  (NativeModules as unknown as Record<string, unknown>).Sms = {
    list: mockSmsList,
  };
  // Spied rather than mocked at module level: `react-native` is the preset's
  // own module and replacing it wholesale breaks the renderer.
  permissionRequest = jest
    .spyOn(PermissionsAndroid, 'request')
    .mockResolvedValue('granted' as never);
  permissionRequestMultiple = jest
    .spyOn(PermissionsAndroid, 'requestMultiple')
    .mockResolvedValue({} as never);
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('DemoPreviewModal — the sample itself', () => {
  it('renders real sample content, and reads nothing real doing it', () => {
    const { getByText, queryAllByText } = render(
      <DemoPreviewModal visible onClose={jest.fn()} />,
    );

    // POSITIVE FIRST. If the modal did not mount with actual sample content,
    // this fails here rather than letting the negative assertions below pass
    // for the wrong reason.
    expect(getByText(DEMO_BANNER_TEXT)).toBeTruthy();
    expect(queryAllByText(DEMO_CONVERSATIONS[0].name).length).toBeGreaterThan(0);
    expect(getByText(DEMO_CONVERSATIONS[0].messages[0].body)).toBeTruthy();
    expect(getByText(DEMO_CONVERSATIONS[0].displayPhone)).toBeTruthy();

    // NEGATIVE SECOND.
    assertNothingRealWasTouched();
  });

  it('labels itself as a sample where a reader cannot scroll past it', () => {
    const { getAllByText } = render(
      <DemoPreviewModal visible onClose={jest.fn()} />,
    );
    // The sticky bar sits OUTSIDE the ScrollView and the footer repeats it, so
    // the label is present at every scroll position. Two occurrences is the
    // point, not an accident.
    expect(getAllByText(new RegExp(DEMO_BANNER_TEXT)).length).toBeGreaterThan(1);
  });

  it('switches threads without reading anything', () => {
    const { getByText, queryAllByText } = render(
      <DemoPreviewModal visible onClose={jest.fn()} />,
    );

    const second = DEMO_CONVERSATIONS[1];
    fireEvent.press(queryAllByText(second.name)[0]);

    expect(getByText(second.messages[0].body)).toBeTruthy();
    expect(getByText(second.displayPhone)).toBeTruthy();
    assertNothingRealWasTouched();
  });

  it('runs the sample transfer to completion with timers only', () => {
    const { getByText, queryByText } = render(
      <DemoPreviewModal visible onClose={jest.fn()} />,
    );

    expect(queryByText(`${DEMO_MESSAGE_COUNT} messages delivered`)).toBeNull();

    fireEvent.press(getByText('Send to my computer'));
    act(() => {
      jest.advanceTimersByTime(5000);
    });

    // The transfer VISIBLY completed — it names the desktop and the message
    // count, which is the cross-device transfer the policy exception covers.
    expect(getByText(`${DEMO_MESSAGE_COUNT} messages delivered`)).toBeTruthy();
    DEMO_SYNC_STEPS.forEach((step) => {
      expect(getByText(step.label)).toBeTruthy();
    });

    // And it did it without a socket, a reader, or a storage write.
    assertNothingRealWasTouched();
  });

  // BACKLOG-3027 / SR review — the screen must not promise anything about what
  // the DESKTOP does with the messages.
  //
  // Two earlier lines did: the card's "They are not sent to Keepr's servers" and
  // the sync step's "never to Keepr's servers". Both were false — submitting a
  // transaction uploads message bodies to Supabase (2,483 up there, 221 of them
  // SMS). Neither was rewritten into a softer version of the same promise; both
  // were deleted, because the phone does not control the desktop and so does not
  // get to speak for it.
  //
  // Asserted in the order the SR asked for. The card and the finished transfer
  // are proven ON SCREEN first — a "the copy does not say X" test is at its
  // happiest when nothing rendered at all, and this suite is already carrying a
  // lot of negatives.
  //
  // MUTATION THAT MUST GO RED: restore either sentence.
  it('describes what the PHONE does, and promises nothing about the desktop', () => {
    const { getByText, queryAllByText, toJSON } = render(
      <DemoPreviewModal visible onClose={jest.fn()} />,
    );

    // Run the transfer so the step details are on screen too — one of the two
    // deleted sentences lived there, so a check that never renders the finished
    // steps would only be covering half of what it claims to cover.
    fireEvent.press(getByText('Send to my computer'));
    act(() => {
      jest.advanceTimersByTime(5000);
    });

    // POSITIVE FIRST — the card is really rendered, with its real content.
    expect(getByText('In the real app')).toBeTruthy();
    expect(
      getByText(/Your texts go from this phone to the Keepr app on the computer/i),
    ).toBeTruthy();
    // And the transfer story it exists to tell is intact: still phone -> a named
    // computer over a local network. Deleting the promise must not have
    // flattened the point of the screen.
    expect(queryAllByText(/over your own Wi-Fi/i).length).toBeGreaterThan(0);
    expect(
      getByText(new RegExp(`Straight to ${DEMO_DESKTOP_NAME}`, 'i')),
    ).toBeTruthy();
    expect(queryAllByText(/over your local network/i).length).toBeGreaterThan(0);

    // NEGATIVE SECOND — swept over EVERY text node on the rendered screen, not
    // just the two strings that were removed, so the claim cannot reappear
    // somewhere else on this screen and go unnoticed.
    const collect = (node: unknown, out: string[] = []): string[] => {
      if (node == null) return out;
      if (typeof node === 'string') {
        out.push(node);
        return out;
      }
      const kids = (node as { children?: unknown[] }).children;
      if (Array.isArray(kids)) kids.forEach((k) => collect(k, out));
      return out;
    };
    const onScreen = collect(toJSON());
    expect(onScreen.length).toBeGreaterThan(20); // the sweep actually swept

    const offending = onScreen.filter((s) =>
      /servers|the cloud|never uploaded|not uploaded/i.test(s),
    );
    expect(offending).toEqual([]);
  });

  it('names the destination computer as an example, never a real one', () => {
    const { getByText, getAllByText } = render(
      <DemoPreviewModal visible onClose={jest.fn()} />,
    );
    expect(getByText(DEMO_DESKTOP_NAME)).toBeTruthy();
    expect(getAllByText('Example').length).toBeGreaterThan(0);
  });
});

describe('DemoPreview — the host-facing link', () => {
  it('mounts CLOSED: a normal user never sees sample data by accident', () => {
    const { queryByText, getByText } = render(<DemoPreview />);

    // The link is offered...
    expect(getByText(DEMO_LINK_TEXT)).toBeTruthy();
    // ...and nothing from the sample is on screen until it is tapped.
    expect(queryByText(DEMO_BANNER_TEXT)).toBeNull();
    expect(queryByText(DEMO_CONVERSATIONS[0].messages[0].body)).toBeNull();
    assertNothingRealWasTouched();
  });

  it('opens on tap and closes again, touching nothing either way', () => {
    const { getByText, queryByText, getAllByText } = render(<DemoPreview />);

    fireEvent.press(getByText(DEMO_LINK_TEXT));
    expect(queryByText(DEMO_BANNER_TEXT)).not.toBeNull();
    expect(getByText(DEMO_CONVERSATIONS[0].messages[0].body)).toBeTruthy();

    fireEvent.press(getAllByText('Close')[0]);
    expect(queryByText(DEMO_CONVERSATIONS[0].messages[0].body)).toBeNull();

    // Opening and closing the sample wrote NOTHING. `setItem`/`removeItem`
    // between them cover the pairing record, the device identity and the sync
    // cursor — the three pieces of state a stray write would corrupt.
    assertNothingRealWasTouched();
  });

  // Two promises, two tests, and the second draft of both.
  //
  // Written first as ONE test named "...stops the timers and restarts clean on
  // reopen". Removing `setStepsDone(0)` from `handleClose` left it GREEN — the
  // reopen half was an unchecked claim, because closing mid-transfer leaves
  // stepsDone below the completion threshold either way.
  //
  // Splitting it exposed a second, worse problem. The timer test had asserted
  // `expect(console.error calls).toEqual([])`, on the theory that a timer firing
  // into a torn-down subtree would be reported there. It would not: `DemoPreview`
  // renders `DemoPreviewModal` unconditionally and only toggles `visible`, so
  // nothing unmounts on close and a stale timer sets state on a LIVE component
  // in perfect silence. That assertion could not fail, and the original combined
  // test had been going red for the OTHER reason — the reopen assertion seeing a
  // transfer that had advanced while closed.
  //
  // So both tests now assert the observable consequence rather than a proxy for
  // it, and each one has its own mutation recorded next to it.
  it('closing mid-transfer stops the clock: reopening is back at the start', () => {
    const { getByText, queryByText, getAllByText } = render(<DemoPreview />);

    fireEvent.press(getByText(DEMO_LINK_TEXT));
    fireEvent.press(getByText('Send to my computer'));

    // Close one step in, while the remaining steps are still scheduled.
    act(() => {
      jest.advanceTimersByTime(800);
    });
    fireEvent.press(getAllByText('Close')[0]);

    // Let every timer that WAS scheduled come due while the sample is closed.
    act(() => {
      jest.advanceTimersByTime(10000);
    });

    fireEvent.press(getByText(DEMO_LINK_TEXT));

    // Uncleared, those timers would have run the transfer to completion behind a
    // closed sheet, and this reopen would land on a finished result nobody
    // watched happen.
    // MUTATION THAT GOES RED: drop `clearTimers()` from `handleClose`.
    expect(getByText('Send to my computer')).toBeTruthy();
    expect(queryByText(`${DEMO_MESSAGE_COUNT} messages delivered`)).toBeNull();

    assertNothingRealWasTouched();
  });

  it('reopening after a FINISHED transfer starts over, not on the result', () => {
    const { getByText, queryByText, getAllByText } = render(<DemoPreview />);

    // Run it all the way to the result box. This is the state that can persist
    // across a close, and the reason `handleClose` resets `stepsDone`.
    fireEvent.press(getByText(DEMO_LINK_TEXT));
    fireEvent.press(getByText('Send to my computer'));
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(getByText(`${DEMO_MESSAGE_COUNT} messages delivered`)).toBeTruthy();

    fireEvent.press(getAllByText('Close')[0]);
    fireEvent.press(getByText(DEMO_LINK_TEXT));

    // The next person to open it sees the whole sequence, not someone else's
    // finished result.
    // MUTATION THAT GOES RED: drop `setStepsDone(0)` from `handleClose`.
    expect(getByText('Send to my computer')).toBeTruthy();
    expect(queryByText(`${DEMO_MESSAGE_COUNT} messages delivered`)).toBeNull();

    assertNothingRealWasTouched();
  });

  it('accepts a host-supplied label without changing what it does', () => {
    const { getByText, queryByText } = render(
      <DemoPreview label="See how Keepr works — no account needed" />,
    );
    expect(getByText('See how Keepr works — no account needed')).toBeTruthy();
    expect(queryByText(DEMO_BANNER_TEXT)).toBeNull();
  });
});
