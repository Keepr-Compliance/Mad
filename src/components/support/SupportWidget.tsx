/**
 * SupportWidget Component
 * TASK-2180: Floating "?" support button for the desktop Electron app.
 * TASK-2282: Moved outside auth routes so it's visible on ALL screens.
 *
 * Renders a fixed blue circle at the bottom-left of the screen.
 * When clicked, auto-captures a screenshot, collects diagnostics,
 * and opens the SupportTicketDialog.
 *
 * When user is authenticated, auto-fills name/email from session.
 * When unauthenticated, shows name/email input fields in the dialog.
 */

import React, { useState, useCallback, useEffect, useRef } from "react";
import { SupportTicketDialog } from "./SupportTicketDialog";
import { usePlatform } from "../../contexts";
import { Z_CLASS } from "../../constants/zLayers";
import { Dialog, DialogLayerContent, DialogTitle } from "@keepr/ui";
import { isRadixModalLayerActive } from "./isRadixModalLayerActive";

/** Detail payload for the 'open-support-widget' custom event (TASK-2319) */
export interface OpenSupportWidgetDetail {
  /** Pre-fill the subject field in the ticket dialog */
  subject?: string;
  /** BACKLOG-1905: Pre-fill the description/body (e.g. auto-update failure summary) */
  description?: string;
  /** Pre-fill user email when DB isn't available (e.g., during onboarding errors) */
  email?: string;
  /** Pre-fill user name when DB isn't available */
  name?: string;
}

interface SupportWidgetProps {
  /** Optional user email (provided when rendered inside auth context) */
  userEmail?: string;
  /** Optional user display name (provided when rendered inside auth context) */
  userName?: string;
}

/**
 * Floating support widget button with "?" icon.
 * Opens the SupportTicketDialog on click.
 *
 * TASK-2282: Detects auth state internally via IPC when props are not provided.
 * This allows the widget to be rendered outside auth-gated routes.
 */
export function SupportWidget({
  userEmail: propEmail,
  userName: propName,
}: SupportWidgetProps = {}): React.ReactElement {
  const { isWindows } = usePlatform();
  const [isOpen, setIsOpen] = useState(false);
  // BACKLOG-4226: a Radix modal (e.g. Learn mode) was open when "?" was clicked,
  // so the form opens in its own modal layer on top of it.
  const [overModal, setOverModal] = useState(false);
  // BACKLOG-4226: what had focus (inside that modal) when "?" was pressed, so
  // closing the form hands focus back to it rather than to <body>.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [preCapturedScreenshot, setPreCapturedScreenshot] = useState<string | null>(null);
  const [detectedEmail, setDetectedEmail] = useState<string>("");
  const [detectedName, setDetectedName] = useState<string>("");

  // TASK-2282: Try to detect user info via IPC when props not provided
  // Also re-detect when widget is opened (user may have logged in since mount)
  useEffect(() => {
    if (propEmail && propName) return; // Already have props, skip IPC
    if (detectedEmail) return; // Already detected, skip

    let cancelled = false;

    const detectUser = async () => {
      try {
        const result = await window.api.auth.getCurrentUser();
        if (!cancelled && result.success && result.user) {
          setDetectedEmail(result.user.email || "");
          setDetectedName(result.user.display_name || result.user.email || "");
        }
      } catch {
        // Expected when DB not initialized or no session - widget still works
      }
    };

    detectUser();
    return () => { cancelled = true; };
  }, [propEmail, propName, isOpen, detectedEmail]);

  const userEmail = propEmail || detectedEmail;
  const userName = propName || detectedName;

  const handleOpen = useCallback(async () => {
    // BACKLOG-4226: decide before the capture await, so the form's own state
    // cannot affect the answer.
    setOverModal(isRadixModalLayerActive());
    // BACKLOG-1607: Detect user AND capture screenshot BEFORE opening dialog.
    // Run both IPC calls in parallel so user info is available when the dialog
    // mounts, avoiding the race condition where the dialog renders with empty
    // fields before the async detection in the useEffect completes.
    const [, userResult] = await Promise.all([
      // Capture screenshot BEFORE opening the dialog so we get the actual page
      window.api.support.captureScreenshot()
        .then((result) => {
          if (result.success && result.screenshot) {
            setPreCapturedScreenshot(result.screenshot);
          }
        })
        .catch(() => {
          // Screenshot capture failed — dialog will still open without it
        }),
      // Detect user info if not already detected
      (!propEmail || !propName) && !detectedEmail
        ? window.api.auth.getCurrentUser().catch(() => null)
        : Promise.resolve(null),
    ]);

    if (userResult && userResult.success && userResult.user) {
      setDetectedEmail(userResult.user.email || "");
      setDetectedName(userResult.user.display_name || userResult.user.email || "");
    }

    setIsOpen(true);
  }, [propEmail, propName, detectedEmail]);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setOverModal(false);
    setPreCapturedScreenshot(null);
    setPrefilledSubject("");
    setPrefilledDescription("");
  }, []);

  // TASK-2319: Pre-filled subject for programmatic opens
  const [prefilledSubject, setPrefilledSubject] = useState("");
  // BACKLOG-1905: Pre-filled description for programmatic opens (e.g. auto-update failure)
  const [prefilledDescription, setPrefilledDescription] = useState("");

  // TASK-2319: Listen for 'open-support-widget' custom event so other
  // components (ErrorBoundary, AccountVerificationStep) can open the widget
  // without prop drilling or context.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<OpenSupportWidgetDetail>).detail;
      if (detail?.subject) {
        setPrefilledSubject(detail.subject);
      }
      // BACKLOG-1905: accept a pre-filled description (auto-update failure summary)
      if (detail?.description) {
        setPrefilledDescription(detail.description);
      }
      // Accept email/name from event when DB isn't available (e.g., onboarding errors)
      if (detail?.email && !detectedEmail) {
        setDetectedEmail(detail.email);
      }
      if (detail?.name && !detectedName) {
        setDetectedName(detail.name);
      }
      setIsOpen(true);
    };
    window.addEventListener("open-support-widget", handler);
    return () => window.removeEventListener("open-support-widget", handler);
  }, [detectedEmail, detectedName]);

  const form = (
    <SupportTicketDialog
      onClose={handleClose}
      userEmail={userEmail}
      userName={userName}
      autoCaptureScreenshot={false}
      initialScreenshot={preCapturedScreenshot}
      prefilledSubject={prefilledSubject}
      prefilledDescription={prefilledDescription}
    />
  );

  return (
    <>
      {/* Floating "?" button - bottom-left, blue circle
           BACKLOG-1341: stays above all modal overlays; BACKLOG-3964: and above the
           Settings page layer (z-[105]) — see src/constants/zLayers.ts */}
      {/* BACKLOG-1554: Windows frameless windows have 20px resize zones at corners
           that intercept clicks. Use bottom-8 left-8 (32px) on Windows to clear the
           resize zone; keep bottom-4 left-4 (16px) on macOS/Linux.
           BACKLOG-4112: the account panel opens on the right, so the "?" stays in
           this corner, above the scrim and clear of the panel.
           BACKLOG-4226: data-modal-exempt + inline pointer-events:auto keep it
           clickable while a Radix modal (Learn mode) is open, without
           dismissing that modal. Inline, not a class: the modal's lock is an
           inline style on <body>. */}
      <button
        onPointerDown={() => {
          returnFocusRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onClick={handleOpen}
        data-support-widget
        data-modal-exempt
        style={{ pointerEvents: "auto" }}
        className={`fixed ${Z_CLASS.support} w-10 h-10 rounded-full bg-primary-600 hover:bg-primary-700 text-white font-bold text-lg shadow-lg hover:shadow-xl transition-all flex items-center justify-center no-drag-region ${
          isWindows ? "bottom-8 left-8" : "bottom-4 left-4"
        }`}
        title="Contact Support"
        aria-label="Open support dialog"
      >
        ?
      </button>

      {/* Support Ticket Dialog */}
      {isOpen && !overModal && form}
      {/* BACKLOG-4226: over an open modal, the same form in a modal layer on top.
           Radix's layer and focus stacks give it clicks and focus and pause the
           modal underneath (not dismiss it); closing resumes it. */}
      {isOpen && overModal && (
        <Dialog open onOpenChange={(open) => (open ? undefined : handleClose())}>
          <DialogLayerContent
            aria-describedby={undefined}
            className={`fixed inset-0 ${Z_CLASS.supportDialog}`}
            onCloseAutoFocus={(e) => {
              const el = returnFocusRef.current;
              returnFocusRef.current = null;
              if (el && el.isConnected) {
                e.preventDefault();
                el.focus();
              }
            }}
          >
            <DialogTitle className="sr-only">Contact Support</DialogTitle>
            {form}
          </DialogLayerContent>
        </Dialog>
      )}
    </>
  );
}
