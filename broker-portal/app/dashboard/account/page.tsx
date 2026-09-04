/**
 * My Account route — BACKLOG-3078 (the gate) and BACKLOG-3079 (the data).
 *
 * The personal counterpart to /dashboard/settings. Reachable by ANY signed-in
 * member: nothing on this page is org policy, so there is no role to check
 * beyond "is this a person with a session".
 *
 * Two callers this gate has to admit:
 *   - an ordinary member, including `agent` once BACKLOG-3080 opens the portal
 *     to them (middleware.ts still redirects `agent` away from every
 *     /dashboard/* route today; that route audit is 3080's, not this item's).
 *   - Keepr support, through the existing impersonation flow. RLS on
 *     user_preferences is own-rows plus service_role with no internal-role read
 *     policy, so impersonation is the ONLY way support can see this page, and
 *     it must not be refused here.
 *
 * getAccountView() takes no user id — see its header. The subject is the
 * session, or the impersonation target, and nothing else is representable.
 */

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getImpersonationSession } from '@/lib/impersonation';
import { getAccountView } from '@/lib/account/getAccountView';
import AccountClient from './AccountClient';

export default async function AccountPage() {
  // A support session carries no authenticated user; the impersonation cookie
  // is the identity. Checked first, exactly as /dashboard/users does.
  const impersonation = await getImpersonationSession();

  if (!impersonation) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      redirect('/login');
    }
  }

  const account = await getAccountView();

  return <AccountClient account={account} />;
}
