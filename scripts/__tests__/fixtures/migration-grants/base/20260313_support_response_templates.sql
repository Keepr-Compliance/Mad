-- Support Response Templates
-- Allows supervisors to create reusable response templates with dynamic variables.
-- Variables: {{customer_name}}, {{ticket_number}}, {{agent_name}}

CREATE TABLE IF NOT EXISTS support_response_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT DEFAULT NULL,
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES auth.users(id),
  updated_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_templates_active
  ON support_response_templates(is_active) WHERE is_active = true;

ALTER TABLE support_response_templates ENABLE ROW LEVEL SECURITY;

-- Read: any authenticated internal user
CREATE POLICY "support_templates_select" ON support_response_templates
  FOR SELECT TO authenticated USING (true);

-- Write: users with support.manage or support.admin permission
CREATE POLICY "support_templates_manage" ON support_response_templates
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM internal_roles ir
      JOIN admin_role_permissions arp ON arp.role_id = ir.role_id
      JOIN admin_permissions ap ON ap.id = arp.permission_id
      WHERE ir.user_id = auth.uid()
      AND ap.key IN ('support.manage', 'support.admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM internal_roles ir
      JOIN admin_role_permissions arp ON arp.role_id = ir.role_id
      JOIN admin_permissions ap ON ap.id = arp.permission_id
      WHERE ir.user_id = auth.uid()
      AND ap.key IN ('support.manage', 'support.admin')
    )
  );

-- RPCs

CREATE OR REPLACE FUNCTION support_list_templates()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', t.id, 'name', t.name, 'body', t.body, 'category', t.category,
        'is_active', t.is_active, 'created_by', t.created_by,
        'created_at', t.created_at, 'updated_at', t.updated_at
      ) ORDER BY t.name
    )
    FROM support_response_templates t WHERE t.is_active = true
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION support_list_all_templates()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', t.id, 'name', t.name, 'body', t.body, 'category', t.category,
        'is_active', t.is_active, 'created_by', t.created_by,
        'created_at', t.created_at, 'updated_at', t.updated_at
      ) ORDER BY t.name
    )
    FROM support_response_templates t
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION support_create_template(
  p_name TEXT, p_body TEXT, p_category TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id UUID;
BEGIN
  INSERT INTO support_response_templates (name, body, category, created_by, updated_by)
  VALUES (p_name, p_body, p_category, auth.uid(), auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'name', p_name);
END;
$$;

CREATE OR REPLACE FUNCTION support_update_template(
  p_id UUID, p_name TEXT, p_body TEXT,
  p_category TEXT DEFAULT NULL, p_is_active BOOLEAN DEFAULT true
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE support_response_templates
  SET name = p_name, body = p_body, category = p_category,
      is_active = p_is_active, updated_by = auth.uid(), updated_at = now()
  WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'updated', true);
END;
$$;

CREATE OR REPLACE FUNCTION support_delete_template(p_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM support_response_templates WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'deleted', true);
END;
$$;
