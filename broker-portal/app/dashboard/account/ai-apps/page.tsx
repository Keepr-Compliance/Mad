/**
 * /dashboard/account/ai-apps — BACKLOG-4237.
 *
 * Resume link only. The pending authorization is held in a cookie scoped to
 * /oauth, which this page cannot read, so the link is always shown and
 * /oauth/consent decides whether anything is waiting.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export default async function AiAppsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold text-gray-900">AI apps</h1>
      <p className="text-sm text-gray-700">If you were connecting an AI app to Keepr, continue here.</p>
      <Link
        href="/oauth/consent"
        className="inline-block px-4 py-2 rounded-lg bg-primary-600 text-white font-medium hover:bg-primary-700"
      >
        Continue connecting
      </Link>
    </div>
  );
}
