'use client';

/**
 * Personal-owner banner for a scheduled domain capture move — BACKLOG-3962 PR3b.
 *
 * The layout renders this only for a personal owner with a scheduled move (caller_capture_notice).
 * The notice email links to /dashboard?capture=join and /dashboard?capture=keep (older emails:
 * ?capture=notice, read as keep). Those URLs only DISPLAY: they highlight the banner and focus one
 * button. Joining and opting out happen only from their confirm steps, through joinNowSelf /
 * optOutSelf with confirm: true.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Modal } from '@keepr/design-system';
import { AlertBanner, Button } from '@keepr/ui';
import { joinNowSelf, optOutSelf } from '@/lib/actions/domainCapture';
import { DOMAIN_CAPTURE_FAILED } from '@/lib/domain/captureMessages';
import {
  CAPTURE_BANNER_DETAIL,
  CAPTURE_JOIN_BUTTON,
  CAPTURE_JOIN_CONTINUE,
  CAPTURE_KEEP_BUTTON,
  CAPTURE_KEEP_CONFIRM_TITLE,
  CAPTURE_KEEP_DONE,
  captureBannerText,
  captureJoinConfirmText,
  captureJoinConfirmTitle,
  captureJoinDoneText,
  captureJoinNoSeatText,
  captureKeepConfirmText,
  formatCaptureDate,
} from '@/lib/domain/captureCopy';
import type { CaptureNotice } from '@/lib/domain/captureView';

export interface CaptureNoticeBannerProps {
  notice: CaptureNotice;
}

export default function CaptureNoticeBanner({ notice }: CaptureNoticeBannerProps) {
  const router = useRouter();
  const params = useSearchParams();
  const capture = params?.get('capture');
  const focus = capture === 'join' ? 'join' : capture === 'keep' || capture === 'notice' ? 'keep' : null;
  const fromEmail = focus !== null;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const joinRef = useRef<HTMLButtonElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [joined, setJoined] = useState<{ brokerageName: string; licensed: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Display only: bring the choice into view. No action is called here.
    if (focus === 'join') joinRef.current?.focus();
    else if (focus === 'keep') buttonRef.current?.focus();
  }, [focus]);

  if (joined) {
    return (
      <div className="mb-4" data-testid="capture-notice-banner">
        <AlertBanner variant="success">
          <div className="space-y-2">
            <p className="font-medium">{captureJoinDoneText(joined.brokerageName)}</p>
            {!joined.licensed && <p className="text-sm">{captureJoinNoSeatText(joined.brokerageName)}</p>}
            <Button type="button" size="sm" onClick={() => router.refresh()}>
              {CAPTURE_JOIN_CONTINUE}
            </Button>
          </div>
        </AlertBanner>
      </div>
    );
  }

  if (done) {
    return (
      <div className="mb-4" data-testid="capture-notice-banner">
        <AlertBanner variant="success">{CAPTURE_KEEP_DONE}</AlertBanner>
      </div>
    );
  }

  const handleJoin = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await joinNowSelf({ switchId: notice.switchId, confirm: true });
      if (res.success && res.joined) {
        setJoined({ brokerageName: res.brokerageName || notice.brokerageName, licensed: res.licensed === true });
        setJoinOpen(false);
      } else {
        setError(res.message);
      }
    } catch {
      setError(DOMAIN_CAPTURE_FAILED);
    } finally {
      setBusy(false);
    }
  };

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
          {error && !confirmOpen && !joinOpen && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button ref={joinRef} type="button" size="sm" onClick={() => { setError(null); setJoinOpen(true); }}>
              {CAPTURE_JOIN_BUTTON}
            </Button>
            <Button ref={buttonRef} type="button" variant="secondary" size="sm" onClick={() => { setError(null); setConfirmOpen(true); }}>
              {CAPTURE_KEEP_BUTTON}
            </Button>
          </div>
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

      <Modal
        open={joinOpen}
        onClose={() => setJoinOpen(false)}
        title={<span id="capture-join-title">{captureJoinConfirmTitle(notice.brokerageName)}</span>}
        aria-labelledby="capture-join-title"
        dismissible={!busy}
      >
        <p className="text-sm text-gray-700">{captureJoinConfirmText(notice.brokerageName)}</p>
        {error && (
          <p className="mt-2 text-sm text-red-600" role="alert">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setJoinOpen(false)} disabled={busy}>
            Back
          </Button>
          <Button type="button" onClick={handleJoin} disabled={busy}>
            {busy ? 'Joining...' : CAPTURE_JOIN_BUTTON}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
