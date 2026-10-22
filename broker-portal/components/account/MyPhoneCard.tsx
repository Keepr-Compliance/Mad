'use client';

/**
 * My Account > Phone — BACKLOG-4007 People v2. The person's own phone (one per person). Seen by
 * their brokerage's admin, broker and IT admin and by Keepr support; not by other agents.
 * Layout follows the Account card above it (AccountClient.tsx: Card padding="none" +
 * CardHeader + CardContent); field + error pattern from components/setup/BillingStep.tsx.
 */

import { useEffect, useState } from 'react';
import { Button, Card, CardContent, CardHeader, Input, Label } from '@keepr/design-system';
import { AlertBanner } from '@keepr/ui';
import { PHONE_ERROR, formatBillingPhoneInput, isValidBillingPhone } from '@/lib/billing/phone';
import { getMyPhone, setMyPhone } from '@/lib/actions/myPhone';

const MESSAGES: Record<string, string> = {
  invalid_phone: PHONE_ERROR,
  billing_contact_phone_required: 'You are a billing contact, so a phone is required.',
  not_authorized: 'You cannot change this phone.',
};

/** "+12025550101" -> "(202) 555-0101"; other numbers as stored. */
function display(stored: string | null): string {
  if (!stored) return '';
  const m = /^\+1([2-9]\d{9})$/.exec(stored);
  return m ? formatBillingPhoneInput(m[1]) : stored;
}

export function MyPhoneCard({ readOnly = false }: { readOnly?: boolean }) {
  const [phone, setPhone] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void getMyPhone().then((r) => {
      if (r.ok) setPhone(display(r.phone));
      setLoaded(true);
    });
  }, []);

  const valid = phone.trim() === '' || isValidBillingPhone(phone);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    const r = await setMyPhone(phone);
    setBusy(false);
    if (!r.ok) {
      setError(MESSAGES[r.error] ?? 'Something went wrong. Please try again.');
      return;
    }
    setPhone(display(r.phone));
    setSaved(true);
  };

  return (
    <Card padding="none">
      <CardHeader>
        <h2 className="text-lg font-semibold text-gray-900">Your phone</h2>
        <p className="mt-1 text-sm text-gray-600">Your brokerage admins and Keepr support can see it. Other agents cannot.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? <AlertBanner variant="destructive">{error}</AlertBanner> : null}
        {saved ? <AlertBanner variant="success">Phone saved.</AlertBanner> : null}
        <div className="max-w-xs">
          <Label htmlFor="my-phone" className="text-gray-900">Phone number</Label>
          <Input
            id="my-phone"
            type="tel"
            className="text-gray-900"
            value={phone}
            disabled={!loaded || readOnly || busy}
            onChange={(e) => {
              setPhone(formatBillingPhoneInput(e.target.value));
              setSaved(false);
            }}
            onBlur={() => setTouched(true)}
            aria-invalid={touched && !valid}
          />
          {touched && !valid ? (
            <p role="alert" className="mt-1 text-sm text-red-600">
              {PHONE_ERROR}
            </p>
          ) : null}
        </div>
        {!readOnly ? (
          <Button variant="primary" size="sm" disabled={!loaded || busy || !valid} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save phone'}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
