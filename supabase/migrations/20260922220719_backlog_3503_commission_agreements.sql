-- ============================================================================
-- Migration: commission agreements -- the agent split and the office franchise fee
-- Backlog: BACKLOG-3503 (M1 of the commission-tracking epic; BACKLOG-3504 reads it)
--
-- NOT APPLIED TO PRODUCTION BY THIS PR. The apply is a separate step taken on
-- the founder's word. Nothing in the product reads these tables yet; the first
-- reader is BACKLOG-3504.
--
-- Base branch: develop @ 5177d9bed.
-- Stamp: chosen above 20260921101758, the highest migration stamp on
-- origin/int-portal/transaction-checklists -- NOT above develop's max
-- (20260919204500). Two branches carry migrations and both merge to develop;
-- scripts/check-migration-names.mjs never grandfathers a duplicate stamp.
--
-- Creates
-- ---------------------------------------------------------------------------
--   agent_commission_agreements    one row = the whole agreement in force for
--                                  one agent from one date: the split, the
--                                  office fee and its cadence.
--   organization_franchise_fees    one row = the flat franchise fee the office
--                                  pays per closing, from one date.
--
--   Both are APPEND-ONLY LEDGERS. A change is a new row with a later
--   effective_from (or, on the same date, a later seq). Nothing is edited and
--   nothing is deleted, so the history of what an agent was promised survives.
--
--   can_write_commission_agreements(uuid)   the broker/admin rule, SECURITY
--                                  DEFINER. An ACTIVE broker or admin of that
--                                  organization. Fronts all four policies: the
--                                  broker/admin SELECT and INSERT on both tables.
--   is_active_commission_member(uuid)       the agent's own-row rule, SECURITY
--                                  DEFINER. An ACTIVE member of that organization.
--   commission_agreement_in_force(uuid, uuid, date)   read helper, INVOKER
--   franchise_fee_in_force(uuid, date)                read helper, INVOKER
--
-- Five things a later reader needs, none of them obvious from the statements
-- ---------------------------------------------------------------------------
-- (a) WHY `REVOKE ALL` IS HERE. Supabase ships
--     `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated,
--     service_role` (measured on production and on the test venue:
--     pg_default_acl, grantor postgres, privileges `arwdDxtm`). So a brand-new
--     table in `public` already holds table-wide INSERT/UPDATE/DELETE/TRUNCATE
--     for `anon` and `authenticated` the instant CREATE TABLE returns. The
--     column-list `GRANT INSERT (...)` below is ADDITIVE on top of that, not a
--     substitute for it. Without the REVOKE, the append-only design rests on
--     nothing. A narrower `REVOKE INSERT, UPDATE, DELETE` is not enough either:
--     the `D` in `arwdDxtm` is TRUNCATE, which is a table-level operation that
--     row-level security never evaluates. Keep `REVOKE ALL`; control C18 in
--     supabase/tests/backlog-3503/ asserts the privileges are gone.
--
-- (b) APPEND-ONLY BINDS `authenticated` ONLY. `service_role` has
--     rolbypassrls = true (measured on production), so any edge function or
--     server route holding the service key can UPDATE or DELETE these rows and
--     no policy in this file can see it. The table owner (`postgres`) can too --
--     that is how migrations work. "Append-only" here means "against a
--     signed-in client", not "absolutely".
--
-- (c) `CHECK (agent_pct + brokerage_pct = 100)` FORECLOSES A THREE-WAY SPLIT.
--     A team lead's cut, or a referral fee paid out of the same remainder,
--     cannot be expressed while this CHECK stands. That was decided knowingly;
--     record it as a foreclosure, not a safety rail. Undoing it is a migration.
--     Likewise organization_franchise_fees.amount is a FLAT amount: a
--     percentage-based franchise fee would need a new column. And
--     `CHECK (office_fee_cadence IN ('monthly', 'annual'))` forecloses a
--     PER-TRANSACTION office fee in exactly the same way. All three are the
--     founder's rulings and all three are right; they are listed here because
--     the header is where foreclosures get recorded, not because any is in doubt.
--
-- (d) `seq` IS A GLOBALLY SHARED IDENTITY AND IT IS CLIENT-VISIBLE. One
--     sequence serves every organization, and `seq` is returned by SELECT * and
--     by both read helpers (RETURNS SETOF <table>). It must stay -- it is the
--     tie-breaker the same-day ordering rests on -- but BACKLOG-3504 selects
--     explicit columns rather than *, and does not render or ship `seq`.
--
-- (e) A USER WHO HOLDS AN AGREEMENT CANNOT BE DELETED, AND SO CANNOT THE
--     BROKER WHO WROTE IT. All four foreign keys are ON DELETE NO ACTION, so
--     deleting a user or an organization that appears in either table fails
--     with 23503. That is the intent for `agent_user_id`. The wider,
--     less obvious half is `set_by`: the broker or admin who SET an agreement
--     is named by that FK, so they become undeletable too, for as long as any
--     row they wrote survives -- which, in an append-only ledger, is forever.
--     No production path hard-deletes a `public.users` or `public.organizations`
--     row today (measured; SCIM's delete is a soft suspend), so this changes
--     nothing that exists. Control C19 asserts all four constraints BY NAME.
--
-- Ordering contract (BACKLOG-3504 depends on it)
-- ---------------------------------------------------------------------------
--   `effective_from DESC, seq DESC`. NOT `set_at DESC`.
--   `set_at` defaults to now(), which is TRANSACTION-START time, while `seq` is
--   allocated when the INSERT executes. A transaction that began earlier and
--   wrote later therefore has an EARLIER set_at and a LATER seq -- so ordering
--   on set_at returns the row the broker wrote FIRST. Measured: it returns the
--   mistake instead of the correction. `set_at` stays as a displayed audit
--   column and is never a sort key.
--
-- Proof
-- ---------------------------------------------------------------------------
--   supabase/tests/backlog-3503/ runs this file on a real Postgres and reports
--   every control and every mutant. It is not in CI (CI has no database). The
--   text-level tripwire that does run in CI is
--   broker-portal/__tests__/migrations/commission-agreements-3503.test.ts.
--
--   This file deliberately does NOT open its own transaction: the harness runs
--   it inside BEGIN ... ROLLBACK, and a COMMIT here would leave the tables on
--   the venue. Apply it with a wrapping transaction at apply time.
--
--   NOT RE-RUNNABLE, DELIBERATELY. Plain CREATE TABLE / CREATE INDEX / CREATE
--   POLICY, where the recent neighbours use IF NOT EXISTS and DROP POLICY IF
--   EXISTS. A second apply must fail loudly with 42P07. `IF NOT EXISTS` would
--   accept a pre-existing table OF A DIFFERENT SHAPE and then land these GRANTs
--   and POLICIES on it -- which is the failure this file can least afford,
--   because its whole security rests on the REVOKE landing on the right table.
-- ============================================================================

-- ============================ 1. the agent agreement ============================
CREATE TABLE public.agent_commission_agreements (
  id                 uuid          NOT NULL DEFAULT gen_random_uuid(),
  seq                bigint        GENERATED ALWAYS AS IDENTITY,
  organization_id    uuid          NOT NULL,
  agent_user_id      uuid          NOT NULL,
  agent_pct          numeric(5,2)  NOT NULL,
  brokerage_pct      numeric(5,2)  NOT NULL,
  office_fee_amount  numeric(12,2) NOT NULL,
  office_fee_cadence text          NOT NULL,
  effective_from     date          NOT NULL,
  note               text          NULL,
  set_by             uuid          NOT NULL DEFAULT auth.uid(),
  set_at             timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT agent_commission_agreements_pkey PRIMARY KEY (id),
  CONSTRAINT agent_commission_agreements_seq_key UNIQUE (seq),
  CONSTRAINT agent_commission_agreements_org_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id),
  CONSTRAINT agent_commission_agreements_agent_fkey
    FOREIGN KEY (agent_user_id) REFERENCES public.users(id),
  CONSTRAINT agent_commission_agreements_set_by_fkey
    FOREIGN KEY (set_by) REFERENCES public.users(id),
  CONSTRAINT agent_commission_agreements_agent_pct_check
    CHECK (agent_pct >= 0 AND agent_pct <= 100),
  CONSTRAINT agent_commission_agreements_brokerage_pct_check
    CHECK (brokerage_pct >= 0 AND brokerage_pct <= 100),
  CONSTRAINT agent_commission_agreements_split_sum_check
    CHECK (agent_pct + brokerage_pct = 100),
  CONSTRAINT agent_commission_agreements_office_fee_amount_check
    CHECK (office_fee_amount >= 0),
  CONSTRAINT agent_commission_agreements_office_fee_cadence_check
    CHECK (office_fee_cadence IN ('monthly', 'annual')),
  CONSTRAINT agent_commission_agreements_note_check
    CHECK (note IS NULL OR char_length(btrim(note)) BETWEEN 1 AND 2000)
);

COMMENT ON TABLE public.agent_commission_agreements IS
  'Append-only. One row is the whole agreement in force for one agent from one date. Order by effective_from DESC, seq DESC -- never set_at.';

CREATE INDEX agent_commission_agreements_in_force_idx
  ON public.agent_commission_agreements
     (organization_id, agent_user_id, effective_from DESC, seq DESC);

-- ============================ 2. the org franchise fee ==========================
CREATE TABLE public.organization_franchise_fees (
  id              uuid          NOT NULL DEFAULT gen_random_uuid(),
  seq             bigint        GENERATED ALWAYS AS IDENTITY,
  organization_id uuid          NOT NULL,
  amount          numeric(12,2) NOT NULL,
  effective_from  date          NOT NULL,
  note            text          NULL,
  set_by          uuid          NOT NULL DEFAULT auth.uid(),
  set_at          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT organization_franchise_fees_pkey PRIMARY KEY (id),
  CONSTRAINT organization_franchise_fees_seq_key UNIQUE (seq),
  CONSTRAINT organization_franchise_fees_org_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id),
  CONSTRAINT organization_franchise_fees_set_by_fkey
    FOREIGN KEY (set_by) REFERENCES public.users(id),
  CONSTRAINT organization_franchise_fees_amount_check CHECK (amount >= 0),
  CONSTRAINT organization_franchise_fees_note_check
    CHECK (note IS NULL OR char_length(btrim(note)) BETWEEN 1 AND 2000)
);

COMMENT ON TABLE public.organization_franchise_fees IS
  'Append-only. One row is the flat franchise fee in force for an office from one date. Order by effective_from DESC, seq DESC -- never set_at.';

CREATE INDEX organization_franchise_fees_in_force_idx
  ON public.organization_franchise_fees (organization_id, effective_from DESC, seq DESC);

-- ============================ 3. the write rule =================================
-- Deliberately NOT is_org_admin(): that helper is ('admin', 'it_admin'), which
-- admits an IT administrator and excludes the broker. The rule here is the
-- inverse -- ('broker', 'admin') -- because who may set a person's pay is a
-- business question, not a systems-administration one.
--
-- AND AN ACTIVE MEMBER. A deactivated broker or admin reads nothing and writes
-- nothing: the person who sets pay is not an exception to the rule that a
-- deactivated member loses access. The status term sits in the SAME EXISTS as
-- the role term on purpose -- one membership row must carry both, so a caller
-- cannot be a broker by one row and active by another. Today that hazard cannot
-- arise: organization_members carries UNIQUE (organization_id, user_id), so two
-- such rows cannot exist for a non-NULL user_id. The spelling costs nothing and
-- stays correct if that constraint is ever dropped, which is why it is kept --
-- not because the two-row case is live. The spelling is
-- `= 'active'`, for the reasons set out in full in section 3b: the writers of
-- organization_members.license_status admit fewer values than its CHECK does,
-- and an exclusion list would fail OPEN on a state added later.
--
-- THIS ONE HELPER FRONTS ALL FOUR POLICIES -- both SELECT policies and both
-- INSERT policies, on both tables -- so the term lands on the broker/admin read
-- and the broker/admin write together. That is the fit, not a compromise: the
-- ruling covers reading and writing on both tables, and splitting the helper
-- would mean writing the same rule twice and letting the copies drift.
--
-- AND SO MUST THE SUBJECT OF THE AGREEMENT BE. The INSERT policy's member-EXISTS
-- -- the clause about the AGENT an agreement is written FOR -- carries the same
-- status term, so a broker may record an agreement only for an ACTIVE member of
-- their organization. The founder ruled that on 2026-09-22 (recorded in
-- pm_comments on BACKLOG-3503), reversing what this file shipped first. Both
-- shapes of the loss now refuse, by two different mechanisms: a REMOVED subject
-- has no membership row for the EXISTS to find, and a DEACTIVATED subject has a
-- row whose status the term rejects.
--
-- WHAT THAT COSTS, written down because it is a real loss taken knowingly: an
-- agent deactivated BEFORE any agreement was ever entered can no longer have one
-- entered at all. Their past closings then resolve to ZERO ROWS -- control C12
-- is that shape -- and cannot be computed.
--
-- THERE IS NO NON-DESTRUCTIVE WAY OUT. Nothing in the product sets an EXISTING
-- membership row back to license_status 'active'. The .ts/.tsx writers that can
-- write 'active' onto an existing row are each gated away from a
-- portal-deactivated one, and a route back to 'active' FOR THAT ROW is MECHANISM
-- UNTRACED. The enumeration, with file:line and the command behind it, is in the
-- harness README at supabase/tests/backlog-3503/README.md. An earlier draft of
-- this paragraph named a reactivate / record / deactivate route; that route does
-- not exist and nothing should be built on it. BACKLOG-3518 tracks a real
-- reactivation.
--
-- THERE IS A DESTRUCTIVE ROUTE, AND IT IS UI-REACHABLE. Traced end to end at
-- cbc646d4e, every line read rather than inferred:
--   1. broker-portal/components/users/UserDetailsCard.tsx:212 renders "Remove"
--      for a deactivated member -- it sits OUTSIDE the `!isPending &&
--      !isSuspended` conditional that gates "Deactivate" at :207-211.
--      RemoveUserModal.tsx:43 calls through with no gate of its own.
--   2. broker-portal/lib/actions/removeUser.ts:110-112 DELETEs the
--      organization_members row. Its guards are impersonation, authenticated,
--      caller is admin/it_admin, not self, it_admin-removes-it_admin and
--      last-admin; no license_status appears anywhere in that file, so a
--      'suspended' row is removable.
--   3. With the row gone, both of inviteUser.ts's refusals -- :109-118 on
--      invited_email, :128-137 on user_id -- SELECT a row that no longer exists,
--      so both pass, and :166-178 INSERTs a fresh 'pending' row.
--   4. The agent signs in and accepts: auth/callback/route.ts:122-130 sets
--      license_status 'active'.
-- Row-level security permits every hop -- read from pg_policies on production,
-- not inferred: the FOR ALL policy organization_members_all_public, USING
-- is_org_admin(...), covers both the DELETE and the re-invite INSERT, and
-- users_can_accept_invite (UPDATE, matching on invited_email) covers the
-- acceptance. Step 4 is gated: it runs only when pickBrokerageMembership returns
-- null (route.ts:57), which a BACKLOG-3364 personal organization does not
-- satisfy -- so an ordinary single-brokerage agent reaches it, while someone
-- holding a SECOND brokerage membership redirects at :59-62 or :64 and never
-- links.
--
-- IT IS A DATA-LOSING PATH, NOT A SUPPORTED WORKAROUND. It destroys the
-- membership record and the role on it, and it needs the agent to sign in again.
-- What survives: the same public.users row -- the callback upserts on
-- `id: user.id`, and Remove touches only organization_members -- so
-- agent_user_id is unchanged and any agreements already recorded still resolve.
-- Neither table here FKs organization_members (:132-136, :171-173).
-- effective_from is a client-supplied `date NOT NULL` with no default and is in
-- the INSERT grant (:392-394), so the new agreement is BACKDATABLE and C12's
-- zero-row shape resolves. The broker's read survives a second deactivation too:
-- agent_commission_agreements_select_writer (:411-413) tests the READER's
-- status, never the subject's. The agent's own read does not -- select_own
-- (:421-424) requires their own active membership -- but that is the
-- deactivation itself, not this route.
--
-- The founder was re-asked knowing the reactivate / record / deactivate
-- mitigation does not exist, and the ruling stands (pm_comments, BACKLOG-3503).
-- He accepted the loss on the worse premise -- that nothing at all could be
-- recorded; the real loss is smaller, so nothing above reopens that decision.
--
-- PINNED IN BOTH DIRECTIONS rather than left silent: control C25 asserts that a
-- deactivated subject and a removed subject are both refused while an active one
-- is not, and mutant m36 is this status term REMOVED. Before C25 existed, moving
-- this dimension either way reddened nothing at all (measured).
--
-- SECURITY DEFINER so the policy can read organization_members past that table's
-- own row-level security; SET search_path = public so the definer's search path
-- cannot be chosen by the caller.
CREATE OR REPLACE FUNCTION public.can_write_commission_agreements(p_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.organization_id = p_org_id
                    AND m.user_id = (SELECT auth.uid())
                    AND m.role IN ('broker', 'admin')
                    AND m.license_status = 'active');
$fn$;

-- ============================ 3b. the own-row read rule =========================
-- An agent reads their own agreement rows only while they are an ACTIVE member
-- of the organization that wrote them. Two states lose the read, and they are
-- different shapes in the data:
--   removed     -- broker-portal/lib/actions/removeUser.ts DELETEs the
--                  organization_members row, so no row matches at all;
--   deactivated -- broker-portal/lib/actions/deactivateUser.ts sets
--                  license_status = 'suspended' (a soft delete; the row stays).
-- SCIM (supabase/functions/scim/handlers/users.ts) and directory-sync write the
-- same 'suspended'.
--
-- WHY `= 'active'` AND NOT `NOT IN ('suspended','expired')`. The CHECK on
-- organization_members.license_status admits four values -- 'pending', 'active',
-- 'suspended', 'expired' (20260122_b2b_broker_portal.sql:90) -- but the WRITERS
-- admit fewer. Every writer that creates a membership row carrying a user_id
-- writes 'active' (jit_join_organization, auto_provision_it_admin,
-- _ensure_personal_organization_for, claim_pending_invite,
-- handle_new_user_invitation_link, the portal's auth callback, SCIM,
-- directory-sync); the only move away from it is to 'suspended' and back.
-- 'pending' belongs to INVITE rows, which carry invited_email and a NULL
-- user_id and so can never match `m.user_id = auth.uid()`. No writer anywhere in
-- this repo sets organization_members.license_status = 'expired'. So the two
-- spellings are behaviourally identical today, and `= 'active'` is the one that
-- fails CLOSED if a fifth state ever appears. It is also the spelling three
-- policies already shipped on this database use for the same question
-- (organization_identity_providers, scim_tokens, scim_sync_log).
--
-- SECURITY DEFINER for the same reason as the write rule: organization_members
-- carries its own row-level security, and a policy that read it as the caller
-- would be answering a different question than the one asked here.
CREATE OR REPLACE FUNCTION public.is_active_commission_member(p_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.organization_id = p_org_id
                    AND m.user_id = (SELECT auth.uid())
                    AND m.license_status = 'active');
$fn$;

-- ============================ 4. the read helpers ===============================
-- SECURITY INVOKER (the default -- stated here because it is load-bearing, not
-- incidental): the helpers must see exactly the rows their caller's policies
-- allow. Marked DEFINER they would hand an agent a colleague's split.
--
-- Two helpers, never one combined helper. An inner join would render "this
-- office has no franchise fee on record" as "this agent has no split on
-- record"; a left join would make "no record" indistinguishable from 0.00.
-- Two independent zero-row answers is the only shape that keeps ABSENT
-- distinguishable from ZERO, and that distinction is the caller's to make.
CREATE OR REPLACE FUNCTION public.commission_agreement_in_force(
  p_organization_id uuid, p_agent_user_id uuid, p_on_date date DEFAULT current_date
) RETURNS SETOF public.agent_commission_agreements
LANGUAGE sql STABLE SET search_path = public   -- SECURITY INVOKER on purpose
AS $fn$
  SELECT a.* FROM public.agent_commission_agreements a
   WHERE a.organization_id = p_organization_id
     AND a.agent_user_id   = p_agent_user_id
     AND a.effective_from  <= p_on_date
   ORDER BY a.effective_from DESC, a.seq DESC
   LIMIT 1;
$fn$;

CREATE OR REPLACE FUNCTION public.franchise_fee_in_force(
  p_organization_id uuid, p_on_date date DEFAULT current_date
) RETURNS SETOF public.organization_franchise_fees
LANGUAGE sql STABLE SET search_path = public   -- SECURITY INVOKER on purpose
AS $fn$
  SELECT f.* FROM public.organization_franchise_fees f
   WHERE f.organization_id = p_organization_id
     AND f.effective_from  <= p_on_date
   ORDER BY f.effective_from DESC, f.seq DESC
   LIMIT 1;
$fn$;

-- The default ACL grants EXECUTE on a new function to PUBLIC and to anon
-- explicitly, so each grant below needs its own revoke first.
REVOKE EXECUTE ON FUNCTION public.commission_agreement_in_force(uuid, uuid, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.commission_agreement_in_force(uuid, uuid, date) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.franchise_fee_in_force(uuid, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.franchise_fee_in_force(uuid, date) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.can_write_commission_agreements(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.can_write_commission_agreements(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.is_active_commission_member(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_active_commission_member(uuid) TO authenticated;

-- ============================ 5. RLS and grants =================================
ALTER TABLE public.agent_commission_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_franchise_fees  ENABLE ROW LEVEL SECURITY;

-- See header note (a). REVOKE ALL, not a narrower revoke: it is what takes back
-- TRUNCATE, which row-level security never evaluates.
REVOKE ALL ON public.agent_commission_agreements FROM anon, authenticated;
REVOKE ALL ON public.organization_franchise_fees  FROM anon, authenticated;

GRANT SELECT ON public.agent_commission_agreements TO authenticated;
GRANT INSERT (organization_id, agent_user_id, agent_pct, brokerage_pct,
              office_fee_amount, office_fee_cadence, effective_from, note)
  ON public.agent_commission_agreements TO authenticated;

GRANT SELECT ON public.organization_franchise_fees TO authenticated;
GRANT INSERT (organization_id, amount, effective_from, note)
  ON public.organization_franchise_fees TO authenticated;
-- set_by and set_at are absent from both column lists on purpose: they are the
-- audit pair, and a client that could name them could name someone else.
-- No UPDATE grant, no DELETE grant, no UPDATE/DELETE policy, on either table.
-- A grant without a policy is NOT equivalent: it turns the write into a silent
-- zero-row no-op instead of an error. Absence of both is what makes the refusal
-- visible.

-- The broker/admin read. `can_write_commission_agreements` is named for the
-- write it gates, and it gates this SELECT too -- an ACTIVE broker or admin of
-- this organization. A deactivated one reads nothing here; controls C23 and C24
-- in supabase/tests/backlog-3503/ hold that shut on both tables, and mutant m35
-- is the rule without its status term.
CREATE POLICY agent_commission_agreements_select_writer
  ON public.agent_commission_agreements FOR SELECT TO authenticated
  USING (public.can_write_commission_agreements(organization_id));

-- Their own rows, and only while they are an active member of the organization
-- that wrote them. See section 3b for what "active" is and why it is spelled
-- `= 'active'`. A bare `agent_user_id = auth.uid()` here would let a removed or
-- deactivated agent keep reading; controls C21 and C22 in
-- supabase/tests/backlog-3503/ hold that shut, and mutant m32 is that bare
-- predicate.
CREATE POLICY agent_commission_agreements_select_own
  ON public.agent_commission_agreements FOR SELECT TO authenticated
  USING (agent_user_id = (SELECT auth.uid())
         AND public.is_active_commission_member(agent_commission_agreements.organization_id));

-- The EXISTS clause must compare m.organization_id to the NEW ROW's
-- organization_id. Written unqualified, `organization_id` binds to the
-- organization_members alias and Postgres stores `m.organization_id =
-- m.organization_id` -- vacuously true, and behaviourally invisible today.
-- Hence the table-qualified spelling and control C17's catalog sweep.
--
-- `m.license_status = 'active'` is the founder's ruling of 2026-09-22 (section 3
-- above, and the cost it carries): the SUBJECT of an agreement must be an active
-- member, so a deactivated agent cannot be written for any more than a removed
-- one can. It sits in the SAME EXISTS as the user_id term, for the reason the
-- write rule gives. Control C25 asserts both refusals and the active case beside
-- them; mutant m36 is this term removed.
CREATE POLICY agent_commission_agreements_insert_writer
  ON public.agent_commission_agreements FOR INSERT TO authenticated
  WITH CHECK (public.can_write_commission_agreements(agent_commission_agreements.organization_id)
              AND EXISTS (SELECT 1 FROM public.organization_members m
                           WHERE m.organization_id = agent_commission_agreements.organization_id
                             AND m.user_id = agent_commission_agreements.agent_user_id
                             AND m.license_status = 'active'));

-- No own-row SELECT policy here: an agent does not read the office's franchise
-- fee in M1. Adding a policy later is pure addition; revoking one agents have
-- already used is a regression.
CREATE POLICY organization_franchise_fees_select_writer
  ON public.organization_franchise_fees FOR SELECT TO authenticated
  USING (public.can_write_commission_agreements(organization_id));

CREATE POLICY organization_franchise_fees_insert_writer
  ON public.organization_franchise_fees FOR INSERT TO authenticated
  WITH CHECK (public.can_write_commission_agreements(organization_franchise_fees.organization_id));
