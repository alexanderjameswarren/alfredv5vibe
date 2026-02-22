-- Migration: Add get_schema_info function for MCP schema introspection
-- This function allows the MCP tool to query database schema information
-- including columns, indexes, constraints, and RLS policies

CREATE OR REPLACE FUNCTION public.get_schema_info(target_table text DEFAULT '')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_object_agg(
    t.table_name,
    jsonb_build_object(
      'columns', (
        SELECT jsonb_agg(
          jsonb_build_object(
            'name', c.column_name,
            'type', c.udt_name,
            'nullable', c.is_nullable = 'YES',
            'default', c.column_default
          )
          ORDER BY c.ordinal_position
        )
        FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = t.table_name
      ),
      'indexes', (
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'name', pi.indexname,
            'definition', pi.indexdef
          )
        ), '[]'::jsonb)
        FROM pg_indexes pi
        WHERE pi.schemaname = 'public'
          AND pi.tablename = t.table_name
      ),
      'constraints', (
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'name', tc.constraint_name,
            'type', tc.constraint_type
          )
        ), '[]'::jsonb)
        FROM information_schema.table_constraints tc
        WHERE tc.table_schema = 'public'
          AND tc.table_name = t.table_name
      ),
      'rls_policies', (
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'name', pp.policyname,
            'command', pp.cmd,
            'using', pp.qual,
            'with_check', pp.with_check
          )
        ), '[]'::jsonb)
        FROM pg_policies pp
        WHERE pp.schemaname = 'public'
          AND pp.tablename = t.table_name
      )
    )
  ) INTO result
  FROM information_schema.tables t
  WHERE t.table_schema = 'public'
    AND t.table_type = 'BASE TABLE'
    AND (target_table = '' OR t.table_name = target_table);

  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;
