/**
 * Every user-visible string of the consent page and the AI apps page
 * (BACKLOG-4238). No database text is ever shown; refusal codes map to these.
 */

export type Provider = 'anthropic' | 'openai';

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Claude (Anthropic)',
  openai: 'ChatGPT (OpenAI)',
};

export function isProvider(v: unknown): v is Provider {
  return v === 'anthropic' || v === 'openai';
}

export const CONSENT = {
  lead: (provider: string) => `${provider} wants to read your Keepr data.`,
  nameLabel: 'Name the app gave itself (not checked by Keepr): ',
  nameHost: (host: string) => `. It sends you back to ${host}.`,
  replaces: (provider: string) => `You already connected ${provider}. Allowing this replaces that connection.`,
  onlyIf: (provider: string) =>
    `Only continue if you just started connecting Keepr from ${provider}. Otherwise choose Deny.`,
  scope:
    'It can read the deals you saved to Keepr Cloud: details, prices, commission, checklists (including private ones) and todos. ' +
    'It can also read the people on each deal, with their names, companies, email addresses, phone numbers and notes. ' +
    'It cannot read your emails, texts, files or contact list. ' +
    'It cannot change, send or delete anything.',
  agreement: (provider: string) =>
    `What it reads, including other people's contact details, is sent to ${provider}. ` +
    `What ${provider} does with it is covered by your agreement with ${provider}.`,
  disconnect:
    'You can disconnect it any time in Account > AI apps. Disconnecting does not delete what the app already received.',
  whatDisconnects:
    'Turning Keepr Cloud off deletes your online copy and disconnects every AI app. ' +
    'Signing out does not disconnect them, including "Sign out all devices".',
  signedInAs: (email: string) => `Signed in as ${email}`,
  /** BACKLOG-4263 PR-10.5 (founder decision B): the request's age, as the database computed it. */
  startedAgo: (seconds: number) => {
    if (seconds === 0) return 'This request was started just now.';
    if (seconds === 1) return 'This request was started 1 second ago.';
    if (seconds > 180) return 'This request was started more than 3 minutes ago.';
    return `This request was started ${seconds} seconds ago.`;
  },
  /** BACKLOG-4263 PR-5 (founder decision Q4): the wording when approving grants 'mcp:todos'. */
  write: {
    lead: (provider: string) => `${provider} wants to use your Keepr data.`,
    scope:
      'It can read the deals you saved to Keepr Cloud: details, prices, commission, checklists (including private ones) and todos, ' +
      'and the people on each deal with their names, companies, email addresses, phone numbers and notes. ' +
      'It can tick, add, edit and remove your todos and set their notes and due dates. ' +
      'It cannot read, send or delete your emails or texts, cannot read your files or contact list, and cannot change anything else.',
    changes: 'Every change shows which app made it. You can see every change in Keepr and restore removed todos for 30 days.',
  },
  allow: 'Allow',
  deny: 'Deny',
  allowing: 'Connecting…',
  denying: 'Cancelling…',
} as const;

/**
 * BACKLOG-4263 P11: approval page version 2. A connection approved on version 2 or later may read the emails and texts
 * attached to the person's deals. The page renders exactly the version the database's view answers (NOTICE_TEXT);
 * any other version shows M_C.noticeVersion. Version 1 is CONSENT above, unchanged.
 */
export const CONSENT_V2 = {
  ...CONSENT,
  scope:
    'It can read the deals you saved to Keepr Cloud: details, prices, commission, checklists (including private ones) and todos. ' +
    'It can also read the people on each deal, with their names, companies, email addresses, phone numbers and notes. ' +
    'It can also read the emails and texts attached to each deal, including emails Keepr matched by a contact only (marked Needs review) ' +
    'and texts you hid from exports. Each one is marked so the app can tell you. ' +
    'It sees the names, types and sizes of attached files, but cannot open them. ' +
    'It cannot read your other emails or texts, or your contact list. ' +
    'It cannot change, send or delete anything.',
  agreement: (provider: string) =>
    `What it reads, including other people's contact details, emails and texts, is sent to ${provider}. ` +
    `What ${provider} does with it is covered by your agreement with ${provider}.`,
  readLog: 'Keepr keeps a list of every email and text the app reads. You can see it in Account > AI apps.',
  write: {
    ...CONSENT.write,
    scope:
      'It can read the deals you saved to Keepr Cloud: details, prices, commission, checklists (including private ones) and todos, ' +
      'and the people on each deal with their names, companies, email addresses, phone numbers and notes. ' +
      'It can also read the emails and texts attached to each deal, including ones marked Needs review or hidden from exports, ' +
      "and see attached files' names, types and sizes. " +
      'It can tick, add, edit and remove your todos and set their notes and due dates. ' +
      'It cannot open files, send or delete emails or texts, read your contact list, or change anything else.',
  },
} as const;

/** What the approval page shows; every version has these, version 2 adds readLog. */
export interface ConsentText {
  lead: (_provider: string) => string;
  nameLabel: string;
  nameHost: (_host: string) => string;
  replaces: (_provider: string) => string;
  onlyIf: (_provider: string) => string;
  scope: string;
  agreement: (_provider: string) => string;
  readLog?: string;
  disconnect: string;
  whatDisconnects: string;
  signedInAs: (_email: string) => string;
  startedAgo: (_seconds: number) => string;
  write: { lead: (_provider: string) => string; scope: string; changes: string };
}

/** The approval page text per version the database answers. A version not listed here cannot be approved on this page. */
export const NOTICE_TEXT: Readonly<Record<number, ConsentText>> = { 1: CONSENT, 2: CONSENT_V2 };

/** Consent page and consent action messages. */
export const M_C = {
  badId: 'This connection request is not valid. Go back to the app you came from and start again.',
  supportSession: 'Connecting an AI app is not available during a support session. End the support session, then try again.',
  misconfigured: 'AI app connections are not available right now.',
  noBinding:
    'This request was started in a different browser, or it has expired. Go back to the app and connect again.',
  noticeVersion: 'This page needs an update before you can connect. Try again later.',
  requestInvalid: 'This connection request has expired or was already used. Go back to the app and connect again.',
  disabled: 'AI app connections are turned off right now.',
  failed: 'Keepr could not complete this request. Try again in a minute.',
  notEntitled: 'Connecting an AI app needs Keepr Cloud on your account.',
  noReturn: 'Keepr could not send you back to the app. Go back to the app and connect again.',
  sessionEnded: 'Your session ended. Sign in again, then go back to the app and connect again.',
} as const;

export const AI_APPS = {
  intro: 'AI apps you connected to your Keepr data.',
  nameLabel: 'The app calls itself: ',
  sendsBackTo: (host: string) => `Sends you back to ${host}`,
  connected: (date: string) => `Approved ${date} UTC`,
  lastUsed: (date: string) => `Last used ${date}`,
  notUsed: 'Not used yet',
  // BACKLOG-4263 PR-6: what the connection was granted (the write switch decides separately whether writes run)
  allowedTodos: 'Allowed: read your deals and change your todos.',
  allowedRead: 'Allowed: read your deals.',
  // BACKLOG-4263 P11: the connection was approved on approval page version 2 or later (mcp_list_my_connection_access)
  allowedTodosMessages: 'Allowed: read your deals and the emails and texts attached to them, and change your todos.',
  allowedReadMessages: 'Allowed: read your deals and the emails and texts attached to them.',
  noMessages: 'This app cannot read emails or texts. To allow it, connect it again from the app.',
  disconnect: 'Disconnect',
  disconnectAll: 'Disconnect all AI apps',
  confirmAll: 'Disconnect every AI app? They lose access right away. What they already received is not deleted.',
  accountLink: 'AI apps',
  more: (n: number) => `+${n} more`,
  allDevicesNote: 'This does not disconnect AI apps.',
  // BACKLOG-4263: shown above the list when at least one connection is listed
  disconnectHere: 'Disconnecting in the AI app does not disconnect it here. To disconnect here, use Disconnect on this page.',
} as const;

/** BACKLOG-4263 P11: the "Emails and texts read by AI apps" section of the AI apps page (mcp_list_my_message_reads). */
export const AI_READS = {
  title: 'Emails and texts read by AI apps',
  empty: 'No AI app has read your emails or texts.',
  retention:
    'This list is kept for one year, also after you disconnect an app or turn Keepr Cloud off. ' +
    'Once an email or text is no longer online, its entry no longer shows the sender or subject.',
  more: 'Show more',
  loadFailed: 'Keepr could not load this list. Try again in a minute.',
  /** "an email" / "a text" */
  kind: (channel: 'email' | 'text') => (channel === 'text' ? 'a text' : 'an email'),
  /** list_deal_messages returned a preview; get_message returned the message (one part of it) */
  verb: (tool: 'list_deal_messages' | 'get_message') => (tool === 'get_message' ? 'opened' : 'saw the preview of'),
  part: (n: number) => ` (part ${n})`,
  from: (sender: string) => ` from ${sender}`,
  subject: (subject: string) => `: ${subject}`,
  sent: (date: string) => ` sent ${date}`,
  removedFromDeal: ' that was later removed from this deal',
  dealDeleted: ' from a deal that was deleted',
  read: 'read',
} as const;

/** AI apps page and disconnect action messages. */
export const M_A = {
  empty: 'No AI apps are connected. To connect one, add Keepr as a connector in Claude or ChatGPT and sign in.',
  loadFailed: 'Keepr could not load your AI apps. Try again in a minute.',
  supportSession: 'Not available during a support session. End the support session, then try again.',
  disconnectFailed: 'Keepr could not disconnect this app. Try again.',
} as const;
