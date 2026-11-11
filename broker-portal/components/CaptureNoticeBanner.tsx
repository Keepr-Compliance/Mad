'use client';

/**
 * Personal-owner banner for a scheduled domain capture move — BACKLOG-3962 PR3b.
 *
 * The layout renders this only for a personal owner with a scheduled move (caller_capture_notice).
 * The notice email links to /dashboard?capture=notice. That URL only DISPLAYS: it highlights the
 * banner and focuses the button. Opting out happens only from the confirm step, through
 * optOutSelf with confirm: true.
 */

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Modal } from '@keepr/design-system';
import { AlertBanner, Button } from '@keepr/ui';
import { optOutSelf } from '@/lib/actions/domainCapture';
import { DOMAIN_CAPTURE_FAILED } from '@/lib/domain/captureMessages';
import {
  CAPTURE_BANNER_DETAIL,
  CAPTURE_KEEP_BUTTON,
  CAPTURE_KEEP_CONFIRM_TITLE,
  CAPTURE_KEEP_DONE,
  captureBannerText,
  captureKeepConfirmText,
  formatCaptureDate,
} from '@/lib/domain/captureCopy';
import type { CaptureNotice } from '@/lib/domain/captureView';

export interface CaptureNoticeBannerProps {
  notice: CaptureNotice;
}

export default function CaptureNoticeBanner({ notice }: CaptureNoticeBannerProps) {
  const params = useSearchParams();
  const fromEmail = params?.get('capture') === 'notice';
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Display only: bring the choice into view. No action is called here.
    if (fromEmail) buttonRef.current?.focus();
  }, [fromEmail]);

  if (done) {
    return (
      <div className="mb-4" data-testid="capture-notice-banner">
        <AlertBanner variant="success">{CAPTURE_KEEP_DONE}</AlertBanner>
      </div>
    );
  }

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await optOutSelf({ switchId: notice.switchId, confirm: true });
      if (res.success) {
        setDone(true);
        setConfirmOpen(false);
      } else {
        setError(res.message);
      }
    } catch {
      setError(DOMAIN_CAPTURE_FAILED);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={fromEmail ? 'mb-4 rounded-md ring-2 ring-blue-500' : 'mb-4'}
      data-testid="capture-notice-banner"
      data-from-email={fromEmail ? 'true' : 'false'}
    >
      <AlertBanner variant="warning">
        <div className="space-y-2">
          <p className="font-medium">{captureBannerText(notice.brokerageName, formatCaptureDate(notice.switchAt))}</p>
          <p className="text-sm">{CAPTURE_BANNER_DETAIL}</p>
          {error && !confirmOpen && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
          <Button ref={buttonRef} type="button" variant="secondary" size="sm" onClick={() => setConfirmOpen(true)}>
            {CAPTURE_KEEP_BUTTON}
          </Button>
        </div>
      </AlertBanner>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={<span id="capture-keep-title">{CAPTURE_KEEP_CONFIRM_TITLE}</span>}
        aria-labelledby="capture-keep-title"
        dismissible={!busy}
      >
        <p className="text-sm text-gray-700">{captureKeepConfirmText(notice.brokerageName)}</p>
        {error && (
          <p className="mt-2 text-sm text-red-600" role="alert">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setConfirmOpen(false)} disabled={busy}>
            Back
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={busy}>
            {busy ? 'Saving...' : CAPTURE_KEEP_BUTTON}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
