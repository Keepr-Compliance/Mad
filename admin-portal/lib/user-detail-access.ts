/**
 * BACKLOG-4145: who may open /dashboard/users/[id].
 *
 * Allowed when the caller holds users.view, OR the database says the caller can see this user as
 * a support ticket requester (support_can_view_requester, migration 20261108150000: support.admin
 * sees every ticket's requester, support.view sees requesters of tickets assigned to the caller).
 * Both checks run on the caller's own session client, on every request.
 */

interface RpcClient {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error?: unknown }>;
}

export async function canViewUserDetail(
  supabase: RpcClient,
  callerId: string,
  targetUserId: string
): Promise<boolean> {
  const { data: hasUsersView } = await supabase.rpc('has_permission', {
    check_user_id: callerId,
    required_permission: 'users.view',
  });
  if (hasUsersView === true) return true;

  // Fails closed: an error or a null answer (for example the function is absent) denies.
  const { data: canSeeRequester, error } = await supabase.rpc('support_can_view_requester', {
    p_user_id: targetUserId,
  });
  if (error) return false;
  return canSeeRequester === true;
}
