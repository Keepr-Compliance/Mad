import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getImpersonationSession } from '@/lib/impersonation';
import { DashboardShell } from '@/components/layout/DashboardShell';

async function getUserWithRole() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return null;

  // Get user's role from organization_members
  const { data: membership } = await supabase
    .from('organization_members')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle();

  return {
    ...user,
    role: membership?.role || undefined,
    name: user.user_metadata?.full_name || user.user_metadata?.name || undefined,
  };
}

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const impersonation = await getImpersonationSession();
  const isImpersonating = !!impersonation;

  // During impersonation, we don't need a real auth session
  // The impersonation cookie provides the identity
  const user = await getUserWithRole();

  if (!user && !isImpersonating) {
    redirect('/login');
  }

  // During impersonation, use target user info from the session
  const displayEmail = isImpersonating
    ? impersonation.target_email
    : (user?.email || '');
  const displayName = isImpersonating
    ? impersonation.target_name
    : user?.name;
  const displayRole = isImpersonating ? undefined : user?.role;

  return (
    <DashboardShell
      role={user?.role}
      isImpersonating={isImpersonating}
      displayName={displayName}
      displayEmail={displayEmail}
      displayRole={displayRole}
    >
      {children}
    </DashboardShell>
  );
}
