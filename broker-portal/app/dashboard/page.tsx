import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Clock, XCircle, CheckCircle2, Files, Inbox } from 'lucide-react';
import {
  PageHeader,
  StatCard,
  EmptyState,
  Card,
  CardHeader,
  CardTitle,
} from '@keepr/design-system';
import { formatRelativeTime, getStatusColor, formatStatus } from '@/lib/utils';
import { getDataClient, getTargetOrganizationId } from '@/lib/impersonation-guards';
import type { SupabaseClient } from '@supabase/supabase-js';

interface SubmissionStats {
  total: number;
  submitted: number;
  under_review: number;
  needs_changes: number;
  approved: number;
  rejected: number;
}

async function getStats(client: SupabaseClient, orgId?: string): Promise<SubmissionStats> {
  // Get all submissions for the user's organization (exclude incomplete uploads)
  let query = client
    .from('transaction_submissions')
    .select('status')
    .neq('status', 'uploading');

  // During impersonation, filter by organization
  if (orgId) {
    query = query.eq('organization_id', orgId);
  }

  const { data, error } = await query;

  if (error || !data) {
    console.error('Error fetching stats:', error);
    return {
      total: 0,
      submitted: 0,
      under_review: 0,
      needs_changes: 0,
      approved: 0,
      rejected: 0,
    };
  }

  return {
    total: data.length,
    submitted: data.filter(s => s.status === 'submitted').length,
    under_review: data.filter(s => s.status === 'under_review').length,
    needs_changes: data.filter(s => s.status === 'needs_changes').length,
    approved: data.filter(s => s.status === 'approved').length,
    rejected: data.filter(s => s.status === 'rejected').length,
  };
}

async function getRecentSubmissions(client: SupabaseClient, orgId?: string) {
  let query = client
    .from('transaction_submissions')
    .select('*')
    .neq('status', 'uploading')
    .order('created_at', { ascending: false })
    .limit(5);

  if (orgId) {
    query = query.eq('organization_id', orgId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching recent submissions:', error);
    return [];
  }

  return data || [];
}

export default async function DashboardPage() {
  const { client, impersonation, organizationId } = await getDataClient();

  // IT admins only manage users — redirect to Users page (skip during impersonation)
  if (!impersonation) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: membership } = await supabase
        .from('organization_members')
        .select('role')
        .eq('user_id', user.id)
        .maybeSingle();
      if (membership?.role === 'it_admin') {
        redirect('/dashboard/users');
      }
    }
  }

  // BACKLOG-908: Use deduped helper for org ID resolution
  const orgId = getTargetOrganizationId(organizationId);

  const [stats, recentSubmissions] = await Promise.all([
    getStats(client, orgId),
    getRecentSubmissions(client, orgId),
  ]);

  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader title="Dashboard" subtitle="Overview of transaction submissions" />

      <div className="space-y-6">
        {/* Stats Grid */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Pending Review"
            value={stats.submitted + stats.under_review}
            icon={<Clock className="h-5 w-5" />}
            hue="blue"
          />
          <StatCard
            label="Needs Changes"
            value={stats.needs_changes}
            icon={<XCircle className="h-5 w-5" />}
            hue="orange"
          />
          <StatCard
            label="Approved"
            value={stats.approved}
            icon={<CheckCircle2 className="h-5 w-5" />}
            hue="green"
          />
          <StatCard
            label="Total Submissions"
            value={stats.total}
            icon={<Files className="h-5 w-5" />}
            hue="gray"
          />
        </div>

        {/* Recent Submissions */}
        <Card padding="none">
          <CardHeader
            action={
              <Link
                href="/dashboard/submissions"
                className="text-sm font-medium text-primary-600 hover:text-primary-700"
              >
                View all
              </Link>
            }
          >
            <CardTitle>Recent Submissions</CardTitle>
          </CardHeader>

          {recentSubmissions.length === 0 ? (
            <EmptyState
              card={false}
              icon={<Inbox className="mx-auto h-12 w-12 text-gray-300" />}
              title="No submissions yet"
            />
          ) : (
            <ul className="divide-y divide-gray-200">
              {recentSubmissions.map((submission) => (
                <li key={submission.id}>
                  <Link
                    href={`/dashboard/submissions/${submission.id}`}
                    className="block px-6 py-4 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {submission.property_address}
                        </p>
                        <p className="text-sm text-gray-500">
                          {submission.property_city}, {submission.property_state}
                        </p>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="text-sm text-gray-500">
                          {formatRelativeTime(submission.created_at)}
                        </span>
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(
                            submission.status
                          )}`}
                        >
                          {formatStatus(submission.status)}
                        </span>
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
