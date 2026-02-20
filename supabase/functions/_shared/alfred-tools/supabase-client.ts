import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

/**
 * Create a Supabase client that acts on behalf of an authenticated user.
 * Pass the user's access token so RLS policies are enforced.
 */
export function createUserClient(accessToken?: string): SupabaseClient {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const options: Record<string, unknown> = {};
  if (accessToken) {
    options.global = {
      headers: { Authorization: `Bearer ${accessToken}` },
    };
  }

  return createClient(supabaseUrl, supabaseAnonKey, options);
}

/**
 * Create a Supabase client with service role key (bypasses RLS).
 * Used by ai-enrich for internal operations.
 */
export function createServiceClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(supabaseUrl, serviceRoleKey);
}
