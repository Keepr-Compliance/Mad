/**
 * The Agent plan price for the desktop paywall — BACKLOG-3676.
 *
 * GET, Bearer JWT only; nothing is read from the request but the token. The
 * price is Stripe's (lookup key agent_month_usd), so the app never carries an
 * amount of its own. Only the monthly price is offered (annual is hidden).
 * Not cached: a cached amount could differ from what Checkout charges.
 *
 *   billing off      404 { code: 'not_available' }
 *   no / bad Bearer  401 { code: 'unauthorized' }
 *   Stripe fails     502 { code: 'try_again' }
 *   200 { month: { display, unitAmount, currency } | null, bookCallUrl }
 */

import { NextResponse } from 'next/server';
import { getStripe, verifyBearerUser } from '@/lib/stripe';
import { billingEnabled } from '@/lib/billing/flag';
import { formatPrice, getAgentPrices } from '@/lib/billing/agentPlan';
import { BOOK_A_CALL_URL } from '@/lib/billing/bookCall';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(req: Request): Promise<Response> {
  if (!billingEnabled()) return NextResponse.json({ code: 'not_available' }, { status: 404, headers: NO_STORE });

  const user = await verifyBearerUser(req);
  if (!user) return NextResponse.json({ code: 'unauthorized' }, { status: 401, headers: NO_STORE });

  try {
    const month = (await getAgentPrices(getStripe())).month;
    return NextResponse.json(
      {
        month: month ? { display: formatPrice(month), unitAmount: month.unitAmount, currency: month.currency } : null,
        bookCallUrl: BOOK_A_CALL_URL,
      },
      { headers: NO_STORE }
    );
  } catch (err) {
    console.error('[billing/agent-prices] price read failed:', (err as Error).name);
    return NextResponse.json({ code: 'try_again' }, { status: 502, headers: NO_STORE });
  }
}
