// Test loader for tools that read through the shared readTable (MCP read access).
//
// Copies _shared/ into a temp folder with the REAL platform.ts and
// platform-read.ts. Only two things change in the copy: platform.ts's jsr:
// imports are dropped (nothing a handler test reaches calls them), and
// defineTool returns its options, so a test calls `tool.handler(args, { db })`.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHARED = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function loadTool(toolFile) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-tools-"));
  cpSync(SHARED, join(dir, "_shared"), { recursive: true, filter: (src) => !src.endsWith(".test.mjs") });
  const p = join(dir, "_shared", "platform.ts");
  const src = readFileSync(p, "utf-8").split("\n").filter((l) => !/^import .*"jsr:/.test(l)).join("\n");
  if (!src.includes("export function defineTool<")) throw new Error("platform.ts defineTool changed — update test-platform.mjs.");
  writeFileSync(p, src.replace("export function defineTool<", "function realDefineTool<") +
    "\nexport const defineTool = (o) => o;\n");
  return await import(pathToFileURL(join(dir, "_shared", "tools", toolFile)).href);
}

/** Read settings as public.platform_read_settings() returns them, for a fake rpc. */
export function settingsFor(table, columns, extra = {}) {
  const names = new Set(columns);
  return {
    table,
    columns: columns.map((name) => ({ name, type: "text" })),
    secret_columns: [],
    heavy_columns: [],
    has_context_id: names.has("context_id"),
    has_archived: names.has("archived"),
    has_status: names.has("status"),
    ...extra,
  };
}

/** Wraps a fake db so rpc("platform_read_settings") answers from `settings`; other rpc calls pass through. */
export function withSettings(db, settings) {
  const rpc = db.rpc?.bind(db);
  db.rpc = (name, params) => {
    if (name === "platform_read_settings") {
      const list = params?.p_table ? settings.filter((s) => s.table === params.p_table) : settings;
      return Promise.resolve({ data: list, error: null });
    }
    return rpc ? rpc(name, params) : Promise.resolve({ data: null, error: null });
  };
  return db;
}

/** Read settings for the Warren Buffet tables the list tools read (columns as live, 2026-10-23). */
export const WB_SETTINGS = [
  settingsFor("wb_merchants", ["id", "user_id", "context_id", "name", "match_patterns", "default_kind", "notes",
    "created_at", "updated_at", "not_subscription"]),
  settingsFor("wb_rules", ["id", "user_id", "context_id", "name", "priority", "active", "match", "set_kind",
    "set_merchant_id", "add_tag_ids", "created_by", "hit_count", "last_hit_at", "notes", "created_at", "updated_at",
    "created_from_transaction_id", "set_project_id"]),
  settingsFor("wb_projects", ["id", "user_id", "context_id", "name", "status", "budget", "starts_on", "ends_on", "notes",
    "created_at", "updated_at"]),
  settingsFor("wb_planned_items", ["id", "user_id", "context_id", "project_id", "name", "counterparty", "merchant_id",
    "amount", "due_on", "interval_count", "interval_unit", "ends_on", "stage", "is_draft", "tax_year",
    "amount_tolerance", "match_window_days", "notes", "created_at", "updated_at"]),
  settingsFor("wb_holding_snapshots", ["id", "user_id", "context_id", "account_id", "as_of", "external_id", "symbol",
    "description", "shares", "market_value", "cost_basis", "purchase_price", "currency", "created_at"]),
];

/** True when the fake db saw `.range(from, to)` on `table`. */
export const sawRange = (calls, table, from, to) =>
  calls.some(([t, k, a, b]) => t === table && k === "range" && a === from && b === to);
