import { getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { Filter } from 'lucide-react';
import { getPaywallFunnel } from '@/lib/funnel-queries';
import { FunnelView } from './components/FunnelView';

export const dynamic = 'force-dynamic';

/**
 * Paywall Funnel Dashboard — Admin Portal (BACKLOG-2014)
 *
 * Server component that reads the already-flowing funnel events from
 * `analytics_events` (paywall-viewed -> unlock-clicked -> payment-succeeded ->
 * export-completed) and renders counts + conversion percentages so the founder
 * can distinguish a PRICE problem (drop at unlock-clicked -> payment) from
 * PAYWALL CONFUSION (drop at paywall-viewed -> unlock-clicked) from a BROKEN
 * CHECKOUT (drop at payment-succeeded despite unlock clicks).
 *
 * Access: internal-role gated (mirrors the analytics page). Read-only.
 */

const VALID_PERIODS: Record<string, number> = {
  '1': 1,
  '7': 7,
  '30': 30,
  '90': 90,
  all: 0,
};

/** Convert a period param into an inclusive ISO lower bound (or null = all time). */
function periodToFrom(period: string | undefined): {
  from: string | null;
  activePeriod: string;
} {
  const key = period ?? '30';
  if (!(key in VALID_PERIODS)) {
    return { from: daysAgo(30), activePeriod: '30' };
  }
  const days = VALID_PERIODS[key];
  if (days === 0) return { from: null, activePeriod: 'all' };
  return { from: daysAgo(days), activePeriod: key };
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

export default async function FunnelPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { supabase, user } = await getAuthenticatedUser();

  if (!user) {
    redirect('/login');
  }

  // Verify internal role.
  const { data: internalRole } = await supabase
    .from('internal_roles')
    .select('role_id')
    .eq('user_id', user.id)
    .single();

  if (!internalRole) {
    redirect('/login?error=not_authorized');
  }

  // Defense-in-depth: verify page-level permission (reuses analytics.view).
  const { data: hasPerm } = await supabase.rpc('has_permission', {
    check_user_id: user.id,
    required_permission: 'analytics.view',
  });
  if (!hasPerm) {
    redirect('/dashboard?error=insufficient_permissions');
  }

  const params = await searchParams;
  const { from, activePeriod } = periodToFrom(params.period);

  const funnel = await getPaywallFunnel(supabase, { from, to: null });

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Page Header */}
      <div className="flex items-center gap-3">
        <Filter className="h-7 w-7 text-primary-600" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Paywall Funnel</h1>
          <p className="text-sm text-gray-500">
            Paywall viewed &rarr; unlock clicked &rarr; payment succeeded &rarr;
            export completed. Where do users drop off?
          </p>
        </div>
      </div>

      <FunnelView funnel={funnel} activePeriod={activePeriod} />
    </div>
  );
}
