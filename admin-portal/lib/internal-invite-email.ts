/**
 * Sends the internal-invite notification through the broker portal and reports whether it
 * went out (BACKLOG-4168). The request is awaited: on serverless hosting the function can end
 * before an un-awaited request is sent.
 *
 * The broker route answers 200 {success: true} when the email was sent and 200
 * {success: false, error} when the provider refused it, so a 2xx alone is not success.
 * Logs carry the status code only, never the recipient address.
 */
export async function sendInternalInviteNotification(
  email: string,
  roleName: string,
  logTag: string
): Promise<boolean> {
  const brokerPortalUrl = process.env.BROKER_PORTAL_URL;
  const apiSecret = process.env.INTERNAL_API_SECRET;

  if (!brokerPortalUrl || !apiSecret) {
    console.error(`[${logTag}] Invite email not sent: BROKER_PORTAL_URL or INTERNAL_API_SECRET not configured`);
    return false;
  }

  const adminPortalUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://admin.keeprcompliance.com';

  try {
    const res = await fetch(`${brokerPortalUrl}/api/email/internal-invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-secret': apiSecret,
      },
      body: JSON.stringify({ email, roleName, loginUrl: adminPortalUrl }),
    });

    let sent = false;
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { success?: unknown } | null;
      sent = body?.success === true;
    }
    console.log(`[${logTag}] Invite email ${sent ? 'sent' : 'failed'}: status ${res.status}`);
    return sent;
  } catch {
    console.error(`[${logTag}] Invite email request failed: no response`);
    return false;
  }
}
