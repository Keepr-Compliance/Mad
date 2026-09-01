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

  it('accepts a host-supplied label without changing what it does', () => {
    const { getByText, queryByText } = render(
      <DemoPreview label="See how Keepr works — no account needed" />,
    );
    expect(getByText('See how Keepr works — no account needed')).toBeTruthy();
    expect(queryByText(DEMO_BANNER_TEXT)).toBeNull();
  });
});
