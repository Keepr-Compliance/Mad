// @vitest-environment jsdom

/**
 * BACKLOG-4186 PR D: every header of the rules card has an (i) button named "About <header>" whose
 * tip opens on click, closes on Escape, and is present for the owner (Edit) and the viewer (Rules).
 *
 * The header list below is written out by hand, NOT read from TIPS, so dropping a tip (or the
 * button that shows it) turns this red instead of shrinking the list it checks.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

  it('opens on hover, stays while the pointer crosses to the tip, closes on leaving', () => {
    vi.useFakeTimers();
    try {
      renderCard(readOnly);
      const button = screen.getByRole('button', { name: 'About Thresholds' });
      fireEvent.mouseEnter(button.parentElement as HTMLElement);
      const tip = screen.getByRole('tooltip');
      expect(tip.textContent).toBe(TIPS.thresholds);
      fireEvent.mouseLeave(button.parentElement as HTMLElement);
      fireEvent.mouseEnter(tip);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByRole('tooltip').textContent).toBe(TIPS.thresholds);
      fireEvent.mouseLeave(tip);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Escape closes a hover-opened tip while focus is elsewhere (WCAG 1.4.13)', () => {
    renderCard(readOnly);
    const button = screen.getByRole('button', { name: 'About Deal detection' });
    fireEvent.mouseEnter(button.parentElement as HTMLElement);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    expect(document.activeElement).not.toBe(button);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('column tips are not clipped by the scrolling modes table', () => {
  const realWidth = window.innerWidth;
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: realWidth });
    vi.restoreAllMocks();
  });

  it('renders outside the overflow box, fixed, and kept inside a narrow window', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    renderCard(true);
    const button = screen.getByRole('button', { name: 'About Deal detection' });
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      left: 300, right: 314, top: 100, bottom: 114, width: 14, height: 14, x: 300, y: 100, toJSON: () => ({}),
    } as DOMRect);
    expect(button.closest('.overflow-x-auto')).not.toBeNull();
    fireEvent.click(button);
    const tip = screen.getByRole('tooltip');
    expect(tip.closest('.overflow-x-auto')).toBeNull();
    expect(tip.style.position).toBe('fixed');
    expect(tip.style.top).toBe('118px');
    // 320 wide window, 256 wide tip, 8px edge: the tip starts at 56 instead of running off at 300.
    expect(tip.style.left).toBe('56px');
  });
});

describe('tip copy', () => {
  it('every tip is at most two sentences', () => {
    // `modes` is three short labelled definitions (Off: / Measure: / Live:), worded in SR review.
    for (const [key, text] of Object.entries(TIPS).filter(([k]) => k !== 'modes')) {
      const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
      expect({ key, n: sentences.length }).toEqual({ key, n: Math.min(sentences.length, 2) });
    }
  });

  it('says plainly that the two report thresholds are not read yet', () => {
    expect(TIPS.reportSendIntervalHours).toMatch(/^Not used yet\./);
    expect(TIPS.reportMaxRows).toMatch(/^Not used yet\./);
  });
});
