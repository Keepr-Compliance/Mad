// @vitest-environment jsdom

/**
 * BACKLOG-4186 PR D: every header of the rules card has an (i) button named "About <header>" whose
 * tip opens on click, closes on Escape, and is present for the owner (Edit) and the viewer (Rules).
 *
 * The header list below is written out by hand, NOT read from TIPS, so dropping a tip (or the
 * button that shows it) turns this red instead of shrinking the list it checks.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { RulesCard } from '@/app/dashboard/ai/sender-rules/RulesCard';
import { TIPS, type TipKey } from '@/lib/sender-rules/tips';

import { bundled } from './helpers';

/** Header text on the page -> the tip it must show. The card title differs by mode. */
const HEADERS: Array<[string, TipKey]> = [
  ['Hide mail from', 'hide'],
  ['Addresses', 'suppress.exactAddresses'],
  ['Domains', 'suppress.hosts'],
  ['Sender names', 'suppress.localParts'],
  ['Bulk headers', 'bulkHeaders'],
  ['Precedence values', 'suppress.bulkHeaders.precedenceValues'],
  ['Always keep', 'keep'],
  ['Platform domains', 'keep.platformHosts'],
  ['Platform addresses', 'keep.platformAddresses'],
  ['Free-mail domains', 'freeMailDomains'],
  ['Where each rule is live', 'modes'],
  ['Rule', 'rule'],
  ['Learn questions', 'learnQuestions'],
  ['Email matching', 'addressPass'],
  ['Deal detection', 'detector'],
  ['Thresholds', 'thresholds'],
  ['Minimum linked emails', 'minCensusLinkedEmails'],
  ['Report interval (hours)', 'reportSendIntervalHours'],
  ['Report rows (max 500)', 'reportMaxRows'],
];

function renderCard(readOnly: boolean) {
  const content = bundled();
  render(
    <RulesCard
      content={content}
      readOnly={readOnly}
      baseVersion={readOnly ? undefined : content.version}
      releasedVersion={content.version}
      onChange={readOnly ? undefined : () => undefined}
    />,
  );
}

afterEach(cleanup);

describe.each([
  ['owner', false, 'Edit'],
  ['viewer', true, 'Rules'],
] as const)('rules card tips (%s)', (_who, readOnly, title) => {
  const all: Array<[string, TipKey]> = [[title, 'card'], ...HEADERS];

  it('has exactly one named (i) button per header and no others', () => {
    renderCard(readOnly);
    const names = screen.getAllByRole('button', { name: /^About / }).map((b) => b.getAttribute('aria-label'));
    expect(names.sort()).toEqual(all.map(([h]) => `About ${h}`).sort());
  });

  it.each(all)('"%s" opens its tip on click and closes on Escape', (header, key) => {
    renderCard(readOnly);
    const button = screen.getByRole('button', { name: `About ${header}` });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(button);
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe(TIPS[key]);
    expect(TIPS[key].trim().length).toBeGreaterThan(0);
    // The tip is the button's accessible description while open.
    expect(button.getAttribute('aria-describedby')).toBe(tip.id);
    expect(button.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens on hover and closes on leaving', () => {
    renderCard(readOnly);
    const button = screen.getByRole('button', { name: 'About Thresholds' });
    fireEvent.mouseEnter(button.parentElement as HTMLElement);
    expect(screen.getByRole('tooltip').textContent).toBe(TIPS.thresholds);
    fireEvent.mouseLeave(button.parentElement as HTMLElement);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('tip copy', () => {
  it('every tip is at most two sentences', () => {
    for (const [key, text] of Object.entries(TIPS)) {
      const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
      expect({ key, n: sentences.length }).toEqual({ key, n: Math.min(sentences.length, 2) });
    }
  });

  it('says plainly that the two report thresholds are not read yet', () => {
    expect(TIPS.reportSendIntervalHours).toMatch(/^Not used yet\./);
    expect(TIPS.reportMaxRows).toMatch(/^Not used yet\./);
  });
});
