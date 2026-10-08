import { supabase } from "../supabaseClient";
import { RUN_ACTIVE_MOVE_REASON } from "./status";

export { RUN_ACTIVE_MOVE_REASON };

/** Asks the database at the moment of the write, so a stale screen cannot slip past. */
export async function assertNoActiveRun(eventId) {
  const { data, error } = await supabase
    .from("executions")
    .select("id")
    .eq("event_id", eventId)
    .eq("status", "active")
    .limit(1);
  if (error) throw new Error("Could not check for a running execution.");
  if (data?.length) throw new Error(RUN_ACTIVE_MOVE_REASON);
}
