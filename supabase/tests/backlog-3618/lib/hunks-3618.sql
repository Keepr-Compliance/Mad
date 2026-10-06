-- BACKLOG-3618: the exact text gen inserted into each copied body (control e12).
-- Generated with the migration; edit both together.
SELECT set_config('t3618.add_hunk', '
     AND (t.owner_user_id IS NULL
          OR EXISTS (SELECT 1 FROM public.submission_checklists h0
                      WHERE h0.submission_id = p_submission_id AND h0.template_id = t.id))', true) IS NOT NULL AS add_hunk_ready;
SELECT set_config('t3618.snap_hunk', '
    -- BACKLOG-3618: the caller''s own template, set not to be sent.
    IF EXISTS (SELECT 1 FROM public.checklist_templates t
                WHERE t.id = NULLIF(c ->> ''template_id'', '''')::uuid
                  AND t.owner_user_id = (SELECT auth.uid())
                  AND NOT t.include_in_submission) THEN
      CONTINUE;
    END IF;
', true) IS NOT NULL AS snap_hunk_ready;
