/**
 * Sample conversation fixture for the in-app preview — BACKLOG-3027.
 *
 * ## Why this file exists
 *
 * `com.keepr.companion` requests `READ_SMS`, which Google Play permits for this
 * app only under the named "Cross-device synchronization or transfer of SMS or
 * calls" exception — a row that is explicitly subject to review and approval and
 * that requires the core functionality to be prominently documented. A reviewer
 * who installs the APK has no Keepr desktop on their LAN, so before this existed
 * they could see the permission request and never see what it was for. This is
 * the data that lets them see it.
 *
 * ## Two rules this file must keep
 *
 * 1. **It imports NOTHING.** Not a service, not a type from `types/`. The whole
 *    point of the preview is that it reads no real messages and no real
 *    contacts, and a module with no imports cannot reach a reader by
 *    construction — no mock, no test and no future edit can quietly wire one in
 *    without the import showing up in review. The shapes below deliberately
 *    duplicate a little of `types/sync.ts` rather than importing it.
 *
 * 2. **Every value is invented, and safe on a public repo.** This ships inside
 *    the APK and lives in a public GitHub repository, so it is fixture data
 *    under the repo's PII rules (`scripts/ci/check-fixture-pii.mjs`):
 *      - the three names are already in that guard's `FICTIONAL_NAMES` set;
 *      - every number is in `555-0100`..`555-0199`, the NANP block reserved for
 *        fiction (ATIS-0300115), written as `+1 415 555-01xx`;
 *      - day labels are relative words, never dates. An ISO date is a digit run
 *        that the guard reads as phone-shaped, and a fixture that trips its own
 *        repo's guard gets baselined past, which is worse than no guard.
 *
 * Nothing here refers to a real person, a real property or a real transaction.
 */

/** One message in a sample thread. Mirrors the shape of a real SMS row. */
export interface DemoMessage {
  /** Stable key for rendering. Not a UUID, and not an Android row id. */
  id: string;
  /** Direction relative to the phone's owner, as in `types/sync.ts`. */
  direction: 'inbound' | 'outbound';
  /** Invented message text. */
  body: string;
  /** A relative day label ("Tuesday"), deliberately not a date. */
  day: string;
  /** A wall-clock time with no date attached. */
  time: string;
}

/** One sample conversation: a person, their number, and their thread. */
export interface DemoConversation {
  id: string;
  /** Invented name — see the fixture rules above. */
  name: string;
  /** E.164, reserved-for-fiction range. */
  phone: string;
  /** The same number formatted the way the app displays one. */
  displayPhone: string;
  /** Their part in the sample deal, so the thread reads as a real workflow. */
  role: string;
  messages: DemoMessage[];
}

/** The invented deal the sample threads belong to. */
export const DEMO_TRANSACTION_LABEL = '148 Alder Court';

/** The invented closing date shown on the desktop card. */
export const DEMO_TRANSACTION_DETAIL = 'Purchase · closing Friday';

/** The invented computer the sample sync delivers to. */
export const DEMO_DESKTOP_NAME = 'Sample Desktop';

/**
 * A private-LAN address, matching the shape `services/lanAddress.ts` accepts.
 * Invented, and unreachable by construction: the preview never opens a socket.
 */
export const DEMO_DESKTOP_ADDRESS = '192.168.1.42:8765';

export const DEMO_CONVERSATIONS: DemoConversation[] = [
  {
    id: 'demo-thread-buyer',
    name: 'Pat Riverton',
    phone: '+14155550142',
    displayPhone: '+1 415 555-0142',
    role: 'Buyer',
    messages: [
      {
        id: 'demo-buyer-1',
        direction: 'inbound',
        body: 'Morning! The earnest money went out from the bank about an hour ago.',
        day: 'Tuesday',
        time: '9:12 AM',
      },
      {
        id: 'demo-buyer-2',
        direction: 'outbound',
        body: 'Got it — I will let the title company know it is on the way.',
        day: 'Tuesday',
        time: '9:20 AM',
      },
      {
        id: 'demo-buyer-3',
        direction: 'inbound',
        body: 'Is the inspection still Thursday at 10?',
        day: 'Tuesday',
        time: '9:21 AM',
      },
      {
        id: 'demo-buyer-4',
        direction: 'outbound',
        body: 'Thursday at 10 is confirmed. I will meet you at the house.',
        day: 'Tuesday',
        time: '9:26 AM',
      },
    ],
  },
  {
    id: 'demo-thread-lender',
    name: 'Robin Marsh',
    phone: '+14155550118',
    displayPhone: '+1 415 555-0118',
    role: 'Loan officer',
    messages: [
      {
        id: 'demo-lender-1',
        direction: 'outbound',
        body: 'Any word on the appraisal for Alder Court?',
        day: 'Wednesday',
        time: '2:03 PM',
      },
      {
        id: 'demo-lender-2',
        direction: 'inbound',
        body: 'Came back at contract price. Underwriting has everything it needs now.',
        day: 'Wednesday',
        time: '2:40 PM',
      },
      {
        id: 'demo-lender-3',
        direction: 'outbound',
        body: 'That is a relief. I will pass it on to the buyers this afternoon.',
        day: 'Wednesday',
        time: '2:44 PM',
      },
    ],
  },
  {
    id: 'demo-thread-listing',
    name: 'Casey Lane',
    phone: '+14155550173',
    displayPhone: '+1 415 555-0173',
    role: 'Listing agent',
    messages: [
      {
        id: 'demo-listing-1',
        direction: 'inbound',
        body: 'Sellers accepted the repair credit. Addendum is coming over tonight.',
        day: 'Yesterday',
        time: '5:31 PM',
      },
      {
        id: 'demo-listing-2',
        direction: 'outbound',
        body: 'Perfect. So we are still on for Friday to close?',
        day: 'Yesterday',
        time: '5:35 PM',
      },
      {
        id: 'demo-listing-3',
        direction: 'inbound',
        body: 'Friday at 2, at the title office. See you there.',
        day: 'Yesterday',
        time: '5:36 PM',
      },
    ],
  },
];

/** Total sample messages, derived so the copy can never drift from the data. */
export const DEMO_MESSAGE_COUNT = DEMO_CONVERSATIONS.reduce(
  (total, conversation) => total + conversation.messages.length,
  0,
);

/** Sample conversation count, derived for the same reason. */
export const DEMO_CONVERSATION_COUNT = DEMO_CONVERSATIONS.length;

/**
 * The steps of the sample transfer, in order.
 *
 * These name what the real app does — read on the phone, encrypt on the phone,
 * send over the local network, land on the paired computer — because that
 * sequence IS the policy exception being relied on. A preview that showed a
 * message list and nothing else would show the reviewer the data and not the
 * cross-device transfer it is permitted for.
 *
 * Every step here is a `setTimeout` and a label. No socket is opened.
 */
export interface DemoSyncStep {
  id: string;
  label: string;
  detail: string;
}

export const DEMO_SYNC_STEPS: DemoSyncStep[] = [
  {
    id: 'read',
    label: 'Read on this phone',
    detail: `${DEMO_MESSAGE_COUNT} messages found in ${DEMO_CONVERSATION_COUNT} conversations`,
  },
  {
    id: 'encrypt',
    label: 'Encrypted on this phone',
    detail: 'Before anything leaves the device',
  },
  {
    id: 'send',
    label: 'Sent over your own Wi-Fi',
    detail: `Straight to ${DEMO_DESKTOP_NAME}, over your local network`,
  },
  {
    id: 'filed',
    label: 'Filed on your computer',
    detail: `Attached to ${DEMO_TRANSACTION_LABEL} in the Keepr desktop app`,
  },
];
