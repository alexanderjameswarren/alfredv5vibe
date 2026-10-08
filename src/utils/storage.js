import { supabase } from "../supabaseClient";
import { toCamelCase, toSnakeCase } from "./caseConvert";

// Status on items and intents is moved by database triggers (088) as well as by
// hand, so a whole-record UPDATE from stale browser state must not carry it.
// It is still sent on INSERT; storage.patch is how it changes afterwards.
const STATUS_TABLES = new Set(["items", "intents"]);
export function withoutStatus(table, dbValue) {
  if (!STATUS_TABLES.has(table)) return dbValue;
  const { status, status_changed_at, ...rest } = dbValue;
  return rest;
}

/**
 * An Error to throw after `storage.set` returned false, inside withLoading so the
 * user sees it. The two named unique violations are the one-live-event and
 * one-open-execution indexes (Restructure P1).
 */
export function writeError(what) {
  const e = storage.lastError;
  if (e?.code === "23505" && /events_one_live_per_intent/.test(e.message || "")) {
    return new Error(`${what}: this intention already has a live event. Reschedule or archive it first.`);
  }
  if (e?.code === "23505" && /executions_one_open_per_intent/.test(e.message || "")) {
    return new Error(`${what}: this intention already has an open execution. Continue or finish it first.`);
  }
  return new Error(`${what} was not saved.`);
}

export const storage = {
  // Map key prefixes to table names
  tableMap: {
    context: "contexts",
    item: "items",
    intent: "intents",
    event: "events",
    execution: "executions",
    inbox: "inbox",
    item_collections: "item_collections",
  },

  // Key-case conversion between camelCase React state and snake_case Postgres.
  // The implementation lives in utils/caseConvert.js so that this file and the
  // collection membership layer share one copy. Kept as storage properties
  // because callers throughout this file go through storage.toCamelCase(...).
  toSnakeCase,
  toCamelCase,

  async get(key, shared = false) {
    try {
      const [prefix, id] = key.split(":");
      const table = this.tableMap[prefix];

      if (!table || !id) {
        console.error("Invalid key format:", key);
        return null;
      }

      const { data, error } = await supabase
        .from(table)
        .select("*")
        .eq("id", id)
        .maybeSingle();

      if (error) {
        if (error.code === "PGRST116") return null; // Not found
        throw error;
      }

      return this.toCamelCase(data);
    } catch (e) {
      console.error("Storage get error:", e);
      return null;
    }
  },

  /**
   * Write a record and return THE ROW AS IT NOW STANDS.
   *
   * Returns the saved record in camelCase on success, or `false` on failure.
   * It never returns `true` any more: a caller that appends the object it built
   * instead of the row that came back will silently miss every column the
   * database assigns, which is the Step 12.3 bug — a new item had no
   * `updatedAt`, so "Last modified" sorted it last and its timestamp line did
   * not render.
   *
   * `false` remains the only falsy result, so `if (!ok)` callers and the
   * `result === false` check in `wrote` are unaffected. If the database returns
   * no row (it should not), the value that was written is returned instead, so
   * the result is always safe to put straight into state.
   *
   * DO NOT stamp `updatedAt` client-side to avoid needing this. The
   * `set_updated_at` trigger is the single source of truth; a second writer
   * would have to agree with it and nothing would enforce that.
   */
  async set(key, value, shared = false) {
    try {
      const [prefix, id] = key.split(":");
      const table = this.tableMap[prefix];

      if (!table) {
        console.error("Invalid key prefix:", prefix);
        return false;
      }

      const dbValue = this.toSnakeCase(value);

      if (id) {
        // Try update first (works for both owned and shared records)
        //
        // `.select()` and not `.select("id")` as of Step 12.3. The database
        // assigns columns we do not send — `updated_at` via the
        // `set_updated_at` BEFORE UPDATE trigger, and on insert the `now()`,
        // array and `false` column defaults. Asking only for the id threw all
        // of that away, so state kept whatever the caller happened to build and
        // disagreed with the row it had just written.
        //
        // The tag array defaults used to be `'[]'::jsonb` and are `'{}'::text[]`
        // now — items and intents since migration 039, inbox since 062. This
        // path never cared which: supabase-js sends a JS array either way and
        // PostgREST coerces it to whatever the destination column is.
        const { data: updated, error: updateError } = await supabase
          .from(table)
          .update(withoutStatus(table, dbValue))
          .eq("id", id)
          .select();

        if (updateError) throw updateError;

        // If update matched no rows, this is a new record — insert
        if (!updated || updated.length === 0) {
          const { data: inserted, error: insertError } = await supabase
            .from(table)
            .insert(dbValue)
            .select()
            .maybeSingle();
          if (insertError) throw insertError;
          return inserted ? this.toCamelCase(inserted) : value;
        }

        return this.toCamelCase(updated[0]);
      } else {
        // No id in key — straight insert
        const { data: inserted, error } = await supabase
          .from(table)
          .insert(dbValue)
          .select()
          .maybeSingle();
        if (error) throw error;
        return inserted ? this.toCamelCase(inserted) : value;
      }
    } catch (e) {
      console.error("Storage set error:", e, "Key:", key, "Value:", value);
      this.lastError = e;
      return false;
    }
  },

  // The error behind the last `false` from set, for callers that must tell the
  // user (see writeError).
  lastError: null,

  /**
   * Update only the named fields and return the row as it now stands, or
   * `false`. The only way status changes on items and intents — see
   * withoutStatus.
   */
  async patch(key, fields) {
    try {
      const [prefix, id] = key.split(":");
      const table = this.tableMap[prefix];
      if (!table || !id) {
        console.error("Invalid key format:", key);
        return false;
      }
      const { data, error } = await supabase
        .from(table)
        .update(this.toSnakeCase(fields))
        .eq("id", id)
        .select()
        .maybeSingle();
      if (error) throw error;
      return data ? this.toCamelCase(data) : false;
    } catch (e) {
      console.error("Storage patch error:", e, "Key:", key, "Fields:", fields);
      return false;
    }
  },

  async list(prefix, shared = false) {
    try {
      const cleanPrefix = prefix.replace(":", "");
      const table = this.tableMap[cleanPrefix];

      if (!table) {
        console.error("Invalid prefix:", prefix);
        return [];
      }

      const { data, error } = await supabase.from(table).select("id");

      if (error) throw error;
      return data ? data.map((row) => `${cleanPrefix}:${row.id}`) : [];
    } catch (e) {
      console.error("Storage list error:", e);
      return [];
    }
  },

  async delete(key, shared = false) {
    try {
      const [prefix, id] = key.split(":");
      const table = this.tableMap[prefix];

      if (!table || !id) {
        console.error("Invalid key format:", key);
        return false;
      }

      const { error } = await supabase.from(table).delete().eq("id", id);

      if (error) throw error;
      return true;
    } catch (e) {
      console.error("Storage delete error:", e);
      return false;
    }
  },
};
