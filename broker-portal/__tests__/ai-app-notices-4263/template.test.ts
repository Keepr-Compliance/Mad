/**
 * @jest-environment node
 *
 * BACKLOG-4263 PR-10.8: the "an AI app was connected" email text.
 * The portal jest config sets TZ=America/Los_Angeles, so a local-time rendering differs from UTC.
 */

import {
  AI_APPS_PATH,
  PROVIDER_SHORT_NAMES,
  buildAiAppConnectedEmail,
  formatConnectedAt,
  type AiAppConnectedParams,
} from '@/lib/email/templates/ai-app-connected';
import { PROVIDER_LABELS } from '@/lib/mcp/account/messages';
import { buildSimpleNotice } from '@/lib/email/templates/simple-notice';

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]).sort();

const ORIGIN = 'https://portal.example.test';
const AT = '2026-11-18T14:05:56.767534+00:00';

function render(over: Partial<AiAppConnectedParams> = {}) {
  return buildAiAppConnectedEmail({ provider: 'anthropic', replaced: false, connectedAt: AT, portalOrigin: ORIGIN, ...over });
}

const CASES: Array<[string, AiAppConnectedParams, string, string[]]> = [
  [
    'Claude, first connection',
    { provider: 'anthropic', replaced: false, connectedAt: AT, portalOrigin: ORIGIN },
    'Claude was connected to your Keepr account',
    [
      'On 18 November 2026 at 14:05 UTC, you allowed Claude (Anthropic) to read your Keepr data.',
      'If this was you, you do not need to do anything.',
      'If it was not you, open AI apps and disconnect it.',
    ],
  ],
  [
    'Claude, replaced',
    { provider: 'anthropic', replaced: true, connectedAt: AT, portalOrigin: ORIGIN },
    'Claude was connected to your Keepr account',
    [
      'On 18 November 2026 at 14:05 UTC, you allowed Claude (Anthropic) to read your Keepr data.',
      'This replaces your earlier Claude connection.',
      'If this was you, you do not need to do anything.',
      'If it was not you, open AI apps and disconnect it.',
    ],
  ],
  [
    'ChatGPT, first connection',
    { provider: 'openai', replaced: false, connectedAt: AT, portalOrigin: ORIGIN },
    'ChatGPT was connected to your Keepr account',
    [
      'On 18 November 2026 at 14:05 UTC, you allowed ChatGPT (OpenAI) to read your Keepr data.',
      'If this was you, you do not need to do anything.',
      'If it was not you, open AI apps and disconnect it.',
    ],
  ],
  [
    'ChatGPT, replaced',
    { provider: 'openai', replaced: true, connectedAt: AT, portalOrigin: ORIGIN },
    'ChatGPT was connected to your Keepr account',
    [
      'On 18 November 2026 at 14:05 UTC, you allowed ChatGPT (OpenAI) to read your Keepr data.',
      'This replaces your earlier ChatGPT connection.',
      'If this was you, you do not need to do anything.',
      'If it was not you, open AI apps and disconnect it.',
    ],
  ],
];

describe('ai-app-connected email text', () => {
  it.each(CASES)('%s: exact subject, lines, button and text part', (_name, params, subject, lines) => {
    const mail = buildAiAppConnectedEmail(params);
    expect(mail.subject).toBe(subject);
    const url = `${ORIGIN}/dashboard/account/ai-apps`;
    expect(mail.text).toBe([subject, '', ...lines.flatMap((l) => [l, '']), `Open AI apps: ${url}`, ''].join('\n'));
    for (const line of lines) expect(mail.html).toContain(line);
    expect(mail.html).toContain(`href="${url}"`);
    expect(mail.html).toContain('Open AI apps');
    // The only link beyond the shared layout's own is the button.
    expect(hrefs(mail.html)).toEqual([url, ...hrefs(buildSimpleNotice('x', []).html)].sort());
  });

  it('the replaces line appears only when replaced is true', () => {
    expect(render({ replaced: false }).text).not.toContain('This replaces');
    expect(render({ replaced: true }).text).toContain('This replaces your earlier Claude connection.');
  });

  it('the long labels are PROVIDER_LABELS, and each starts with its short name', () => {
    expect(render({ provider: 'anthropic' }).text).toContain(`allowed ${PROVIDER_LABELS.anthropic} to read`);
    expect(render({ provider: 'openai' }).text).toContain(`allowed ${PROVIDER_LABELS.openai} to read`);
    expect(PROVIDER_LABELS.anthropic).toBe(`${PROVIDER_SHORT_NAMES.anthropic} (Anthropic)`);
    expect(PROVIDER_LABELS.openai).toBe(`${PROVIDER_SHORT_NAMES.openai} (OpenAI)`);
  });

  it('the button opens the AI apps page on the given origin; a trailing slash is not doubled', () => {
    expect(AI_APPS_PATH).toBe('/dashboard/account/ai-apps');
    expect(render({ portalOrigin: 'https://app.keeprcompliance.com/' }).text).toContain(
      'Open AI apps: https://app.keeprcompliance.com/dashboard/account/ai-apps\n',
    );
  });
});

describe('the date line is UTC, "D Month YYYY at HH:MM UTC"', () => {
  it.each([
    ['afternoon', '2026-11-18T14:05:56.767534+00:00', '18 November 2026 at 14:05 UTC'],
    ['single-digit day, morning', '2026-03-05T09:07:00+00:00', '5 March 2026 at 09:07 UTC'],
    ['midnight UTC (still the previous evening in Los Angeles)', '2026-01-01T00:00:00+00:00', '1 January 2026 at 00:00 UTC'],
    ['one minute before midnight', '2026-12-31T23:59:59.999999+00:00', '31 December 2026 at 23:59 UTC'],
    ['an offset other than UTC is converted', '2026-07-04T08:30:00-07:00', '4 July 2026 at 15:30 UTC'],
  ])('%s', (_l, iso, expected) => {
    expect(formatConnectedAt(iso)).toBe(expected);
    expect(render({ connectedAt: iso }).text).toContain(`On ${expected}, you allowed`);
  });

  it('this suite runs in a time zone other than UTC (so a local-time rendering would differ)', () => {
    expect(new Date('2026-01-01T00:00:00Z').getHours()).not.toBe(0);
  });
});

describe('only the four inputs can reach the email', () => {
  it('the parameter type has exactly provider, replaced, connectedAt and portalOrigin', () => {
    // Compile-time: a key added to or removed from AiAppConnectedParams breaks this line (ts-jest).
    const keys: Record<keyof AiAppConnectedParams, true> = { provider: true, replaced: true, connectedAt: true, portalOrigin: true };
    expect(Object.keys(keys).sort()).toEqual(['connectedAt', 'portalOrigin', 'provider', 'replaced']);
  });

  it('a notice object carrying extra keys renders exactly as one without them', () => {
    const hostile = {
      provider: 'anthropic' as const,
      replaced: true,
      connectedAt: AT,
      portalOrigin: ORIGIN,
      client_name: 'Claude ‮example.evil‬ https://evil.example/login',
      clientName: 'https://evil.example',
      redirect_uri: 'https://evil.example/callback',
      redirect_host: 'evil.example',
      id: 'notice-id-should-not-appear',
      deal: '123 Main St',
      token: 'tok_should_not_appear',
    };
    const withExtra = buildAiAppConnectedEmail(hostile as AiAppConnectedParams);
    const plain = buildAiAppConnectedEmail({ provider: 'anthropic', replaced: true, connectedAt: AT, portalOrigin: ORIGIN });
    expect(withExtra).toEqual(plain);
    const all = `${withExtra.subject}\n${withExtra.html}\n${withExtra.text}`;
    for (const bad of ['evil', '‮', '‬', 'notice-id', '123 Main', 'tok_']) expect(all).not.toContain(bad);
  });
});
