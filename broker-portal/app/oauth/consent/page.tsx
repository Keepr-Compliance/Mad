/**
 * /oauth/consent — BACKLOG-4237.
 *
 * Supabase Auth sends the browser here with ?authorization_id=… when an AI app
 * asks to connect. Without a session the id is kept in a short-lived cookie
 * (path /oauth) by /oauth/consent/start and the person signs in; the AI apps
 * page then links back here, and the cookie supplies the id.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { CONSENT_COOKIE_NAME, isAuthorizationId, loadConsent } from '@/lib/mcp/consent';
import ConsentClient from './ConsentClient';

export const dynamic = 'force-dynamic';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4">
      <div className="max-w-lg w-full">{children}</div>
    </div>
  );
}

function Message({ text }: { text: string }) {
  return (
    <Shell>
      <p role="status" className="text-sm text-gray-700 bg-white rounded-lg border border-gray-200 p-6">
        {text}
      </p>
    </Shell>
  );
}

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ authorization_id?: string | string[] }>;
}) {
  const params = await searchParams;
  const fromQuery = typeof params.authorization_id === 'string' ? params.authorization_id : undefined;
  const fromCookie = (await cookies()).get(CONSENT_COOKIE_NAME)?.value;
  const authorizationId = fromQuery ?? fromCookie;

  if (!isAuthorizationId(authorizationId)) {
    return <Message text="There is no AI app connection waiting. Start the connection again from the app." />;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/oauth/consent/start?authorization_id=${encodeURIComponent(authorizationId)}`);
  }

  const view = await loadConsent(supabase, authorizationId);

  switch (view.kind) {
    case 'consent':
      return (
        <Shell>
          <ConsentClient
            mode="consent"
            authorizationId={view.authorizationId}
            clientName={view.clientName}
            redirectHost={view.redirectHost}
          />
        </Shell>
      );
    case 'redirect':
      return (
        <Shell>
          <ConsentClient mode="redirect" url={view.url} />
        </Shell>
      );
    case 'refused':
      return <Message text="Keepr does not support connecting this app." />;
    default:
      return <Message text="This connection request has expired or is not valid. Start again from the app." />;
  }
}
