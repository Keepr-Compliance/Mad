/**
 * BACKLOG-2956 — CONTROL 2: consent is AFFIRMATIVE.
 *
 * Google Play does not accept implied consent for a prominent disclosure: the
 * user has to press something. "Continuing automatically does not count." So the
 * disclosure screen has exactly one advancing path — the consent button — and
 * mounting it, settling its effects, or scrolling it must record nothing and
 * navigate nowhere.
 *
 * MUTATION THAT MUST GO RED: add an auto-advance to disclosure.tsx, e.g. record
 * consent inside the mount effect —
 *     useEffect(() => { void recordDisclosureConsent();
 *                       router.replace('/onboarding/permissions'); }, []);
 * The "does not consent on its own" test then fails on both assertions.
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act, screen } from '@testing-library/react-native';

// --- expo-router ---
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

// --- The consent service under test at this call site. ---
const mockRecordDisclosureConsent = jest.fn(async () => undefined);
jest.mock('../../../services/disclosureConsent', () => ({
  recordDisclosureConsent: () => mockRecordDisclosureConsent(),
}));

// --- onboardingProgress: the screen persists its step on mount. ---
const mockSetOnboardingStep = jest.fn(async (_step: string) => undefined);
jest.mock('../../../services/onboardingProgress', () => ({
  setOnboardingStep: (step: string) => mockSetOnboardingStep(step),
}));

// --- components/ui barrel: faithful lightweight Button (same shape the other
// onboarding suites use), so getByText(title) + fireEvent.press behave as real. ---
jest.mock('../../../components/ui', () => {
  const ReactModule = require('react');
  const { Text, Pressable } = require('react-native');
  const MockButton = ({
    title,
    onPress,
    disabled,
    loading,
  }: {
    title: string;
    onPress: () => void;
    disabled?: boolean;
    loading?: boolean;
  }) =>
    ReactModule.createElement(
      Pressable,
      { onPress, disabled: disabled || loading, accessibilityRole: 'button' },
      ReactModule.createElement(Text, null, title),
    );
  return { Button: MockButton };
});

// --- The sign-out link: real component pulls authService -> expo-linking
// createURL() at module scope. Its behavior has its own suite. ---
jest.mock('../../../components/ui/OnboardingSignOutLink', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: () => ReactModule.createElement(Text, null, 'Sign out'),
  };
});

import DisclosureScreen from '../disclosure';
import { DEMO_BANNER_TEXT } from '../../../components/demo/DemoPreview';
import { DEMO_CONVERSATIONS } from '../../../components/demo/sampleConversations';

const CONSENT_BUTTON = 'Agree and Continue';

describe('DisclosureScreen — affirmative consent (BACKLOG-2956)', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockSetOnboardingStep.mockClear();
    mockRecordDisclosureConsent.mockReset().mockResolvedValue(undefined);
  });

  it('does not consent on its own: mounting and settling records nothing and navigates nowhere', async () => {
    render(<DisclosureScreen />);

    // Let every mount effect and microtask settle — an auto-advance would fire here.
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockRecordDisclosureConsent).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();

    // Proof the screen actually rendered, so the two "not called" assertions
    // above are a real refusal rather than an empty render.
    expect(screen.getByText(CONSENT_BUTTON)).toBeTruthy();
  });

  it('positive control: pressing the consent button records consent, THEN advances', async () => {
    render(<DisclosureScreen />);

    fireEvent.press(screen.getByText(CONSENT_BUTTON));

    await waitFor(() => {
      expect(mockRecordDisclosureConsent).toHaveBeenCalledTimes(1);
    });
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/permissions');
  });

  it('a failed consent write does NOT advance the user into the permission prompt', async () => {
    mockRecordDisclosureConsent.mockRejectedValue(new Error('storage full'));
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

    render(<DisclosureScreen />);
    fireEvent.press(screen.getByText(CONSENT_BUTTON));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalled();
    });
    // An unrecorded consent is an ungranted consent: stay on the disclosure.
    expect(mockReplace).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('persists its onboarding step on mount so an interruption resumes here', () => {
    render(<DisclosureScreen />);
    expect(mockSetOnboardingStep).toHaveBeenCalledWith('disclosure');
  });

  // The disclosure is legally load-bearing: Play requires it to state WHAT is
  // collected, WHY, that it is TRANSMITTED off the device, and — because this app
  // syncs from a background task — that it happens in the BACKGROUND. Silent
  // deletion of any of those is a compliance regression, so they are pinned here.
  it('states what is collected, why, that it is transmitted, and that it runs in the background', () => {
    render(<DisclosureScreen />);

    // What + why + transmission + background, in the lede sentence.
    expect(
      screen.getByText(/collects your text messages and contacts/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/sends them to the Keepr app on your own computer/i),
    ).toBeTruthy();
    expect(screen.getByText(/in the background, when this app is closed/i)).toBeTruthy();

    // The destination claim, stated where the user is looking at transmission.
    expect(screen.getByText(/sent over your local network/i)).toBeTruthy();
  });

  // BACKLOG-2956: the copy must not overstate collection. services/smsReader.ts
  // reads the SMS inbox and sent boxes only — there is no MMS reader anywhere in
  // the repo, and app.json declares no MMS permission. Claiming MMS here would
  // contradict the Play Data Safety declaration.
  it('does not claim to collect MMS, and says so explicitly', () => {
    render(<DisclosureScreen />);
    expect(
      screen.getByText(/does not read picture or group messages \(MMS\)/i),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-3045 — the three retired claims, and what replaced them.
//
// This screen is the Play prominent disclosure: `READ_SMS` is permitted here
// only by the "Cross-device synchronization of SMS" exception, which is subject
// to Play review and requires the disclosure to describe what the app actually
// does. Three claims did not, and all three had already shipped:
//
//   1. Title: "Your texts go to your own computer — and nowhere else."
//   2. "It is not sent to Keepr's servers. Your messages and contacts are
//      stored on your computer, not in the cloud."
//   3. "you can turn syncing off at any time in Settings"
//
// (1) and (2) are promises about a destination the PHONE does not control: the
// desktop uploads message bodies to Supabase on submission
// (electron/services/submissionService.ts sets body_text at :1216 and inserts
// submission_messages at :1300). (3) was untrue on its own terms —
// getBackgroundSyncEnabled() gates only expo-background-fetch registration, and
// appStateCatchup.runCatchupSync() calls performSync() on every foreground, so
// with the toggle OFF opening the app still reads texts and sends them.
//
// MUTATIONS THAT MUST GO RED — restore any retired sentence in disclosure.tsx
// and its matching "no longer promises" case fails:
//   · title back to "...— and nowhere else."          -> "nowhere else" case
//   · bullet back to "It is not sent to Keepr's
//     servers. ... not in the cloud."                 -> both server/cloud cases
//   · footnote back to "turn syncing off at any
//     time in Settings"                               -> the syncing-off case
// Deleting a replacement sentence fails its "says instead" case. These are text
// assertions, not a snapshot, so each one names the claim that broke.
// ---------------------------------------------------------------------------
describe('DisclosureScreen — retired claims stay retired (BACKLOG-3045)', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockSetOnboardingStep.mockClear();
    mockRecordDisclosureConsent.mockReset().mockResolvedValue(undefined);
  });

  it('no longer promises the texts go "nowhere else"', () => {
    render(<DisclosureScreen />);
    expect(screen.queryByText(/nowhere else/i)).toBeNull();
  });

  it('no longer promises the data is not sent to Keepr’s servers', () => {
    render(<DisclosureScreen />);
    expect(screen.queryByText(/not\s+sent to Keepr['’]s servers/i)).toBeNull();
    // The unscoped form, in any phrasing that reaches the user.
    expect(screen.queryByText(/sent to Keepr['’]s servers/i)).toBeNull();
  });

  it('no longer promises the data is stored on your computer, not in the cloud', () => {
    render(<DisclosureScreen />);
    expect(screen.queryByText(/not in the cloud/i)).toBeNull();
    expect(screen.queryByText(/stored on your computer/i)).toBeNull();
  });

  it('no longer promises syncing can be turned off in Settings', () => {
    render(<DisclosureScreen />);
    expect(screen.queryByText(/turn syncing off at any time/i)).toBeNull();
  });

  // The replacements. Deleting the negative claims was not a licence to go
  // vague: a disclosure that says nothing specific fails the same policy from
  // the other direction, so the destination is still named concretely.
  it('says instead what THIS PHONE sends, and where', () => {
    render(<DisclosureScreen />);

    // Destination, still concrete: encrypted, local network, the paired computer.
    expect(screen.getByText(/encrypted on this phone/i)).toBeTruthy();
    expect(screen.getByText(/sent over your local network/i)).toBeTruthy();

    // Scoped to this app, which is the claim the phone can actually keep.
    expect(
      screen.getByText(/only.*place this app sends them/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/messages and contacts do not/i),
    ).toBeTruthy();
  });

  it('hands the desktop’s behaviour to the desktop instead of promising it', () => {
    render(<DisclosureScreen />);
    expect(
      screen.getByText(/done by the Keepr app there, not by this app/i),
    ).toBeTruthy();
    // Naming submission is the point: it is the path that made the old claim
    // false, and the user is told it exists rather than told it does not.
    expect(
      screen.getByText(/submitting a transaction to\s+your brokerage/i),
    ).toBeTruthy();
  });

  it('names BOTH Settings sync controls as schedule-only, and Unpair as the real off switch', () => {
    render(<DisclosureScreen />);
    // NEITHER control stops syncing. getBackgroundSyncEnabled() and
    // getSyncInterval() each have exactly one non-UI reader, both inside
    // startBackgroundSync(), which only registers/unregisters the
    // expo-background-fetch task. appStateCatchup.runCatchupSync() calls
    // performSync() on every foreground transition regardless of either.
    expect(
      screen.getByText(
        /Background Sync and Sync Interval control the scheduled sync/i,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/still syncs when you open it/i),
    ).toBeTruthy();
    // Unpair is the one that actually stops it: runSyncCycle returns at its
    // loadPairingInfo() gate before the SMS read.
    expect(
      screen.getByText(/Unpair Device stops syncing\s+altogether/i),
    ).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // SR review, BACKLOG-3045 — B1. The bullet said "Names and phone numbers".
  // contactReader.ts:40-46 requests SIX fields (FirstName, LastName,
  // PhoneNumbers, Emails, Company, JobTitle); mapToSyncContact (:159-183) maps
  // emails/company/title into SyncContact; syncService.sendContacts (:355) puts
  // the whole array on the wire unfiltered. Under-reporting collection fails
  // Play the same way over-promising does. Wording is the founder's, verbatim.
  //
  // MUTATION THAT MUST GO RED: drop any of the three added field names from the
  // bullet in disclosure.tsx — this case fails on that name.
  // -------------------------------------------------------------------------
  it('does not understate contact collection: names emails, company and job title', () => {
    render(<DisclosureScreen />);

    expect(
      screen.getByText(
        /Names, phone numbers, email addresses, and any company or job title\s+saved with them/i,
      ),
    ).toBeTruthy();

    // Each added field pinned on its own, so a partial deletion names itself
    // instead of hiding inside the sentence matcher above.
    expect(screen.getByText(/email addresses/i)).toBeTruthy();
    expect(screen.getByText(/company or job title/i)).toBeTruthy();

    // The retired under-statement must not come back.
    expect(
      screen.queryByText(/Names and phone numbers from this phone/i),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SR review, BACKLOG-3045 — I1. The "What this app never does" card.
//
// SR proved by deletion that two of its three bullets were unpinned: removing
// either left 16/16 green. Both are Play-load-bearing.
//
// "It never sends, forwards or replies to a text message" is what keeps this app
// out of the "default SMS handler / messaging app" reading of the SMS policy —
// arguably the most load-bearing sentence on the screen after the transmission
// disclosure. There is no send path anywhere in android-companion/ and app.json
// declares no SEND_SMS; the sentence is true, and it must not be silently
// deletable.
//
// MUTATIONS THAT MUST GO RED — delete either bullet from disclosure.tsx and its
// own case here fails.
// ---------------------------------------------------------------------------
describe('DisclosureScreen — "never does" claims are pinned (BACKLOG-3045 I1)', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockSetOnboardingStep.mockClear();
    mockRecordDisclosureConsent.mockReset().mockResolvedValue(undefined);
  });

  it('keeps the no-send claim, which is what keeps this out of "messaging app" territory', () => {
    render(<DisclosureScreen />);
    expect(
      screen.getByText(/never sends, forwards or replies to a text message/i),
    ).toBeTruthy();
  });

  it('keeps the no-sell-or-share claim', () => {
    render(<DisclosureScreen />);
    expect(
      screen.getByText(
        /does not sell or share your messages or contacts with anyone/i,
      ),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-3027 — the sample preview is reachable from the disclosure screen.
//
// Deliberately hosted BELOW the consent action, so it competes with nothing
// Play requires here: it only lets someone SEE what they are being asked to
// consent to before they consent to it. Opening it must not record consent —
// consent the user did not actively give is not consent (the rule this screen's
// own mount effect already keeps).
//
// MUTATION THAT MUST GO RED: delete `<DemoPreview />` from
// app/onboarding/disclosure.tsx — all three tests below fail.
// ---------------------------------------------------------------------------
describe('disclosure — sample preview entry point (BACKLOG-3027)', () => {
  it('offers the sample, and does not show it unasked', () => {
    render(<DisclosureScreen />);

    expect(screen.getByText(/See how Keepr works/i)).toBeTruthy();
    expect(screen.queryByText(DEMO_BANNER_TEXT)).toBeNull();
  });

  it('shows real sample content when tapped', () => {
    render(<DisclosureScreen />);

    fireEvent.press(screen.getByText(/See how Keepr works/i));

    expect(screen.getByText(DEMO_BANNER_TEXT)).toBeTruthy();
    expect(
      screen.getByText(DEMO_CONVERSATIONS[0].messages[0].body),
    ).toBeTruthy();
  });

  it('opening the sample records NO consent and does not advance the flow', () => {
    render(<DisclosureScreen />);

    fireEvent.press(screen.getByText(/See how Keepr works/i));

    expect(screen.getByText(DEMO_BANNER_TEXT)).toBeTruthy();
    expect(mockRecordDisclosureConsent).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
