// ============================================================================
// supabase/functions/_shared/tools/warren-buffet-p4.ts
//
// Warren Buffet Phase 4 tools. Spec: docs/technical-spec-warren_buffet_p4-r6d.md P4-D10.
//
//   set_wb_order_item_tags  tier 2 — an item's Category tag: by ids, by ASIN, or every untagged item of one site
//   split_wb_order_charges  tier 2 — split matched Amazon charges by their items' categories; safe to rerun
//
// No real amounts in this file.
// ============================================================================

import { defineTool } from "../platform.ts";
import { absent, oneOf, optText } from "./warren-buffet.ts";
import { dbError, HAND_SOURCES, idList, uuidOf } from "./warren-buffet-p2.ts";
import { ORDER_SITES } from "./warren-buffet-p3.ts";

type Obj = Record<string, unknown>;

export const MAX_ORDER_ITEM_IDS = 100;
export const MAX_ORDER_CHARGE_IDS = 50;

export const setWbOrderItemTagsTool = defineTool({
  name: "set_wb_order_item_tags",
  tables: { reads: ["wb_tags", "wb_tag_groups"], writes: ["wb_order_items"] },
  tier: 2,
  handler: async (args: Obj, ctx) => {
    const T = "set_wb_order_item_tags";
    const tagId = uuidOf(T, "tag_id", args.tag_id);
    const source = oneOf(T, "source", args.source, HAND_SOURCES) ?? "claude";
    const itemIds = absent(args.item_ids) ? null : idList(T, "item_ids", args.item_ids, MAX_ORDER_ITEM_IDS);
    const asin = optText(T, "asin", args.asin);
    const site = oneOf(T, "untagged_site", args.untagged_site, ORDER_SITES);
    if ([itemIds, asin, site].filter((x) => x !== null).length !== 1) {
      throw new Error(`${T}: pass exactly one of item_ids, asin or untagged_site. Nothing was changed.`);
    }
    const { data, error } = await ctx.db.rpc("wb_set_order_item_tags", {
      p_tag_id: tagId, p_item_ids: itemIds, p_asin: asin, p_site: site, p_source: source,
    });
    if (error) throw new Error(dbError(T, error));
    return data;
  },
});

export const splitWbOrderChargesTool = defineTool({
  name: "split_wb_order_charges",
  tables: {
    reads: ["wb_order_matches", "wb_orders", "wb_order_items", "wb_transactions", "wb_splits", "wb_split_tags", "wb_tags", "wb_tag_groups", "wb_planned_matches"],
    writes: ["wb_order_matches", "wb_splits", "wb_split_tags"],
  },
  tier: 2,
  handler: async (args: Obj, ctx) => {
    const T = "split_wb_order_charges";
    const ids = absent(args.transaction_ids) ? null : idList(T, "transaction_ids", args.transaction_ids, MAX_ORDER_CHARGE_IDS);
    const { data, error } = await ctx.db.rpc("wb_split_order_charges", { p_transaction_ids: ids });
    if (error) throw new Error(dbError(T, error));
    return data;
  },
});
