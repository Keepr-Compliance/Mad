-- ============================================================================
-- Migration: split agreements -- the agent/brokerage split
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
--   agent_split_agreements    one row = the whole split agreement in force
--                                  for one agent from one date: agent_pct and
--                                  brokerage_pct.
--
--   It is an APPEND-ONLY LEDGER. A change is a new row with a later
--   effective_from (or, on the same date, a later seq). Nothing is edited and
--   nothing is deleted, so the history of what an agent was promised survives.
--
--   BACKLOG-3503 originally shipped this table with an office fee (two
--   columns) and a sibling table, organization_franchise_fees, for a flat
--   per-closing franchise fee. Both were REMOVED before this migration was
--   ever applied (founder decision, pm_comments 95992a3e on BACKLOG-3503):
--   every brokerage reconciles a closing differently -- some deduct fees
--   before the split, some after -- so no fee model belongs in the schema
--   yet. That work moves to BACKLOG-3534, a closing-charges model where each
--   brokerage defines its own arithmetic. This migration stores the standing
--   split agreement only.
--
--   can_write_split_agreements(uuid)   the broker/admin rule, SECURITY
--                                  DEFINER. An ACTIVE broker or admin of that
--                                  organization. Fronts both policies: the
--                                  broker/admin SELECT and INSERT.
--   is_active_split_member(uuid)       the agent's own-row rule, SECURITY
--                                  DEFINER. An ACTIVE member of that organization.
--   split_agreement_in_force(uuid, uuid, date)   read helper, INVOKER
--
-- Alters (the only pre-existing table this migration touches)
-- ---------------------------------------------------------------------------
--   organization_members.deactivated_at timestamptz, nullable, plus the trigger
--   org_members_track_deactivation that maintains it. The agreement INSERT rule
--   needs the END of a member's active period and nothing recorded it. Section
--   2b has the full reasoning, including why the trigger tests the TRANSITION
--   rather than the new value, and what the single column does not model.
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
--     (The office-fee and franchise-fee CHECKs this note used to discuss here
--     were removed with those columns/table before this migration was ever
--     applied -- see the Creates section above and BACKLOG-3534.)
--
-- (d) `seq` IS A GLOBALLY SHARED IDENTITY AND IT IS CLIENT-VISIBLE. One
--     sequence serves every organization, and `seq` is returned by SELECT * and
--     by the read helper (RETURNS SETOF <table>). It must stay -- it is the
--     tie-breaker the same-day ordering rests on -- but BACKLOG-3504 selects
--     explicit columns rather than *, and does not render or ship `seq`.
--
-- (e) A USER WHO HOLDS AN AGREEMENT CANNOT BE DELETED, AND SO CANNOT THE
--     BROKER WHO WROTE IT. All three foreign keys are ON DELETE NO ACTION, so
--     deleting a user or an organization that appears in the table fails
--     with 23503. That is the intent for `agent_user_id`. The wider,
--     less obvious half is `set_by`: the broker or admin who SET an agreement
--     is named by that FK, so they become undeletable too, for as long as any
--     row they wrote survives -- which, in an append-only ledger, is forever.
--     No production path hard-deletes a `public.users` or `public.organizations`
--     row today (measured; SCIM's delete is a soft suspend), so this changes
--     nothing that exists. Control C19 asserts all three constraints BY NAME.
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
CREATE TABLE public.agent_split_agreements (
  id                 uuid          NOT NULL DEFAULT gen_random_uuid(),
  seq                bigint        GENERATED ALWAYS AS IDENTITY,
  organization_id    uuid          NOT NULL,
  agent_user_id      uuid          NOT NULL,
  agent_pct          numeric(5,2)  NOT NULL,
  brokerage_pct      numeric(5,2)  NOT NULL,
  effective_from     date          NOT NULL,
  note               text          NULL,
  set_by             uuid          NOT NULL DEFAULT auth.uid(),
  set_at             timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT agent_split_agreements_pkey PRIMARY KEY (id),
  CONSTRAINT agent_split_agreements_seq_key UNIQUE (seq),
  CONSTRAINT agent_split_agreements_org_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id),
  CONSTRAINT agent_split_agreements_agent_fkey
    FOREIGN KEY (agent_user_id) REFERENCES public.users(id),
  CONSTRAINT agent_split_agreements_set_by_fkey
    FOREIGN KEY (set_by) REFERENCES public.users(id),
  CONSTRAINT agent_split_agreements_agent_pct_check
    CHECK (agent_pct >= 0 AND agent_pct <= 100),
  CONSTRAINT agent_split_agreements_brokerage_pct_check
    CHECK (brokerage_pct >= 0 AND brokerage_pct <= 100),
  CONSTRAINT agent_split_agreements_split_sum_check
    CHECK (agent_pct + brokerage_pct = 100),
  CONSTRAINT agent_split_agreements_note_check
    CHECK (note IS NULL OR char_length(btrim(note)) BETWEEN 1 AND 2000)
);

COMMENT ON TABLE public.agent_split_agreements IS
  'Append-only. One row is the whole agreement in force for one agent from one date. Order by effective_from DESC, seq DESC -- never set_at.';

CREATE INDEX agent_split_agreements_in_force_idx
  ON public.agent_split_agreements
     (organization_id, agent_user_id, effective_from DESC, seq DESC);

-- ==================== 2b. when a membership was deactivated =====================
-- THIS IS THE ONE PLACE THIS MIGRATION TOUCHES A PRE-EXISTING, SHARED TABLE.
-- organization_members is read by both portals and by the desktop app. The
-- column is nullable and additive, and nothing reads it but the agreement INSERT
-- policy in section 5. Measured before adding it: no SELECT * on this table
-- anywhere in the repo, no PostgREST embed organization_members(*), no view or
-- materialized view over it, no function RETURNS SETOF organization_members, and
-- no positional INSERT ... VALUES without a column list. So no existing consumer
-- changes shape.
--
-- WHY THE COLUMN HAS TO EXIST. The rule in section 5 tests an agreement's
-- effective date against the period its subject was active. The START of that
-- period is joined_at. The END was not recorded anywhere: there is no
-- membership-history table, and updated_at is bumped by
-- update_org_members_updated_at on ANY update, so it cannot carry a deactivation
-- date. Measured on production before this column was added: zero columns on
-- organization_members match '%deactiv%', and license_status 'suspended' has
-- ZERO rows -- so there is no history to backfill and no ambiguity to resolve.
-- This is the cheapest moment this column will ever be added.
--
-- WHY A TRIGGER AND NOT AN EDIT TO deactivateUser.ts. Four writers move a
-- membership row to 'suspended' and they are spread across three runtimes:
-- broker-portal/lib/actions/deactivateUser.ts, supabase/functions/scim/handlers/
-- users.ts (twice -- the PATCH active:false path and the DELETE handler), and
-- supabase/functions/directory-sync/index.ts. A trigger covers all four, plus
-- any future writer, and keeps this change SQL-only.
--
-- WHY IT TESTS THE TRANSITION AND NOT THE NEW VALUE. This is the load-bearing
-- part and it is the likeliest thing to be "simplified" later. The SCIM DELETE
-- handler writes license_status = 'suspended' UNCONDITIONALLY, without reading
-- the current value, and both SCIM and directory-sync bump scim_synced_at on
-- rows that may already be suspended. Written the obvious way --
--
--     IF NEW.license_status = 'suspended' THEN NEW.deactivated_at := now();
--
-- -- every one of those writes would push the deactivation date FORWARD, which
-- SILENTLY WIDENS the active period and re-admits exactly the agreement the
-- founder's rule refuses. Hence BOTH guards below: `UPDATE OF license_status`
-- so an unrelated column bump cannot fire it, and the WHEN clause so a no-op
-- rewrite of the same status cannot either. Neither is redundant; control C26
-- holds each of them shut and mutant m38 is this trigger written the obvious way.
--
-- WHAT IT DOES NOT MODEL, stated rather than discovered later: ONE period. A
-- member can be reactivated -- SCIM PatchOp active:true writes 'active' onto an
-- existing row -- so a member can have more than one active period, and clearing
-- the column on reactivation loses the gap between them. An agreement dated
-- inside a past suspension gap would then be admitted. Modelling that needs the
-- membership-history table this repo does not have. The approximation is taken
-- knowingly; it is invisible today, because no organization has SCIM or
-- directory sync configured (scim_tokens and organization_identity_providers
-- both hold zero rows).
--
-- Transitions to 'pending' or 'expired' deliberately leave the column ALONE: an
-- expiring membership does not un-deactivate anyone, and the date already
-- recorded stays true. That is what lets section 5's status term do real work --
-- see the note there.
ALTER TABLE public.organization_members
  ADD COLUMN deactivated_at timestamptz;

COMMENT ON COLUMN public.organization_members.deactivated_at IS
  'When license_status last moved to suspended. NULL while the member is active. Maintained by org_members_track_deactivation; models ONE active period, not a history.';

CREATE OR REPLACE FUNCTION public.set_org_member_deactivated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  IF NEW.license_status = 'suspended' THEN
    NEW.deactivated_at := now();
  ELSIF NEW.license_status = 'active' THEN
    NEW.deactivated_at := NULL;
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER org_members_track_deactivation
  BEFORE UPDATE OF license_status ON public.organization_members
  FOR EACH ROW
  WHEN (OLD.license_status IS DISTINCT FROM NEW.license_status)
  EXECUTE FUNCTION public.set_org_member_deactivated_at();

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
-- THIS ONE HELPER FRONTS BOTH POLICIES -- the broker/admin SELECT and the
-- broker/admin INSERT -- so the term lands on the read and the write together.
-- That is the fit, not a compromise: the ruling covers reading and writing,
-- and splitting the helper would mean writing the same rule twice and letting
-- the copies drift.
--
-- THE SUBJECT OF THE AGREEMENT IS JUDGED BY DATE, NOT BY STATUS TODAY. The
-- INSERT policy's member-EXISTS -- the clause about the AGENT an agreement is
-- written FOR -- admits an active member, and ALSO admits a deactivated one
-- whose agreement is dated on or before the day they were deactivated. The full
-- spelling and the reasoning are at the policy itself, in section 5.
--
-- WHAT IT STILL REFUSES, and what it no longer does. An agreement dated AFTER
-- the agent left is refused, whatever the broker intends. An agreement dated
-- inside the period they were active is recorded normally -- so the founder's
-- driving case (an agent closes in March, leaves in April, the broker records
-- the agreement in May) works, and the agent's past closings resolve instead of
-- returning zero rows. An earlier revision of this file refused that case; the
-- founder refined the rule on 2026-09-23 after being shown the cost, and this
-- is the refined rule.
--
-- THE LOWER BOUND IS NOT ADDRESSED HERE. Nothing tests effective_from against
-- joined_at, so an agreement may be dated BEFORE the subject joined -- which is
-- what this file already did for an active member, and still does. That is not
-- an oversight and not a decision either way: it is filed as BACKLOG-3522.
--
-- PINNED IN BOTH DIRECTIONS rather than left silent: control C25 asserts that a
-- deactivated subject is admitted inside their active period and refused after
-- it, while a removed subject is refused outright and an active one is admitted;
-- C27 sweeps the boundary on both sides and on the NULL case; C29 holds the
-- status gate shut. Mutants m36, m40, m41 and m42 are the ways this clause can
-- be got wrong that a mutant can express. Before C25 existed, moving this dimension either way reddened nothing at
-- all (measured).
--
-- SECURITY DEFINER so the policy can read organization_members past that table's
-- own row-level security; SET search_path = public so the definer's search path
-- cannot be chosen by the caller.
CREATE OR REPLACE FUNCTION public.can_write_split_agreements(p_org_id uuid)
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
CREATE OR REPLACE FUNCTION public.is_active_split_member(p_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.organization_id = p_org_id
                    AND m.user_id = (SELECT auth.uid())
                    AND m.license_status = 'active');
$fn$;

-- ============================ 4. the read helper ================================
-- SECURITY INVOKER (the default -- stated here because it is load-bearing, not
-- incidental): the helper must see exactly the rows its caller's policies
-- allow. Marked DEFINER it would hand an agent a colleague's split.
CREATE OR REPLACE FUNCTION public.split_agreement_in_force(
  p_organization_id uuid, p_agent_user_id uuid, p_on_date date DEFAULT current_date
) RETURNS SETOF public.agent_split_agreements
LANGUAGE sql STABLE SET search_path = public   -- SECURITY INVOKER on purpose
AS $fn$
  SELECT a.* FROM public.agent_split_agreements a
   WHERE a.organization_id = p_organization_id
     AND a.agent_user_id   = p_agent_user_id
     AND a.effective_from  <= p_on_date
   ORDER BY a.effective_from DESC, a.seq DESC
   LIMIT 1;
$fn$;

-- The default ACL grants EXECUTE on a new function to PUBLIC and to anon
-- explicitly, so each grant below needs its own revoke first.
REVOKE EXECUTE ON FUNCTION public.split_agreement_in_force(uuid, uuid, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.split_agreement_in_force(uuid, uuid, date) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.can_write_split_agreements(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.can_write_split_agreements(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.is_active_split_member(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_active_split_member(uuid) TO authenticated;

-- ============================ 5. RLS and grants =================================
ALTER TABLE public.agent_split_agreements ENABLE ROW LEVEL SECURITY;

-- See header note (a). REVOKE ALL, not a narrower revoke: it is what takes back
-- TRUNCATE, which row-level security never evaluates.
REVOKE ALL ON public.agent_split_agreements FROM anon, authenticated;

GRANT SELECT ON public.agent_split_agreements TO authenticated;
GRANT INSERT (organization_id, agent_user_id, agent_pct, brokerage_pct,
              effective_from, note)
  ON public.agent_split_agreements TO authenticated;
-- set_by and set_at are absent from the column list on purpose: they are the
-- audit pair, and a client that could name them could name someone else.
-- No UPDATE grant, no DELETE grant, no UPDATE/DELETE policy. A grant without a
-- policy is NOT equivalent: it turns the write into a silent zero-row no-op
-- instead of an error. Absence of both is what makes the refusal visible.

-- The broker/admin read. `can_write_split_agreements` is named for the
-- write it gates, and it gates this SELECT too -- an ACTIVE broker or admin of
-- this organization. A deactivated one reads nothing here; controls C23 and C24
-- in supabase/tests/backlog-3503/ hold that shut, and mutant m35 is the rule
-- without its status term.
CREATE POLICY agent_split_agreements_select_writer
  ON public.agent_split_agreements FOR SELECT TO authenticated
  USING (public.can_write_split_agreements(organization_id));

-- Their own rows, and only while they are an active member of the organization
-- that wrote them. See section 3b for what "active" is and why it is spelled
-- `= 'active'`. A bare `agent_user_id = auth.uid()` here would let a removed or
-- deactivated agent keep reading; controls C21 and C22 in
-- supabase/tests/backlog-3503/ hold that shut, and mutant m32 is that bare
-- predicate.
CREATE POLICY agent_split_agreements_select_own
  ON public.agent_split_agreements FOR SELECT TO authenticated
  USING (agent_user_id = (SELECT auth.uid())
         AND public.is_active_split_member(agent_split_agreements.organization_id));

-- The EXISTS clause must compare m.organization_id to the NEW ROW's
-- organization_id. Written unqualified, `organization_id` binds to the
-- organization_members alias and Postgres stores `m.organization_id =
-- m.organization_id` -- vacuously true, and behaviourally invisible today.
-- Hence the table-qualified spelling and control C17's catalog sweep.
--
-- THE SUBJECT CLAUSE. The founder's rule, in his terms: a broker may record an
-- agreement for an agent who has left, as long as its effective date falls
-- inside the period that agent was active; nothing new may be dated after they
-- left. Ruled 2026-09-23, refining the ruling of 2026-09-22; both are recorded
-- in pm_comments on BACKLOG-3503. It sits in the SAME EXISTS as the user_id
-- term, for the reason the write rule gives: one membership row must satisfy the
-- whole test, or a deactivated subject could borrow a colleague's active row.
--
-- Read it as three admissions and one refusal:
--   ACTIVE member                      -> admitted, with no date test at all.
--   SUSPENDED, dated on or before the
--     day they were deactivated        -> admitted. This is the new case.
--   SUSPENDED, dated after that day    -> REFUSED. This is what still holds.
--   REMOVED (no membership row at all) -> refused, by the EXISTS finding
--                                         nothing. No term needed.
--
-- THREE PIECES OF THIS ARE LOAD-BEARING AND LOOK REDUNDANT. Do not simplify any
-- of them away; each has a mutant that proves it is doing work.
--
--   1. `m.license_status = 'suspended'` GATES THE SECOND ARM. Without it the arm
--      reads "any status at all, as long as deactivated_at is set", which admits
--      an 'expired' row -- and any fifth state added to the CHECK later -- that
--      still carries a date from an earlier suspension. Section 2b's trigger
--      leaves the column alone on a move to 'expired' precisely so that row can
--      exist. This is the same fail-closed choice section 3b makes, for the same
--      reason: an exclusion list fails OPEN on a state nobody has thought of.
--      Control C29, mutant m42.
--
--   2. `m.deactivated_at IS NOT NULL` CHANGES NO BEHAVIOUR TODAY, AND IS KEPT
--      ANYWAY. MEASURED, not argued: the mutant with this guard deleted was run
--      against the whole suite and reddened NOTHING, because a NULL makes the
--      comparison NULL, NULL is not TRUE, and the row is refused either way. It
--      is therefore an EQUIVALENT mutant and is not shipped in the harness --
--      an always-green mutant would misreport the suite. The guard stays for two
--      reasons: it states the refusal as the INTENT (a suspended row with no
--      recorded date FAILS CLOSED, deliberately -- it is not a missing guard),
--      and it keeps that refusal if the comparison is ever rewritten in a form
--      where NULL does not propagate. A suspended row can reach that state
--      through a writer that bypasses the trigger -- a plain INSERT at
--      'suspended' fires no BEFORE UPDATE trigger -- or from history predating
--      the column. Because no mutant can pin it, the CI text test does:
--      commission-agreements-3503.test.ts asserts the literal is present.
--      Control C27 exercises the NULL case for its behaviour.
--
--   3. `AT TIME ZONE 'UTC'` PINS THE COMPARISON. deactivated_at is timestamptz
--      and effective_from is date, so one of them must be converted, and both
--      `deactivated_at::date` and promoting the date to timestamptz resolve
--      against the SESSION TimeZone -- a property of the connection, not of this
--      rule. Production happens to run UTC everywhere today (pg_db_role_setting
--      carries no TimeZone for anon, authenticated, authenticator or postgres),
--      so all three spellings agree by coincidence of configuration rather than
--      by construction. Pinned, the answer is the same on any connection.
--      Mutant m40.
--      DIRECTION OF THE OFF-BY-ONE, since there is one either way: a
--      deactivation at 18:00 Pacific is 01:00 the NEXT day in UTC, so it lands
--      on the later date and the rule is one day MORE generous. That is the safe
--      side here -- refusing a genuine March agreement is the harm this rule was
--      changed to prevent; admitting one dated the day they left is not.
--
-- The boundary is INCLUSIVE: an agreement dated the day of deactivation is
-- inside the period. Control C27 sweeps both sides of it and the NULL case
-- rather than sampling; mutant m41 is `<` in place of `<=`.
CREATE POLICY agent_split_agreements_insert_writer
  ON public.agent_split_agreements FOR INSERT TO authenticated
  WITH CHECK (public.can_write_split_agreements(agent_split_agreements.organization_id)
              AND EXISTS (SELECT 1 FROM public.organization_members m
                           WHERE m.organization_id = agent_split_agreements.organization_id
                             AND m.user_id = agent_split_agreements.agent_user_id
                             AND (m.license_status = 'active'
                                  OR (m.license_status = 'suspended'
                                      AND m.deactivated_at IS NOT NULL
                                      AND agent_split_agreements.effective_from
                                            <= (m.deactivated_at AT TIME ZONE 'UTC')::date))));
