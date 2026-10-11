import { supabase } from "../supabaseClient";

/** public.apps, read-only reference data (migration 116), ordered by name. */
export async function listApps() {
  const { data, error } = await supabase
    .from("apps")
    .select("id, name, description, icon, path, button_name")
    .order("name", { ascending: true });
  if (error) throw new Error(`Failed to read apps: ${error.message}`);
  return data || [];
}

export function findApp(apps, id) {
  if (!id) return null;
  return (apps || []).find((a) => a.id === id) || null;
}
