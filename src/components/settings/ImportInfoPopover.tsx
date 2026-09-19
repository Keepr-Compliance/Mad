import React, { useState } from "react";

/**
 * BACKLOG-3156 stage B — THE "?" THAT EXPLAINS THE IMPORT BUTTONS.
 *
 * ===========================================================================
 * WHY THIS IS A COMPONENT AND NOT A THIRD COPY OF THE SAME JSX
 * ===========================================================================
 * Contacts has had this popover since BACKLOG-2388. Stage B puts the same
 * pattern on Emails and Messages, which is the point at which hand-rolling it
 * a third time stops being cheaper than extracting it: three call sites is
 * where the drift this whole item exists to undo would start again. The markup
 * below is Contacts' own, moved rather than reinvented — same trigger, same
 * panel classes, same `aria-label`, so `MacOSContactsImportSettings.reimportCopy-3029`
 * still reads the element it has always read.
 *
 * ===========================================================================
 * THE COPY IS A CLAIM, AND ON THIS PANEL IT HAS GONE FALSE BEFORE
 * ===========================================================================
 * BACKLOG-3029: three Contacts strings promised the re-import cleared EVERY
 * source. That stopped being true when the wipe was scoped to the sources that
 * would actually be refilled, and nothing went red, because no test read any of
 * them.
 *
 * So, for every caller:
 *   - STATE THE RULE, NEVER A DERIVED LIST OF SOURCES. A list built from a
 *     component's connectedness flags disagrees with what the orchestrator
 *     actually empties, which is a second way to be false.
 *   - Every factual claim in `entries` is pinned by a test that reds if the
 *     claim changes — `settingsPopupCopy-3156.test.tsx`, plus the two suites
 *     that already guard this prose (`reimportCopy-3029`, `recacheCopy-3056`).
 *
 * `heading` is the BUTTON'S OWN LABEL, so a reader can match panel to control.
 * `settingsPopupCopy-3156` asserts that equality structurally rather than by
 * literal, so renaming a button without following it here goes red.
 *
 * ===========================================================================
 * WHAT THIS COMPONENT DOES NOT PROMISE
 * ===========================================================================
 * `onMouseDown` + `preventDefault` is inherited from the Contacts original: it
 * stops the button taking focus, which is what makes a second press toggle the
 * panel shut rather than the blur closing it first and the press reopening it.
 * The consequence is that `onBlur` only closes the panel when something else
 * had moved focus INTO the button (keyboard). Clicking elsewhere on the page
 * does not close it. That is today's behaviour on Contacts, carried across
 * unchanged so all three sections behave alike; it is not a claim that this is
 * the right dismissal model.
 */

export interface ImportInfoEntry {
  /** The label of the button this paragraph explains, verbatim. */
  heading: string;
  /** What that button actually does. A rule, never a derived list of sources. */
  body: string;
  /** Optional testid for suites that pin this paragraph's claims. */
  bodyTestId?: string;
}

interface ImportInfoPopoverProps {
  entries: ImportInfoEntry[];
  /**
   * Section prefix for the two testids this renders: `${testId}-button` and
   * `${testId}-panel`. Needed because all three triggers carry the same
   * `aria-label`, so a label query cannot tell the sections apart.
   */
  testId: string;
}

export function ImportInfoPopover({
  entries,
  testId,
}: ImportInfoPopoverProps): React.ReactElement {
  const [showInfoTooltip, setShowInfoTooltip] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onMouseDown={(e) => {
          e.preventDefault(); // Prevent blur from firing on self-click
          setShowInfoTooltip(!showInfoTooltip);
        }}
        onBlur={() => setShowInfoTooltip(false)}
        className="text-gray-400 hover:text-gray-600 transition-colors"
        aria-label="Import info"
        data-testid={`${testId}-button`}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      </button>
      {showInfoTooltip && (
        <div
          data-testid={`${testId}-panel`}
          className="absolute bottom-full right-0 mb-2 w-64 p-3 bg-white rounded-lg shadow-lg border border-gray-200 text-xs text-gray-600 z-10"
        >
          {/* Fragments, so each heading `<p>` stays a DIRECT child of this
              panel: `reimportCopy-3029` reaches the panel by taking the
              heading's `parentElement`, and a wrapper div would hand it a
              smaller element carrying only one entry's text. */}
          {entries.map((entry, index) => (
            <React.Fragment key={entry.heading}>
              <p className="font-medium text-gray-900 mb-1">{entry.heading}</p>
              <p
                className={index < entries.length - 1 ? "mb-2" : undefined}
                data-testid={entry.bodyTestId}
              >
                {entry.body}
              </p>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
