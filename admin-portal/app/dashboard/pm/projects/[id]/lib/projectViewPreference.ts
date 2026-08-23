/**
 * projectViewPreference -- which workspace view the project detail page opens
 * on, and how a stored preference interacts with that default (BACKLOG-2706).
 *
 * The page has two workspace views (BACKLOG-2386): "Sprints" and "Epics". The
 * chosen view is persisted to localStorage on toggle, so this module answers
 * one question: given whatever is in storage (or nothing at all), which view
 * should the page show?
 *
 * Rules:
 * - Nothing stored          -> DEFAULT_PROJECT_VIEW ('epics').
 * - A recognised value      -> that value. A deliberate choice is NEVER
 *                             overwritten by the default.
 * - An unrecognised value   -> DEFAULT_PROJECT_VIEW. Garbage (a stale key from
 *                             an older build, a hand-edited value) is not a
 *                             deliberate choice, so it is treated as "nothing
 *                             stored" rather than left to crash the render.
 *
 * Why 'epics' is the default: epics are how the work is actually organised.
 * Sprints are time-boxes and several projects have no active sprint at all, so
 * the sprint view can open completely empty on a project with dozens of open
 * items -- which reads as "nothing here" when the opposite is true.
 *
 * Kept pure and free of `window` so it is unit-testable in admin-portal's
 * node-environment vitest run. The type-only import of `ProjectView` is erased
 * at build time, so this module never pulls in the component (or dnd-kit).
 */

import type { ProjectView } from '../components/ProjectEpics';

/** localStorage key holding the user's chosen workspace view. */
export const PROJECT_VIEW_STORAGE_KEY = 'pm-project-view';

/** View the project detail page opens on when nothing is stored. */
export const DEFAULT_PROJECT_VIEW: ProjectView = 'epics';

/** Type guard for a value read out of storage (always `string | null`). */
function isProjectView(value: string | null): value is ProjectView {
  return value === 'sprints' || value === 'epics';
}

/**
 * Resolve the view to show from whatever localStorage holds.
 *
 * @param stored Raw `localStorage.getItem(PROJECT_VIEW_STORAGE_KEY)` result --
 *               `null` when the user has never chosen a view.
 */
export function resolveProjectView(stored: string | null): ProjectView {
  return isProjectView(stored) ? stored : DEFAULT_PROJECT_VIEW;
}
