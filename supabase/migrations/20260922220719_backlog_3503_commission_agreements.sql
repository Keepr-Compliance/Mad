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
--   can_write_commission_agreements(uuid)   RLS helper, SECURITY DEFINER
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
--     percentage-based franchise fee would need a new column.
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
-- SECURITY DEFINER so the policy can read organization_members past that table's
-- own row-level security; SET search_path = public so the definer's search path
-- cannot be chosen by the caller.
CREATE OR REPLACE FUNCTION public.can_write_commission_agreements(p_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.organization_id = p_org_id
                    AND m.user_id = (SELECT auth.uid())
                    AND m.role IN ('broker', 'admin'));
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

CREATE POLICY agent_commission_agreements_select_writer
  ON public.agent_commission_agreements FOR SELECT TO authenticated
  USING (public.can_write_commission_agreements(organization_id));

-- No membership term on purpose: an agent removed from a brokerage keeps the
-- record of what that brokerage paid them. Their own rows only.
CREATE POLICY agent_commission_agreements_select_own
  ON public.agent_commission_agreements FOR SELECT TO authenticated
  USING (agent_user_id = (SELECT auth.uid()));

-- The EXISTS clause must compare m.organization_id to the NEW ROW's
-- organization_id. Written unqualified, `organization_id` binds to the
-- organization_members alias and Postgres stores `m.organization_id =
-- m.organization_id` -- vacuously true, and behaviourally invisible today.
-- Hence the table-qualified spelling and control C17's catalog sweep.
CREATE POLICY agent_commission_agreements_insert_writer
  ON public.agent_commission_agreements FOR INSERT TO authenticated
  WITH CHECK (public.can_write_commission_agreements(agent_commission_agreements.organization_id)
              AND EXISTS (SELECT 1 FROM public.organization_members m
                           WHERE m.organization_id = agent_commission_agreements.organization_id
                             AND m.user_id = agent_commission_agreements.agent_user_id));

-- No own-row SELECT policy here: an agent does not read the office's franchise
-- fee in M1. Adding a policy later is pure addition; revoking one agents have
-- already used is a regression.
CREATE POLICY organization_franchise_fees_select_writer
  ON public.organization_franchise_fees FOR SELECT TO authenticated
  USING (public.can_write_commission_agreements(organization_id));

CREATE POLICY organization_franchise_fees_insert_writer
  ON public.organization_franchise_fees FOR INSERT TO authenticated
  WITH CHECK (public.can_write_commission_agreements(organization_franchise_fees.organization_id));
