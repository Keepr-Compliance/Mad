-- K1: checklist header insert while uploading still works
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
INSERT INTO public.submission_checklists (submission_id, template_name) VALUES (:'S', 'c');
RESET ROLE;
SELECT pg_temp.ok((SELECT count(*) FROM public.submission_checklists WHERE submission_id = :'S') = 3, 'K1');
