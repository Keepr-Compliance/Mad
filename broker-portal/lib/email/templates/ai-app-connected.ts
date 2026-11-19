/**
 * "Claude was connected to your Keepr account" (BACKLOG-4263 PR-10.8): sent a few minutes after an
 * AI app's connection to the person's Keepr account turns active. Founder-approved wording.
 *
 * The only inputs are the four fields below. The app-chosen client name, the redirect host, deal
 * or contact data, tokens and the notice id never reach this module, so they cannot appear in the
 * email. Layout: buildSimpleNotice, like the other short notices.
 */

import { buildSimpleNotice } from './simple-notice';
import { PROVIDER_LABELS, type Provider } from '@/lib/mcp/account/messages';
import type { EmailContent } from '../types';

export interface AiAppConnectedParams {
  provider: Provider;
  /** The connection replaced the person's earlier connection of the same provider. */
  replaced: boolean;
  /** When the connection turned active (the notice's connected_at, ISO 8601). */
  connectedAt: string;
  /** The portal's own origin, e.g. https://app.keeprcompliance.com (no trailing slash). */
  portalOrigin: string;
}

/** Short app names for the subject and the "replaces" line; PROVIDER_LABELS has the long form. */
export const PROVIDER_SHORT_NAMES: Record<Provider, string> = {
  anthropic: 'Claude',
  openai: 'ChatGPT',
};

export const AI_APPS_PATH = '/dashboard/account/ai-apps';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** "18 November 2026 at 14:05 UTC": UTC, English month, 24-hour clock, no leading zero on the day. */
export function formatConnectedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error('connectedAt is not a valid time');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} at ${hh}:${mm} UTC`;
}

export function aiAppConnectedSubject(provider: Provider): string {
  return `${PROVIDER_SHORT_NAMES[provider]} was connected to your Keepr account`;
}

export function aiAppConnectedLines(params: AiAppConnectedParams): string[] {
  const { provider, replaced, connectedAt } = params;
  const lines = [`On ${formatConnectedAt(connectedAt)}, you allowed ${PROVIDER_LABELS[provider]} to read your Keepr data.`];
  if (replaced === true) lines.push(`This replaces your earlier ${PROVIDER_SHORT_NAMES[provider]} connection.`);
  lines.push('If this was you, you do not need to do anything.');
  lines.push(
    `If you did not start this from your own ${PROVIDER_SHORT_NAMES[provider]} account just before allowing it, open AI apps and disconnect it now — even if you clicked Allow.`,
  );
  return lines;
}

export function buildAiAppConnectedEmail(params: AiAppConnectedParams): EmailContent {
  const origin = params.portalOrigin.replace(/\/+$/, '');
  return buildSimpleNotice(aiAppConnectedSubject(params.provider), aiAppConnectedLines(params), [
    { label: 'Open AI apps', url: `${origin}${AI_APPS_PATH}` },
  ]);
}
