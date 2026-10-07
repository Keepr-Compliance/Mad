-- L1: finalize locks the submission row for the rest of the transaction, even when it refuses (S2: no child rows, so no FK key-share lock on it)
SELECT pg_temp.ok((SELECT xmax::text FROM public.transaction_submissions WHERE id = :'S2') = '0', 'L1 not locked before');
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((r->>'code') = 'incomplete', 'L1 refused ' || r::text)
  FROM (SELECT public.finalize_submission(:'S2', jsonb_build_object('message_ids', jsonb_build_array(:'M1'::text), 'attachments', '[]'::jsonb, 'checklists', null)) r) x;
RESET ROLE;
SELECT pg_temp.ok((SELECT xmax::text FROM public.transaction_submissions WHERE id = :'S2') = pg_current_xact_id()::text, 'L1 row locked by this transaction');
