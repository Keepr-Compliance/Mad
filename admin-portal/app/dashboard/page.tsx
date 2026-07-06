import { getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { Card } from '@keepr/design-system';

export const dynamic = 'force-dynamic';

/**
 * Dashboard Home - Admin Portal
 *
 * Welcome page showing user's role from the RBAC system.
 */
export default async function DashboardPage() {
  const { supabase, user } = await getAuthenticatedUser();

  if (!user) {
    redirect('/login');
  }

  // Fetch role via join to admin_roles
  const { data: internalRole } = await supabase
    .from('internal_roles')
    .select('role_id, role:admin_roles(name, slug)')
    .eq('user_id', user.id)
    .single();

  if (!internalRole) {
    redirect('/login?error=not_authorized');
  }

  const role = internalRole.role as unknown as { name: string; slug: string } | null;
  const roleName = role?.name ?? 'Unknown';

  const displayName =
    user.user_metadata?.full_name ||
    user.user_metadata?.name ||
    user.email ||
    'Admin';

  return (
    <div className="max-w-4xl mx-auto">
      <Card padding="lg">
        <h2 className="text-2xl font-bold text-gray-900">
          Welcome to Keepr Admin
        </h2>
        <p className="mt-2 text-gray-600">
          Hello, {displayName}. You are signed in as an internal administrator.
        </p>

        {/* Role Badge */}
        <div className="mt-6">
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-primary-100 text-primary-800">
            Role: {roleName}
          </span>
        </div>
      </Card>
    </div>
  );
}
