import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

/**
 * Create a Supabase client with service role key (bypasses RLS).
 * Used by server-to-server functions (wb-sync, email-capture, clip-capture).
 */
export function createServiceClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(supabaseUrl, serviceRoleKey);
}
