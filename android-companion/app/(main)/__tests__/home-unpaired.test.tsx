/**
 * BACKLOG-2956 — CONTROL 3b: the screens the skip lands on render in EMPTY
 * STATE, and do not throw.
 *
 * "Continue without a computer" on the pairing screen drops the user into the
 * real app with no pairing. The requirement is explicitly empty state — no demo
 * mode, no sample data, no fake content — and the empty state has to read as
 * deliberate rather than broken. This suite pins that home renders that state
 * without throwing when AsyncStorage holds NO `@keepr/pairing` entry.
 *
 * BACKLOG-3027 NARROWED THAT CLAIM, and the tests below say exactly how. The
 * screen still renders NO sample data of its own — no fake message counts, no
 * fake desktop, nothing a user could mistake for their own — and the assertions
 * pinning that are unchanged. What is new is a LINK offering a labelled sample
 * behind an explicit tap, because 2956 removed the wall and this empty state is
 * what it escapes TO: a Play reviewer who took the escape hatch arrived here and
 * still learned nothing about why the app asked to read their texts.
 *
 * Note this is not a new state invented for the skip: it is already reachable in
 * production, because a sign-out clears the pairing (`reconcilePairingForAuthChange`)
 * and re-login lands an already-onboarded user on an unpaired home. The skip
 * reuses an exercised path.
 *
 * MUTATION THAT MUST GO RED: remove the `if (!pairing) { ... }` early return from
 * app/(main)/home.tsx — home then falls through to the paired render and
 * dereferences `pairing.pairedAt` / `pairing.deviceName` on null, so the render
 * throws and every test below fails.
 *
 * Scaffold mirrors app/(main)/__tests__/home.test.tsx (the established pattern in
 * this directory is one scaffold per behavior file), with ONE deliberate change:
 * the AsyncStorage store starts EMPTY, so home takes the Not-Paired branch.
 */
import React from 'react';
import { render, waitFor, screen, fireEvent } from '@testing-library/react-native';
import type { SmsPermissionResult } from '../../../services/permissions';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useFocusEffect: jest.fn(),
}));

jest.mock('expo-linking', () => ({
  createURL: (path: string) => `keepr-companion://${path}`,
}));

jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [{ granted: true }, jest.fn()],
  CameraView: () => null,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// --- AsyncStorage: EMPTY. This is the whole point of the suite — no
// `@keepr/pairing` entry, exactly as after "Continue without a computer". ---
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {};
  return {
    __store: store,
    getItem: jest.fn(async (k: string) => store[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => {
      store[k] = v;
    }),
    removeItem: jest.fn(async (k: string) => {
      delete store[k];
    }),
  };
});

const mockCheckSmsPermissions = jest.fn<Promise<SmsPermissionResult>, []>();
jest.mock('../../../services/permissions', () => ({
  checkSmsPermissions: () => mockCheckSmsPermissions(),
  requestSmsPermissions: jest.fn(async () => ({
    readSms: 'granted',
    receiveSms: 'granted',
    allGranted: true,
  })),
  requestContactsPermissions: jest.fn(async () => ({
    readContacts: 'granted',
    granted: true,
  })),
}));

jest.mock('../../../services/backgroundSync', () => ({
  startBackgroundSync: jest.fn(async () => undefined),
  stopBackgroundSync: jest.fn(async () => undefined),
  performSync: jest.fn(async () => ({
    newMessages: 0,
    sentMessages: 0,
    contactsSynced: 0,
    newContacts: 0,
    desktopReachable: false,
    queueSize: 0,
  })),
  isBackgroundSyncActive: jest.fn(async () => false),
}));

jest.mock('../../../services/smsQueueService', () => ({
  // BACKLOG-3005 (busy-state fold): home reads the shared sync lock to grey the
  // Sync Now button for syncs it did not start. An omitted method here reads as
  // the feature not firing (the trap syncServiceLanGuard.test.ts documents).
  isSyncInFlight: jest.fn(async () => false),
  resetAllSyncData: jest.fn(async () => undefined),
  getSyncStats: jest.fn(async () => null),
  getQueueSize: jest.fn(async () => 0),
  getBackgroundSyncEnabled: jest.fn(async () => false),
}));

jest.mock('../../../services/syncStaleness', () => ({
  getSyncFreshness: () => ({ status: 'fresh' }),
  formatRelativeTime: () => 'just now',
}));

jest.mock('../../../services/batteryOptimization', () => ({
  shouldPromptBatteryOptimization: () => false,
  openBatteryOptimizationSettings: jest.fn(async () => true),
  getBatteryOptPromptDismissed: jest.fn(async () => false),
  setBatteryOptPromptDismissed: jest.fn(async () => undefined),
}));

jest.mock('../../../services/syncService', () => ({
  registerDevice: jest.fn(async () => ({ success: true })),
}));

jest.mock('../../../services/contactSyncState', () => ({
  forceFullContactResync: jest.fn(async () => undefined),
}));

jest.mock('../../../services/accountMatch', () => ({
  checkDesktopAccountMatch: jest.fn(async () => ({ ok: true })),
  accountMatchMessage: () => ({ title: '', body: '' }),
}));

jest.mock('../../../services/authService', () => ({
  getSession: jest.fn(async () => null),
}));

jest.mock('../../../components/ui', () => {
  const ReactModule = require('react');
  const { Text, Pressable, View } = require('react-native');
  const Button = ({ title, onPress }: { title: string; onPress?: () => void }) =>
    ReactModule.createElement(
      Pressable,
      { onPress, accessibilityRole: 'button' },
      ReactModule.createElement(Text, null, title),
    );
  const Card = ({
    title,
    children,
  }: {
    title?: string;
    children?: React.ReactNode;
  }) =>
    ReactModule.createElement(
      View,
      null,
      title ? ReactModule.createElement(Text, null, title) : null,
      children,
    );
  const CardRow = ({ label, value }: { label: string; value: string }) =>
    ReactModule.createElement(Text, null, `${label} ${value}`);
  const CardDivider = () => null;
  const StatusBadge = ({ label }: { label: string }) =>
    ReactModule.createElement(Text, null, label);
  const Header = () => null;
  const Avatar = () => null;
  const SupportButton = () => null;
  const NavBarFooter = () => null;
  return {
    Button,
    Card,
    CardRow,
    CardDivider,
    StatusBadge,
    Header,
    Avatar,
    SupportButton,
    NavBarFooter,
  };
});

import HomeScreen from '../home';
import { DEMO_BANNER_TEXT } from '../../../components/demo/DemoPreview';
import { DEMO_CONVERSATIONS } from '../../../components/demo/sampleConversations';

describe('home — unpaired empty state after "Continue without a computer" (BACKLOG-2956)', () => {
  beforeEach(() => {
    mockCheckSmsPermissions.mockReset().mockResolvedValue({
      readSms: 'granted',
      receiveSms: 'granted',
      allGranted: true,
    });
  });

  it('renders the real home screen without throwing when there is no pairing', async () => {
    expect(() => render(<HomeScreen />)).not.toThrow();

    // Settle the mount loads (AsyncStorage reads, permission check, stats) — a
    // throw in an async render path would surface here rather than at mount.
    await waitFor(() => {
      expect(screen.getByText('Not Paired')).toBeTruthy();
    });
  });

  it('the empty state reads as deliberate, and offers the way to pair', async () => {
    render(<HomeScreen />);

    await waitFor(() => {
      expect(screen.getByText('Not Paired')).toBeTruthy();
    });

    // Deliberate: it explains the state and names the next action.
    expect(screen.getByText('Pair with Keepr')).toBeTruthy();
    expect(
      screen.getByText(/Scan the QR code displayed in the Keepr desktop application/i),
    ).toBeTruthy();

    // Pairing stays one tap away, so the skip is not a one-way door.
    expect(screen.getByText('Scan QR Code')).toBeTruthy();
  });

  it('shows no sample data: no message counts or fake desktop are rendered', async () => {
    render(<HomeScreen />);

    await waitFor(() => {
      expect(screen.getByText('Not Paired')).toBeTruthy();
    });

    // The paired dashboard's rows must be absent — an empty state, not a demo.
    expect(screen.queryByText(/^Desktop /)).toBeNull();
    expect(screen.queryByText(/^Sent to Desktop /)).toBeNull();
    expect(screen.queryByText('Sync Results')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-3027 — the sample preview is reachable from the state BACKLOG-2956's
// escape hatch actually lands on.
//
// This is the dead end as it exists TODAY. 2956 already removed the hard wall
// the item describes ("no skip, no demo mode, no way past the pairing screen"),
// so the reviewer is no longer stuck on the QR screen — they are here, on an
// empty state that answers none of their questions. The entry point has to be
// on this screen or the fix misses where people actually end up.
//
// MUTATION THAT MUST GO RED: delete `<DemoPreview />` from the `if (!pairing)`
// branch of app/(main)/home.tsx — both tests below fail.
// ---------------------------------------------------------------------------
describe('home (unpaired) — sample preview entry point (BACKLOG-3027)', () => {
  it('offers the sample, and does not show it unasked', async () => {
    render(<HomeScreen />);

    await waitFor(() => {
      expect(screen.getByText('Not Paired')).toBeTruthy();
    });

    expect(screen.getByText(/See how Keepr works/i)).toBeTruthy();
    // Still an empty state until asked: no sample content on screen.
    expect(screen.queryByText(DEMO_BANNER_TEXT)).toBeNull();
    expect(
      screen.queryByText(DEMO_CONVERSATIONS[0].messages[0].body),
    ).toBeNull();
  });

  it('shows real sample content when tapped, and never writes a pairing', async () => {
    const storage = jest.requireMock(
      '@react-native-async-storage/async-storage',
    ) as { setItem: jest.Mock; removeItem: jest.Mock };
    storage.setItem.mockClear();
    storage.removeItem.mockClear();

    render(<HomeScreen />);

    await waitFor(() => {
      expect(screen.getByText('Not Paired')).toBeTruthy();
    });

    fireEvent.press(screen.getByText(/See how Keepr works/i));

    // POSITIVE FIRST: the sample is genuinely on screen.
    expect(screen.getByText(DEMO_BANNER_TEXT)).toBeTruthy();
    expect(
      screen.getByText(DEMO_CONVERSATIONS[0].messages[0].body),
    ).toBeTruthy();

    // NEGATIVE SECOND: viewing the sample left the phone unpaired. `setItem` /
    // `removeItem` between them cover the pairing record, the device identity
    // and the sync cursor.
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(screen.getByText('Not Paired')).toBeTruthy();
  });
});
