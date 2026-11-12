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
  nameLabel: 'The app calls itself: ',
  returnTo: (host: string) => `When you choose, you go back to ${host}.`,
  onlyIf: (provider: string) =>
    `Only continue if you just started connecting Keepr from ${provider}. Otherwise choose Deny.`,
  scope:
    'It can read the deals saved to Keepr Cloud, including hidden texts and emails waiting for review. It cannot change, send or delete anything.',
  agreement: (provider: string) =>
    `What ${provider} does with what it reads is covered by your agreement with ${provider}.`,
  disconnect:
    'You can disconnect it any time in Account > AI apps. Disconnecting does not delete what the app already received.',
  whatDisconnects: 'Turning Keepr Cloud off also disconnects every AI app. Signing out does not, including "Sign out all devices".',
  signedInAs: (email: string) => `Signed in as ${email}`,
  allow: 'Allow',
  deny: 'Deny',
  allowing: 'Connecting…',
  denying: 'Cancelling…',
} as const;

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
  intro: 'AI apps you allowed to read your Keepr data.',
  nameLabel: 'The app calls itself: ',
  sendsBackTo: (host: string) => `Sends you back to ${host}`,
  connected: (date: string) => `Connected ${date}`,
  lastUsed: (date: string) => `Last used ${date}`,
  notUsed: 'Not used yet',
  disconnect: 'Disconnect',
  disconnectAll: 'Disconnect all AI apps',
  confirmAll: 'Disconnect every AI app? They lose access right away. What they already received is not deleted.',
  accountLink: 'AI apps',
  allDevicesNote: 'This does not disconnect AI apps.',
} as const;

/** AI apps page and disconnect action messages. */
export const M_A = {
  empty: 'No AI apps are connected. To connect one, add Keepr as a connector in Claude or ChatGPT and sign in.',
  loadFailed: 'Keepr could not load your AI apps. Try again in a minute.',
  supportSession: 'Not available during a support session. End the support session, then try again.',
  disconnectFailed: 'Keepr could not disconnect this app. Try again.',
} as const;
