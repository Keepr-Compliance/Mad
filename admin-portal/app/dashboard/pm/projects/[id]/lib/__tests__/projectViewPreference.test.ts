/**
 * Tests for resolveProjectView -- the project detail page's default workspace
 * view and how it interacts with a stored preference (BACKLOG-2706).
 *
 * Two properties are asserted separately, because they can break independently:
 * 1. With nothing (or garbage) stored, the page opens on the DEFAULT view.
 * 2. With a recognised value stored, that value wins -- the default never
 *    overwrites a deliberate choice.
 *
 * Control (run 2026-08-13): flipping DEFAULT_PROJECT_VIEW back to 'sprints'
 * turns every case in group 1 red while every case in group 2 stays green.
 * The staying-green half is the actual proof of property 2: the stored value is
 * returned independently of whatever the default happens to be.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveProjectView,
  DEFAULT_PROJECT_VIEW,
  PROJECT_VIEW_STORAGE_KEY,
} from '../projectViewPreference';

describe('resolveProjectView - default when nothing is stored', () => {
  it('opens on the Epics view when the key is absent (getItem -> null)', () => {
    expect(resolveProjectView(null)).toBe('epics');
  });

  it('opens on the Epics view for an empty stored string', () => {
    expect(resolveProjectView('')).toBe('epics');
  });

  it('opens on the Epics view for an unrecognised stored value', () => {
    expect(resolveProjectView('board')).toBe('epics');
    expect(resolveProjectView('Epics')).toBe('epics'); // case-sensitive: not a valid value
    expect(resolveProjectView('{"view":"sprints"}')).toBe('epics');
  });

  it('exports Epics as the declared default', () => {
    expect(DEFAULT_PROJECT_VIEW).toBe('epics');
  });
});

describe('resolveProjectView - a stored choice wins over the default', () => {
  it('returns the stored Sprints view rather than the default', () => {
    expect(resolveProjectView('sprints')).toBe('sprints');
  });

  it('returns the stored Epics view', () => {
    expect(resolveProjectView('epics')).toBe('epics');
  });

  it('returns a stored value that differs from the default', () => {
    // Whichever view is the default, the OTHER one must survive being stored.
    const other = DEFAULT_PROJECT_VIEW === 'epics' ? 'sprints' : 'epics';
    expect(resolveProjectView(other)).toBe(other);
  });
});

describe('resolveProjectView - storage key', () => {
  it('keeps the key BACKLOG-2386 already wrote, so existing choices are honoured', () => {
    expect(PROJECT_VIEW_STORAGE_KEY).toBe('pm-project-view');
  });
});
