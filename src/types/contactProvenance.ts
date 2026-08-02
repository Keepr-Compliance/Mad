/**
 * Renderer-side re-export of the contact provenance and review-queue shapes
 * (BACKLOG-2410).
 *
 * The definitions live with the main-process services that produce them, so
 * there is exactly one of each. These are `export type` re-exports — fully
 * erased at build time, so importing this file gives the renderer the shapes
 * without pulling any main-process module into the bundle.
 *
 * The alternative, a hand-copied mirror in `src/`, drifts the first time a field
 * is added on one side; the drift is invisible to the compiler and shows up as a
 * field reading `undefined` at runtime, on a screen whose whole purpose is to be
 * trusted about what it says.
 */

export type {
  ContactSourceProvenance,
  ContactReviewCluster,
  ContactReviewItem,
} from "@electron/types/ipc/window-api-contacts";
