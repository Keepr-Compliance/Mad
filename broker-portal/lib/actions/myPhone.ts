'use server';

/**
 * My Account phone — BACKLOG-4007 People v2 (founder 4aa21ea7). One phone per person, stored in
 * public.user_phones and reachable only through my_phone_get / my_phone_set (the caller's own
 * row; the database checks auth.uid()). Who else can read it: the person's brokerage admin,
 * broker and IT admin, and Keepr staff (enforced in the database).
 */

import { createClient } from '@/lib/supabase/server';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';

export type MyPhoneResult = { ok: true; phone: string | null } | { ok: false; error: string };

export async function getMyPhone(): Promise<MyPhoneResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('my_phone_get');
  if (error || !data) return { ok: false, error: 'failed' };
  return { ok: true, phone: (data as { phone?: string | null }).phone ?? null };
}

export async function setMyPhone(phone: string): Promise<MyPhoneResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { ok: false, error: 'not_authorized' };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('my_phone_set', { p_phone: phone.trim() });
  if (error) return { ok: false, error: error.code === '42501' ? 'not_authorized' : 'failed' };
  const r = data as { success?: boolean; error?: string; phone?: string | null } | null;
  if (!r?.success) return { ok: false, error: r?.error ?? 'failed' };
  return { ok: true, phone: r.phone ?? null };
}
