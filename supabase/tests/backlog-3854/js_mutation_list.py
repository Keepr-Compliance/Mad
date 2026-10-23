"""BACKLOG-3854 JS mutations: (id + name, file, exact old text, new text, app, suite)."""
B, A = 'broker-portal', 'admin-portal'
SYNC = '__tests__/lib/billing/outboxKinds/sync_org_subscription.convergence.test.ts'
BS = 'broker-portal/lib/billing/brokerageSync.ts'
M = [
  ('J1 W7 blanket create_prorations', BS, "params.proration_behavior = increase && !priceDiffers ? 'create_prorations' : 'none';", "params.proration_behavior = 'create_prorations';", B, SYNC),
  ('J2 increase left none', BS, "params.proration_behavior = increase && !priceDiffers ? 'create_prorations' : 'none';", "params.proration_behavior = 'none';", B, SYNC),
  ('J3 one combined update for qty+price', BS, "    if (increase && priceDiffers) {\n      const first", "    if (false) {\n      const first", B, SYNC),
  ('J3b combined update prorated as one', BS, "params.proration_behavior = increase && !priceDiffers ? 'create_prorations' : 'none';", "params.proration_behavior = increase ? 'create_prorations' : 'none';", B, SYNC),
]
SA = '__tests__/lib/billing/outboxKinds/notify_seats_added.convergence.test.ts'
AMT = '__tests__/lib/billing/outboxKinds/notify_account_manager.convergence.test.ts'
M += [
  ('J4 seats_added not an AM reason', 'broker-portal/lib/billing/brokerageNotify.ts', "  'seats_added',\n]);", "]);", B, AMT),
  ('J5 email sent twice (no dedupe)', 'broker-portal/lib/billing/seatsAddedNotify.ts', "  if (await alreadySent(service, row.dedupe_key)) return;", "", B, SA),
  ('J6 no contact throws', 'broker-portal/lib/billing/seatsAddedNotify.ts', "    console.info(`[billing/seats-added] ${row.id}: no billing contact email; nothing to send`);\n    return;", "    throw new Error('no contact');", B, SA),
  ('J7 trial promises a charge', 'broker-portal/lib/email/templates/seats-added.ts', "    p.trialing\n      ? 'The new seats are billed from the end of your trial.'\n      : ", "    ", B, SA),
]
ACT = '__tests__/seats-3854/addSeatsAction.test.ts'
POR = '__tests__/seats-3854/billingPortalAction.test.ts'
UI = '__tests__/seats-3854/seatsUi.test.tsx'
PAGE = '__tests__/app/dashboard/billing/billing-page.test.tsx'
SA_F = 'broker-portal/lib/actions/seats.ts'
PO_F = 'broker-portal/lib/actions/billingPortal.ts'
M += [
  ('J8 W6 org from an argument', SA_F, "    p_org: ctx.organizationId,", "    p_org: ((arguments as unknown as unknown[])[2] as string | undefined) ?? ctx.organizationId,", B, ACT),
  ('J10 W2 IT admin reaches the RPC', SA_F, "  if (!ctx.caps.canAddSeats) return fail('not_authorized');\n", "", B, ACT),
  ('J11 W4 no live overdue check', SA_F, "  if (overdue === 'overdue') return fail('invoice_overdue');\n", "", B, ACT),
  ('J12 live check fails open', SA_F, "  if (overdue === 'unavailable') return fail('stripe_unavailable');\n", "", B, ACT),
  ('J13 W11 wall clock instead of the test clock', 'broker-portal/lib/billing/seats.ts', "stripeNow({ stripe }, customerId)", "Promise.resolve(Math.floor(Date.now() / 1000))", B, ACT),
  ('J14 bounds widened', SA_F, "count < 1 || count > 10000", "count < 1 || count > 100000", B, ACT),
  ('J14b non-integer count accepted', SA_F, "if (!Number.isInteger(count) || count < 1", "if (count < 1", B, ACT),
  ('J15 W5 configuration not passed', PO_F, "            configuration,\n", "", B, POR),
  ('J16 W5 subscription_update not asserted', 'broker-portal/lib/billing/portalConfig.ts', "  if (f.subscription_update?.enabled !== false) problems.push('subscription_update');\n", "", B, POR),
  ('J17 login_page not asserted', 'broker-portal/lib/billing/portalConfig.ts', "  if (c.login_page?.enabled !== false) problems.push('login_page');\n", "", B, POR),
  ('J17b livemode not asserted', 'broker-portal/lib/billing/portalConfig.ts', "  if (c.livemode !== (mode === 'live')) problems.push('livemode');\n", "", B, POR),
  ('J17c account default used', 'broker-portal/lib/billing/portalConfig.ts', "if (c.metadata?.keepr === PORTAL_CONFIG_TAG) ours.push(c);", "ours.push(c);", B, POR),
  ('J18 W9 redirect inside the try', PO_F, "session.url.startsWith('https://')) url = session.url;", "session.url.startsWith('https://')) redirect(session.url);", B, POR),
  ('J19 9e Stripe before the customer row', PO_F, "        if (customer) {\n          const stripe = getStripe();", "        await ensurePortalConfiguration(getStripe(), ctx.mode);\n        if (customer) {\n          const stripe = getStripe();", B, POR),
  ('J20 IT admin opens the portal', PO_F, "if (!('error' in ctx) && ctx.caps.canSeeInvoices) {", "if (!('error' in ctx)) {", B, POR),
  ('J21 impersonation allowed', PO_F, "    if (!blocked) {", "    if (true) {", B, POR),
  ('J22 SB payment/invoices frames left in', 'broker-portal/lib/billing/capabilities.ts', "const ORG_MONEY_BLOCKS: BillingBlock[] = ['plan', 'seats', 'manage_billing'];", "const ORG_MONEY_BLOCKS: BillingBlock[] = ['plan', 'seats', 'payment', 'invoices', 'manage_billing'];", B, UI),
  ('J23 SR5 canceling copy not role-aware', 'broker-portal/components/billing/SeatsBlock.tsx', "      return viewer === 'admin'\n        ? 'Your plan is ending. Turn auto-renew back on to add seats.'\n        : 'Your plan is ending. An Admin can turn auto-renew back on.';", "      return 'Your plan is ending. Turn auto-renew back on to add seats.';", B, UI),
  ('J24 button from the role, not can_add', 'broker-portal/components/billing/SeatsBlock.tsx', "{view.canAdd && view.version !== null ? (", "{viewer === 'broker' || viewer === 'admin' ? (", B, UI),
  ('J25 trial promises a charge (modal)', 'broker-portal/components/billing/SeatsBlock.tsx', "  if (view.trialing) return `${totals} The new seats are billed from the end of your trial.`;\n", "", B, UI),
  ('J26 set-up ignores draft', 'broker-portal/lib/billing/orgBillingSetUp.ts', "return !!status && status !== 'draft' && !!customer;", "return !!status && !!customer;", B, PAGE),
  ('J27 set-up ignores the mode', 'broker-portal/lib/billing/orgBillingSetUp.ts', "        .eq('stripe_mode', mode)\n        .maybeSingle(),\n    ]);", "        .maybeSingle(),\n    ]);", B, PAGE),
  ('J28 page keeps set-up false', 'broker-portal/app/dashboard/billing/page.tsx', "const orgBillingSetUp = await readOrgBillingSetUp(createServiceClient(), organizationId, currentStripeMode());", "const orgBillingSetUp = (await readOrgBillingSetUp(createServiceClient(), organizationId, currentStripeMode())) && false;", B, PAGE),
  ('J29 suspended branch keeps set-up false', 'broker-portal/app/dashboard/billing/page.tsx', "        ...SITUATION_3844,\n        orgBillingSetUp,\n        orgSuspended: true,", "        ...SITUATION_3844,\n        orgSuspended: true,", B, PAGE),
  ('J30 IT admin gets money', 'broker-portal/lib/billing/capabilities.ts', "  const money = payer && s.orgBillingSetUp;", "  const money = (payer || role === 'it_admin') && s.orgBillingSetUp;", B, PAGE),
  ('J31 Add seats while suspended (caps gate dropped)', 'broker-portal/components/billing/BillingPage.tsx', "canAdd: seats.view.canAdd && caps.canAddSeats", "canAdd: seats.view.canAdd", B, PAGE),
]
