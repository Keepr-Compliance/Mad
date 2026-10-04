-- C5b: the same attachment declared twice: ok, attachment_count counts distinct ids
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((r->>'ok')::boolean, 'C5b ' || r::text)
  FROM (SELECT public.finalize_submission(:'S', pg_temp.mf() || jsonb_build_object('attachments',
          (pg_temp.mf()->'attachments') || (pg_temp.mf()->'attachments'))) r) x;
RESET ROLE;
SELECT pg_temp.ok(attachment_count = 1, 'C5b attachment_count=' || attachment_count) FROM public.transaction_submissions WHERE id = :'S';
